/**
 * `dataflare import <file>`: load a history of events from a file into Dataflare,
 * keeping their timestamps. Reads newline-delimited JSON (one record per line), a
 * JSON array, or CSV, maps each record with a preset for the tool it came from,
 * and sends batches of 1,000 to `POST /api/import`. Records get stable ids, so an
 * interrupted import can simply be run again.
 */

import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { WireEvent } from '@dataflare/core/events';
import {
  csvRecord,
  IMPORT_PRESETS,
  type ImportPreset,
  mapRecord,
  parseCsvLine,
} from '@dataflare/core/import-presets';
import { call, withProject } from '../client.ts';
import { UsageError } from '../config.ts';
import { color, line, ok, printJson } from '../output.ts';

const BATCH = 1000;

export async function importEvents(
  file: string | undefined,
  options: { format?: string; preset?: string; project?: string; json?: boolean; dryRun?: boolean },
  deps: { fetcher?: typeof fetch } = {},
): Promise<void> {
  if (!file) {
    throw new UsageError(
      'Usage: dataflare import <file> [--preset posthog|mixpanel|amplitude|segment|ga4] [--format ndjson|json|csv]',
    );
  }
  try {
    statSync(file);
  } catch {
    throw new UsageError(`Can't read ${file}.`);
  }
  const preset = (options.preset ?? 'raw') as ImportPreset;
  if (!IMPORT_PRESETS.includes(preset)) {
    throw new UsageError(`Unknown preset "${preset}"`, `Presets: ${IMPORT_PRESETS.join(', ')}.`);
  }
  const format =
    options.format ?? (file.endsWith('.csv') ? 'csv' : file.endsWith('.json') ? 'json' : 'ndjson');
  const project = withProject({ project: options.project }).project;
  let batch: WireEvent[] = [];
  let read = 0;
  let skipped = 0;
  let accepted = 0;
  let dropped = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    if (!options.dryRun) {
      const res = await call<{ accepted: number; dropped: number }>(
        'POST',
        '/api/import',
        { project, events: batch },
        { fetcher: deps.fetcher },
      );
      accepted += res.accepted;
      dropped += res.dropped;
    } else accepted += batch.length;
    batch = [];
    if (!options.json)
      process.stderr.write(
        `\r${color.dim(`${read.toLocaleString('en-US')} read, ${accepted.toLocaleString('en-US')} imported`)}`,
      );
  };
  const take = async (record: Record<string, unknown>) => {
    read++;
    const event = await mapRecord(preset, record);
    if (!event) {
      skipped++;
      return;
    }
    batch.push(event);
    if (batch.length >= BATCH) await flush();
  };
  if (format === 'json') {
    const all = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const records = Array.isArray(all) ? all : [all];
    for (const r of records) await take(r as Record<string, unknown>);
  } else {
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let header: string[] | null = null;
    for await (const raw of lines) {
      const text = raw.trim();
      if (!text) continue;
      if (format === 'csv') {
        const cells = parseCsvLine(text);
        if (!header) {
          header = cells.map((h) => h.trim());
          continue;
        }
        await take(csvRecord(header, cells));
      } else {
        try {
          await take(JSON.parse(text) as Record<string, unknown>);
        } catch {
          read++;
          skipped++;
        }
      }
    }
  }
  await flush();
  if (!options.json) process.stderr.write('\n');
  const result = {
    file,
    preset,
    format,
    read,
    imported: accepted,
    skipped,
    dropped,
    dryRun: Boolean(options.dryRun),
  };
  if (options.json) return printJson(result);
  ok(
    `${options.dryRun ? 'Would import' : 'Imported'} ${accepted.toLocaleString('en-US')} events from ${file}`,
  );
  if (skipped || dropped) {
    line(
      color.dim(
        `${skipped.toLocaleString('en-US')} records had no event, time or id the "${preset}" preset could read; ${dropped.toLocaleString('en-US')} were rejected by the Worker.`,
      ),
    );
  }
}

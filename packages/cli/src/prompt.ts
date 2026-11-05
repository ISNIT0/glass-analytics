/**
 * Interactive prompts that fail fast (with the flag to use instead) when stdin
 * is not a terminal — agents run `dataflare init` non-interactively.
 */

import { createInterface } from 'node:readline/promises';
import { UsageError } from './config.ts';

export const interactive = () =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

export async function ask(
  question: string,
  options: { flag: string; secret?: boolean; default?: string },
): Promise<string> {
  if (!interactive()) {
    if (options.default !== undefined) return options.default;
    throw new UsageError(
      `Missing ${options.flag}.`,
      `Pass ${options.flag} (this terminal is not interactive).`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (options.secret) {
    // Mask typed characters.
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(
      rl,
    );
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) =>
      write(s.startsWith(question) ? s : '*');
  }
  const suffix = options.default ? ` (${options.default})` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  rl.close();
  if (options.secret) process.stdout.write('\n');
  return answer || options.default || '';
}

export async function choose<T>(
  question: string,
  items: T[],
  label: (item: T) => string,
  flag: string,
): Promise<T> {
  if (items.length === 1) return items[0]!;
  if (!interactive())
    throw new UsageError(
      `Several options for ${flag}: ${items.map(label).join(', ')}.`,
      `Pass ${flag}.`,
    );
  items.forEach((item, i) => {
    process.stdout.write(`  ${i + 1}. ${label(item)}\n`);
  });
  const answer = Number(await ask(question, { flag, default: '1' }));
  const item = items[answer - 1];
  if (!item) throw new UsageError(`Pick a number from 1 to ${items.length}.`);
  return item;
}

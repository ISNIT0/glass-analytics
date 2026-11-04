/**
 * Terminal output. Plain text with optional colour; `--json` switches every
 * command to machine-readable output for agents and scripts.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

export const color = {
  bold: wrap(1),
  dim: wrap(2),
  green: wrap(32),
  red: wrap(31),
  yellow: wrap(33),
  cyan: wrap(36),
};

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function ok(text: string): void {
  line(`${color.green('✓')} ${text}`);
}

export function skip(text: string): void {
  line(`${color.yellow('–')} ${text}`);
}

export function fail(text: string): void {
  process.stderr.write(`${color.red('✗')} ${text}\n`);
}

export function printJson(value: unknown): void {
  line(JSON.stringify(value, null, 2));
}

/** A simple aligned table. Numeric columns are right-aligned. */
export function table(headers: string[], rows: (string | number)[][]): void {
  const cells = rows.map((r) => r.map((c) => String(c)));
  const widths = headers.map((h, i) =>
    Math.min(60, Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length))),
  );
  const numeric = headers.map(
    (_, i) => rows.length > 0 && rows.every((r) => typeof r[i] === 'number'),
  );
  const fmt = (values: string[]) =>
    values
      .map((v, i) => {
        const text = v.length > widths[i]! ? `${v.slice(0, widths[i]! - 1)}…` : v;
        return numeric[i] ? text.padStart(widths[i]!) : text.padEnd(widths[i]!);
      })
      .join('  ')
      .trimEnd();
  line(color.dim(fmt(headers)));
  for (const r of cells) line(fmt(r));
}

export function n(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

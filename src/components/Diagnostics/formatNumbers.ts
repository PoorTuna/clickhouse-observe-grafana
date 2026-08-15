/** Shared number formatting for the Inspect drawer's Stats tab and action summary card — kept in
 *  one place so a byte count or row count reads identically wherever it's shown. */

export function formatCount(n: unknown): string {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

export function formatBytes(n: unknown): string {
  if (typeof n !== 'number') {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

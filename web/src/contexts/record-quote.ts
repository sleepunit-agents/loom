export function recordQuote(row: Record<string, unknown>): string {
  const format = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(format).join(', ');
    if (value && typeof value === 'object')
      return Object.entries(value)
        .filter(([k, v]) => k !== '__typename' && v != null && v !== '')
        .map(([k, v]) => k + ': ' + format(v))
        .join('\n');
    return String(value ?? '');
  };
  const text = format(row);
  return text.length > 3000 ? text.slice(0, 2999) + '…' : text;
}

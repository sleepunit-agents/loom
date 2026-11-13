/** Preserve platform event time, truncating sub-millisecond precision like the old adapters.
 * A missing Discord timestamp falls back to its snowflake; Slack uses its message ts.
 * Invalid supplied timestamps never silently become receipt time or a fallback.
 */
export function eventTime(platform: 'discord' | 'slack', id: string, at?: string): string | undefined {
  if (at !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return;
    const year = Number(at.slice(0,4)), month = Number(at.slice(5,7)), day = Number(at.slice(8,10));
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate()
      || Number(at.slice(11,13)) > 23 || Number(at.slice(14,16)) > 59 || Number(at.slice(17,19)) > 59) return;
    const milliseconds = Date.parse(at);
    if (!Number.isFinite(milliseconds)) return;
    return new Date(milliseconds).toISOString();
  }
  if (platform === 'slack') {
    const match = /^(\d{1,12})\.(\d{1,9})$/.exec(id);
    if (!match) return;
    return new Date(Number(match[1]) * 1000 + Number(match[2].padEnd(3,'0').slice(0,3))).toISOString();
  }
  if (!/^\d{1,20}$/.test(id)) return;
  const snowflake = BigInt(id);
  if (snowflake <= 0n || snowflake > 0xffffffffffffffffn) return;
  return new Date(Number((snowflake >> 22n) + 1420070400000n)).toISOString();
}

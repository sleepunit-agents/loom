/** An ask's words as compared for "the same thing" (t-2098): case, spacing and Unicode forms aside. */
export function sameAskWords(a: string, b: string): boolean {
  const n = (x: string) => x.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return !!n(a) && n(a) === n(b);
}

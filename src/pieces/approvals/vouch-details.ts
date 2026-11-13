/** Owning card words: reserve each exact identity/deadline before sharing the
 * remaining content budget. Mixed compact/UUID groups need different line caps. */
export interface VouchWords { id: string; due: number; note: string; executable: string }
export function vouchDetails(rows: VouchWords[]): string {
  if (!rows.length) return '';
  const prefixes = rows.map(w=>`${w.id} fires ${new Date(w.due).toISOString()}: `);
  const available = Math.max(0,Math.floor((1000 - prefixes.reduce((n,p)=>n+p.length,0) - rows.length + 1) / rows.length));
  const plain = (words: string) => words.normalize('NFKC').replace(/[\p{C}]/gu, ' ');
  const clip = (words: string, size: number) => words.length <= size ? words : size >= 3 ? words.slice(0, size - 3) + '...' : words.slice(0, size);
  return rows.map((w,index) => {
    const prefix = prefixes[index], executable = plain(w.executable), note = plain(w.note);
    if (!note) return prefix + clip(executable, available);
    const separator = ' | ';
    const contentRoom = Math.max(0, available - separator.length);
    const executableRoom = Math.min(executable.length, Math.ceil(contentRoom * 2 / 3));
    const noteRoom = Math.min(note.length, contentRoom - executableRoom);
    return prefix + clip(note, noteRoom) + separator + clip(executable, Math.max(0, available - noteRoom - separator.length));
  }).join('\n');
}

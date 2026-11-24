/** A person or an agent by a name a person reads: the directory's where the caller has read it, otherwise the id
 * with a capital (as the program itself says an agent's name where it has no other). Never a kind word beside it. */
export function displayName(id: string | null | undefined, names?: Readonly<Record<string, string>>): string {
  if (!id) return '';
  return names && Object.hasOwn(names, id) ? names[id] : id[0].toUpperCase() + id.slice(1);
}

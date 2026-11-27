/** Times for fixtures, said from now so that "12 minutes ago" stays true whenever the gallery is built. */
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
export const ahead = (minutes: number) => ago(-minutes);
/** A calendar day (YYYY-MM-DD) so many days back. */
export const day = (daysAgo: number) => ago(daysAgo * 1440).slice(0, 10);

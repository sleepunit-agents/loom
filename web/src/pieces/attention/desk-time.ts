/** The household's clock and time zone: the selection the desktop bar's clock and every zone-aware date read
 * (data/zone.ts). A string and a type, so a page without the desktop's bar can read the zone too. */
export const deskTimeQuery = 'query DeskTime { deskTime { at timezone } }';
export interface DeskTimeData { deskTime: { at:number;timezone:string } | null }

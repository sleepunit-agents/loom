import { useDataQuery } from '../../data/graphql';
import { deskTimeQuery, type DeskTimeData } from '../attention/bar-system';
/** The household's zone, from the desk's own clock reading (the same request the top bar makes). Comms' times are
 * said in it (time.ts); until it is read, and where it cannot be, they are said in the device's own. */
export function useHouseholdZone(): string | undefined {
  const reading = useDataQuery<DeskTimeData>(deskTimeQuery);
  return reading.status === 'live' ? reading.data?.deskTime?.timezone ?? undefined : undefined;
}

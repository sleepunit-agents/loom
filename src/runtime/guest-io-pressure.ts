import { constants, closeSync, openSync, readSync } from 'node:fs';

export const validGuestId = (id: string) => /^[1-9]\d{0,8}$/.test(id);

/** Linux PSI reports the fraction of time at least one task was stalled on I/O.
 * Keep the kernel's two decimal places as hundredths of one percent. */
export function guestIoHundredths(text: string): number | undefined {
  const some = text.split('\n').filter(line => line.startsWith('some '));
  if (some.length !== 1) return undefined;
  const fields = some[0].split(/ +/).filter(field => field.startsWith('avg60='));
  if (fields.length !== 1) return undefined;
  const match = /^avg60=(\d{1,3})\.(\d{2})$/.exec(fields[0]);
  if (!match) return undefined;
  const value = Number(match[1]) * 100 + Number(match[2]);
  return value <= 10000 ? value : undefined;
}

/** Read a Proxmox container's own cgroup on the reporting host. Unreadable and
 * absent readings must remain unknown so they cannot clear an existing alert. */
export function readGuestIoPressure(guest: string): number | undefined {
  if (!validGuestId(guest)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync('/sys/fs/cgroup/lxc/' + guest + '/io.pressure',
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const buffer = Buffer.alloc(512);
    const size = readSync(fd, buffer);
    if (size < buffer.length) return guestIoHundredths(buffer.toString('ascii', 0, size));
  } catch { /* Guests may disappear between polls. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

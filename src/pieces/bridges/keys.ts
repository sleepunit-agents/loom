/** The stored keys that tie a bridge message to its other records. Each is
 * written in one place and matched in others, so each has one definition here.
 * The formats are data already in households' databases: do not change them. */

/** `bridge_incoming.id`, and the ref a delivered Inbox item carries to it. */
export const incomingId = (connection: string, message: string): string => `bi:${JSON.stringify([connection, message])}`;

/** Reads back the platform message id incomingId wrote for this connection. */
export function parseIncomingId(id: string, connection: string): string | undefined {
  try {
    const fields: unknown = id.startsWith('bi:') ? JSON.parse(id.slice(3)) : null;
    if (Array.isArray(fields) && fields.length === 2 && fields[0] === connection && typeof fields[1] === 'string' && fields[1]) return fields[1];
  } catch { /* not an incoming id */ }
  return undefined;
}

/** `inbox.source_id` of a delivered bridge message. Workspace and channel are
 * part of it because platform message ids are not unique across them. */
export const inboxSourceId = (workspace: string, channel: string, message: string): string => JSON.stringify([workspace, channel, message]);

/** Reads back what inboxSourceId wrote; anything else names no bridge message. */
export function parseInboxSourceId(value: string | null): { workspace: string; channel: string; message: string } | undefined {
  try {
    const fields: unknown = JSON.parse(value ?? 'null');
    if (Array.isArray(fields) && fields.length === 3 && fields.every(field => typeof field === 'string' && field.length > 0)) {
      const [workspace, channel, message] = fields as [string, string, string];
      return { workspace, channel, message };
    }
  } catch { /* not a bridge source id */ }
  return undefined;
}

/** How an outside user is named where no household member stands for them:
 * the `person` of an agent's tier for someone on a platform. A tier is the
 * agent's setting for that outside account and deliberately outlives a person
 * link (docs/accepted-tradeoffs.md, "An outside account is named in three places"). */
export const outsidePersonKey = (platform: 'discord' | 'slack', workspace: string, user: string): string => JSON.stringify([platform, workspace, user]);


/** Reads the exact platform, workspace and account written by outsidePersonKey. */
export function parseOutsidePersonKey(key: string): { platform: 'discord' | 'slack'; workspace: string; user: string } | undefined {
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3) return;
    const [platform, workspace, user] = parts as unknown[];
    if ((platform === 'discord' || platform === 'slack') && typeof workspace === 'string' && workspace && typeof user === 'string' && user)
      return { platform, workspace, user };
  } catch { /* Not an outside account key. */ }
}

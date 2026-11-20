import { encryptHouseholdBundle, type HouseholdBundleInput, type HouseholdBundleBudget } from './backup-bundle.js';
import { captureImportedCookieKey } from './backup-files.js';

export type RegisteredHouseholdBackupInput = Omit<HouseholdBundleInput, 'cookieKey' | 'registeredAgents'> & {
  /** Trusted source owner declares imported-file presence; no probing/fallback.
   * Fresh next homes use absent: their active CSRF key is already in app rows. */
  importedCookieFile: 'present' | 'absent';
};

/** Internal source composition. No source-store opens, discovery, publication,
 * arming, daemon job or public restore. Missing owning Secrets recovery refuses.
 * Registration is checked against the actual filtered app image, after async
 * crypto setup, so a changed registration cannot silently lose an agent.
 * Explicit initialized continuity connections remain borrowed and open. */
export async function encryptRegisteredHouseholdBundle(input: RegisteredHouseholdBackupInput, budget?: HouseholdBundleBudget) {
  let key: Buffer | null = null;
  try {
    if (input.importedCookieFile !== 'present' && input.importedCookieFile !== 'absent') throw Error();
    if (typeof input.secrets?.export !== 'function' || typeof input.secrets.verifyRestore !== 'function') throw Error();
    if (input.importedCookieFile === 'present') key = captureImportedCookieKey(input.home);
    return await encryptHouseholdBundle({ ...input, cookieKey: key, registeredAgents: true }, budget);
  } catch {
    throw new Error('Registered household backup capture failed');
  } finally { key?.fill(0); }
}

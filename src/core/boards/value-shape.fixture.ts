/** The one list of what ./value-shape.ts must take and must refuse, read by its own test, by the server's tests of
 * the two details (bricks/secrets.test.ts, bricks/household.test.ts) and by the page's tests of both forms
 * (web/src/boards/bricks-secrets.test.tsx, bricks-household-token.test.tsx).
 *
 * Every credential here is MADE UP: a known prefix and a body drawn from a fixed seed below, built at run time so no
 * file holds a whole one (a secret scanner would rightly stop it). None is, or was, a real credential. */

/** A fixed stream of characters from `alphabet`: random-looking, the same on every run. */
function made(alphabet: string, length: number, seed: number): string {
  let state = seed, out = '';
  for (let i = 0; i < length; i++) { state = (state * 1103515245 + 12345) % 2147483648; out += alphabet[Math.floor((state / 2147483648) * alphabet.length)]; }
  return out;
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const URLSAFE = ALNUM + '-_', UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', HEX = '0123456789abcdef';

/** A synthetic bearer of loom's own shape, `loom_` and 43. */
export const SYNTHETIC_BEARER = 'loom_' + made(ALNUM, 43, 7);

/** Names that must be ACCEPTED: told to the board as names. Ordinary names, and names that hold a known prefix or a
 * long run the way a name does (in another case, followed by words, digits in one group). */
export const ACCEPTED_NAMES: readonly string[] = [
  'PUMP_TOKEN', 'github-deploy-key', 'ci:runner',
  'GITHUB_PAT_READ_PACKAGES_ORG_ACME', 'AGE-SECRET-KEY-BACKUP', 'sk-region-postgres-backup-bucket',
  'loom_staging_environment_database_password_for_ci', 'productionPostgresReplicaPassword2026',
  'GITHUB_TOKEN_FOR_DEPLOYS_2026', 'stripe-live-webhook-signing-secret',
  'backup/AGE-SECRET-KEY-shed', 'eu-sk-bratislava-backup-storage-key', 'task-runner-pump-station-north',
  'disk-backup-controller-north', 'pump-station-north-2026-11-27-backup', 'synthetic-private-value-7Q',
  'shed.pi', 'art@one', 'ci/runner:2', 'MAIL_KEY', 'sk_live_webhook_signing_secret', 'glpat-ci-runner-for-the-pump-station',
];

/** Synthetic credentials that must be REFUSED, by kind: one of each kind value-shape.ts knows, bare, and the same
 * after a separator inside a longer name, and a random key with no known prefix. */
export const REFUSED_BY_KIND: Readonly<Record<string, string>> = {
  'loom bearer': SYNTHETIC_BEARER,
  'loom body token': 'body_' + made(HEX, 32, 13),
  'GitHub token': 'ghp_' + made(ALNUM, 36, 17),
  'GitHub fine-grained token': 'github_pat_' + made(ALNUM, 22, 19) + '_' + made(ALNUM, 59, 23),
  'Slack token': 'xoxb-' + made('0123456789', 12, 29) + '-' + made('0123456789', 13, 31) + '-' + made(ALNUM, 24, 37),
  'Anthropic or OpenAI key': 'sk-' + 'ant-api03-' + made(URLSAFE, 93, 41) + 'AA',
  'Stripe key': 'sk_' + 'live_' + made(ALNUM, 24, 43),
  'AWS access key id': 'AK' + 'IA' + made(UPPER, 16, 47),
  'GitLab token': 'glpat-' + made(ALNUM, 20, 53),
  'Google API key': 'AI' + 'za' + made(URLSAFE, 35, 59),
  'age secret key': 'AGE-SECRET-KEY-' + '1' + made(UPPER, 58, 61),
  'long run, no known prefix': made(ALNUM, 40, 3),
};
/** Each kind also refused inside a name, after a separator; and the Stripe kinds the list names besides `sk_live_`. */
export const REFUSED_NAMES: readonly string[] = [
  ...Object.values(REFUSED_BY_KIND),
  ...Object.values(REFUSED_BY_KIND).map((value) => 'ci/' + value),
  'deploy.' + REFUSED_BY_KIND['GitHub token'],
  'sk_' + 'test_' + made(ALNUM, 24, 71), 'rk_' + 'live_' + made(ALNUM, 24, 73), 'rk_' + 'test_' + made(ALNUM, 24, 79),
  'gho_' + made(ALNUM, 36, 83), 'xoxp-' + made('0123456789', 12, 89) + '-' + made(ALNUM, 24, 97),
  // A credential whose body holds a second prefix with twenty more after it: the first one still counts.
  'sk-' + 'Ab3dE6' + 'sk-' + 'q'.repeat(20),
];

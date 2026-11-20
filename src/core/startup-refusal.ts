/** A refusal to start whose words are for the operator: `loom serve` prints them. Any other failure
 * is printed as one fixed line, because its message may quote a private file. */
export class StartupRefusal extends Error {}

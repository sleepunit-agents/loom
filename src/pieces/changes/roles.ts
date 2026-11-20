/** Replaceable seams. No old piece executable, token file or legacy store is read. */
/** The daemon's secrets role owns lookup and use; Changes asks only for GitHub read credentials. */
export interface Secrets {
 resolveGitHub(owner: string): Promise<string>;
 withValue<T>(reference: string, use: (token: string) => Promise<T>): Promise<T>;
}
/** Keep resolution and scoped token use together as one replaceable boundary.
 * The small forwarding helper is intentional: callers never handle secret references. */
export async function withGitHub<T>(secrets: Secrets, owner: string, use: (token: string)=>Promise<T>): Promise<T> {
 const reference=await secrets.resolveGitHub(owner);
 return secrets.withValue(reference,use);
}

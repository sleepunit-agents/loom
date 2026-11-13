/** Replaceable seams. No old piece executable, token file or legacy store is read. */
import type { Viewer, Result, Operations } from '../../core/index.js';
import type { Project, Rule } from './model.js';
export interface Projects { list(): Project[] }
/** The daemon's secrets role owns lookup and use; Changes asks only for GitHub read credentials. */
export interface Secrets {
 resolveGitHub(owner: string): Promise<string>;
 withValue<T>(reference: string, use: (token: string) => Promise<T>): Promise<T>;
}
/** Keep the two secrets calls together so tests replace one boundary. */
export async function withGitHub<T>(secrets: Secrets, owner: string, use: (token: string)=>Promise<T>): Promise<T> {
 const reference=await secrets.resolveGitHub(owner);
 return secrets.withValue(reference,use);
}
export interface Approvals {
 rule(viewer: Viewer, agent: string, target: string): Rule | undefined;
 answer(viewer: Viewer, input: {agent: string; target: string; deny: boolean; person?: string; alwaysProject?: string}, operationId: string): Result;
}
export interface Changes {
 forReferences(viewer: Viewer, references: string[]): Result;
}
export function changesRole(operations: Operations): Changes {
 return { forReferences:(viewer,references)=>operations.call('direct',viewer,'changes.references',{references}) };
}

import {personalMemberExists,readPersonalAccount} from '../data/personal-account-read.js';
import { endBrowser, browserRef } from './shared-browser.js';
/** Personal credential metadata and revocation on the shared connection. */
import { createHash } from 'node:crypto';
import { sessionEnds, tokenLive as live } from '../data/authentication.js';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { GraphQLObjectType, GraphQLString, GraphQLBoolean, GraphQLList, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import type { Clock } from '../clock.js';
import { members, tokens, sessions, passkeys } from '../data/schema.js';
import { OperationError, type Operations } from '../operations/index.js';
const ref = (kind: string, id: string) => createHash('sha256').update(kind+':'+id).digest('hex');
export function sharedAccount(db: DataDatabase, clock: Clock) {
  const ownTokens = (member: string) => db.select().from(tokens).where(and(eq(tokens.kind,'owner'),eq(tokens.member,member))).all();
  return {
    read(member: string) {
      const rows = readPersonalAccount(db,member);
      return {member,
        passkeys:rows.passkeys.map(k=>({ref:ref('passkey',k.id),label:k.label,createdAt:k.createdAt,lastUsedAt:k.lastUsedAt,ended:!live(rows.tokens.get(k.token)!,clock.now())})),
        sessions:rows.sessions.map(s=>({ref:browserRef(s.id),device:s.device,issuedAt:s.issuedAt,seenAt:s.seenAt,ended:!live(rows.tokens.get(s.token)!,clock.now())||sessionEnds(s)<=clock.now()})),
      };
    },
    removePasskey(member: string, reference: string) {
      const own = new Set(ownTokens(member).map(t=>t.fingerprint)), key = db.select().from(passkeys).all().find(k=>ref('passkey',k.id)===reference&&own.has(k.token));
      if(!key)throw new OperationError('not-found','Passkey not found');
      // This stops new sign-ins with the passkey. Browsers it already signed in stay signed in until they
      // are revoked or run out: a session does not record which passkey made it, so they cannot be told
      // apart from the member's other passkey sign-ins. A lost passkey needs its browsers revoked as well.
      db.delete(passkeys).where(eq(passkeys.id,key.id)).run();
      return {removed:true as const};
    },
    revokeSession(member: string, reference: string) {
      const own = new Set(ownTokens(member).map(t=>t.fingerprint)), session = db.select().from(sessions).all().find(s=>browserRef(s.id)===reference&&own.has(s.token));
      if(!session)throw new OperationError('not-found','Browser not found');
      endBrowser(db,session.id);
      return {revoked:true as const};
    },
  };
}
export function registerSharedAccount(operations: Operations, db: DataDatabase, service: ReturnType<typeof sharedAccount>) {
  const member = (viewer: Viewer) => viewer.kind==='member'&&!!db.select().from(members).where(eq(members.id,viewer.id)).get();
  const reference=z.object({ref:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
  operations.register({name:'account.removePasskey',write:true,recheckPolicy:true,input:reference,output:z.object({removed:z.literal(true)}),may:member,
    run(ctx,input){const result=service.removePasskey(ctx.viewer.id,input.ref);ctx.changed('account',ctx.viewer.id);return result;}});
  operations.register({name:'account.revokeSession',write:true,recheckPolicy:true,input:reference,output:z.object({revoked:z.literal(true)}),may:member,
    run(ctx,input){const result=service.revokeSession(ctx.viewer.id,input.ref);ctx.changed('core.access',ctx.viewer.id);return result;}});
}
export function sharedAccountFields(db: DataDatabase, clock: Clock, notifications?: (member: string) => {publicKey:string|null;devices:{ref:string;device:string;createdAt:string;seenAt:string}[]}): GraphQLFieldConfigMap<unknown,{viewer:Viewer}> {
  const passkey=new GraphQLObjectType({name:'PersonalPasskey',fields:{ref:{type:GraphQLString},label:{type:GraphQLString},createdAt:{type:GraphQLString},lastUsedAt:{type:GraphQLString},ended:{type:GraphQLBoolean}}});
  const session=new GraphQLObjectType({name:'PersonalBrowser',fields:{ref:{type:GraphQLString},device:{type:GraphQLString},issuedAt:{type:GraphQLString},seenAt:{type:GraphQLString},ended:{type:GraphQLBoolean}}});
  const device=new GraphQLObjectType({name:'PersonalNotificationDevice',fields:{ref:{type:GraphQLString},device:{type:GraphQLString},createdAt:{type:GraphQLString},seenAt:{type:GraphQLString}}});
  const push=new GraphQLObjectType({name:'PersonalNotifications',fields:{publicKey:{type:GraphQLString},devices:{type:new GraphQLList(device)}}});
  const account=new GraphQLObjectType({name:'PersonalAccount',fields:{member:{type:GraphQLString},notifications:{type:push},passkeys:{type:new GraphQLList(passkey)},sessions:{type:new GraphQLList(session)}}});
  const service=sharedAccount(db,clock);
  return {account:{type:account,resolve(_row,_args,{viewer}){return viewer.kind==='member'&&personalMemberExists(db,viewer.id)?{...service.read(viewer.id),notifications:notifications?.(viewer.id)??{publicKey:null,devices:[]}}:null;}}};
}

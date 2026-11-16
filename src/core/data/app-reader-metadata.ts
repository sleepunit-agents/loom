/** Current display capabilities; outside resolvers retain their existing gates. */
import {eq} from 'drizzle-orm';
import type {DataDatabase} from './database.js';
export function readAppMember(db:DataDatabase,id:string){
 return db.query.members.findFirst({columns:{id:true,role:true},where:f=>eq(f.id,id)}).sync();
}
export function readSecretsDefault(db:DataDatabase){
 return db.query.household.findFirst({columns:{secretsDefault:true}}).sync()?.secretsDefault??'ask';
}

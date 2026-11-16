/** Safe household timezone metadata, with the existing empty-house fallback. */
import type {DataDatabase} from './database.js';
export function readHouseholdTimezone(db:DataDatabase){
 return db.query.household.findFirst({columns:{timezone:true}}).sync()?.timezone??'UTC';
}

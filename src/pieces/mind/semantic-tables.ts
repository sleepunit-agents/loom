/** Private command metadata; these tables belong only to declared agent sources. */
import {integer,primaryKey,sqliteTable,text} from 'drizzle-orm/sqlite-core';
const identity=()=>({viewer:text('viewer').notNull(),id:text('id').notNull(),name:text('name').notNull(),inputHash:text('input_hash').notNull(),expires:integer('expires').notNull()});
export const memoryCommandPreparations=sqliteTable('memory_command_preparations',identity(),t=>[primaryKey({columns:[t.viewer,t.id]})]);
export const memoryCommandReceipts=sqliteTable('memory_command_receipts',{...identity(),result:text('result').notNull()},t=>[primaryKey({columns:[t.viewer,t.id]})]);
export const memoryCommandSchema=sqliteTable('memory_command_schema',{number:integer('number').primaryKey(),sql:text('sql').notNull()});

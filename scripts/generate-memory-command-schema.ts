/** Generate private source DDL offline; never opens an existing database. */
import {generateSQLiteDrizzleJson,generateSQLiteMigration} from 'drizzle-kit/api';
import {writeFileSync} from 'node:fs';
import {memoryCommandPreparations,memoryCommandReceipts,memoryCommandSchema} from '../src/pieces/mind/semantic-tables.js';
const empty=await generateSQLiteDrizzleJson({});
const commands=(await generateSQLiteMigration(empty,await generateSQLiteDrizzleJson({memoryCommandPreparations,memoryCommandReceipts}))).join('\n');
const schema=(await generateSQLiteMigration(empty,await generateSQLiteDrizzleJson({memoryCommandSchema}))).join('\n');
writeFileSync('src/pieces/mind/semantic-schema-sql.ts','// Generated from semantic-tables.ts by scripts/generate-memory-command-schema.ts.\nexport const commandSql='+JSON.stringify(commands)+';\nexport const schemaSql='+JSON.stringify(schema)+';\n');

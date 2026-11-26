/** Fresh schema only; never introspects or connects to an existing database. */
import { backlogCheckpointTriggers } from '../src/core/data/backlog-checkpoints.js';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { mkdirSync, writeFileSync } from 'node:fs';
import { referenceStatements } from '../src/core/data/references.js';
import { expireMessageFiles, clockScheduleNameIndex, schema } from '../src/core/data/schema.js';

// The installed household starts with settings that members can read immediately.
const initialRows = ['INSERT INTO box_alert_settings (singleton) VALUES (1);'];
const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema));
mkdirSync('assets/data', { recursive: true });
writeFileSync('assets/data/schema.sql', '-- Generated from src/core/data/schema.ts. Run npm run schema:generate.\n' + [...statements, expireMessageFiles, clockScheduleNameIndex, ...referenceStatements(), ...backlogCheckpointTriggers, ...initialRows].join('\n') + '\n');

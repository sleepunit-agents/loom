/** The command and card tables of an agent's `memories.db`, as they were first shipped. This text is the
 * definition: it is stored in each file when the file is made, and semantic-schema.ts compares it byte for
 * byte against what a file holds before any command may write there. So it is never edited or regenerated;
 * a change to these tables is a second numbered step with its own text. semantic-schema-sql.test.ts pins it. */
export const commandSql="CREATE TABLE `memory_command_preparations` (\n\t`viewer` text NOT NULL,\n\t`id` text NOT NULL,\n\t`name` text NOT NULL,\n\t`input_hash` text NOT NULL,\n\t`expires` integer NOT NULL,\n\tPRIMARY KEY(`viewer`, `id`)\n);\n\nCREATE TABLE `memory_command_receipts` (\n\t`viewer` text NOT NULL,\n\t`id` text NOT NULL,\n\t`name` text NOT NULL,\n\t`input_hash` text NOT NULL,\n\t`expires` integer NOT NULL,\n\t`result` text NOT NULL,\n\tPRIMARY KEY(`viewer`, `id`)\n);\n";
export const schemaSql="CREATE TABLE `memory_command_schema` (\n\t`number` integer PRIMARY KEY NOT NULL,\n\t`sql` text NOT NULL\n);\n";
export const cardSql="CREATE TABLE `memory_card_references` (\n\t`uuid` text PRIMARY KEY NOT NULL,\n\t`kind` text NOT NULL,\n\t`slug` text NOT NULL\n);\n\nCREATE UNIQUE INDEX `memory_card_subject` ON `memory_card_references` (`kind`,`slug`);";
export const cardSchemaSql="CREATE TABLE `memory_card_schema` (\n\t`number` integer PRIMARY KEY NOT NULL,\n\t`sql` text NOT NULL\n);\n";

import { schema } from './001.js';
import { conversationSchema } from './002.js';
import { digestSchema } from './003.js';
import { retentionSchema } from './004.js';
import { importSchema } from './005.js';
import { readMarkSchema } from './006.js';
export const attentionMigrations = [...schema, conversationSchema, digestSchema, retentionSchema, importSchema, readMarkSchema];

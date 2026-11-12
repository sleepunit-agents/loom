/** Declarative operation/CLI metadata. The generic client interprets it; no domain code runs there. */
import type { CliCommand } from '../../core/index.js';
const plain = { goal: 'goal', why: 'why', 'done-when': 'doneWhen', ask: 'ask', 'if-yes': 'ifYes', 'if-no': 'ifNo', answers: 'answers' };
export const taskCommands: CliCommand[] = [
  { name: 'create', write: true, positional: ['title'], flags: { description: 'description', type: 'type', priority: 'priority', parent: 'parent', 'spec-item-ref': 'specItemRef', 'criterion-id': 'criterionId', 'legacy-ref': 'legacyRef', source: 'source', project: 'project', agent: 'agent', ...plain } },
  ...['claim', 'unclaim'].map(name => ({ name, write: true, positional: ['id'] })),
  { name: 'close', write: true, positional: ['id'], flags: { reason: 'reason' } },
  ...['reopen', 'delete'].map(name => ({ name, write: true, positional: ['id'] })),
  { name: 'update', write: true, positional: ['id'], flags: { title: 'set.title', description: 'set.description', priority: 'set.priority', assignee: 'set.assignee', source: 'set.source', project: 'set.project', agent: 'set.agent', ...Object.fromEntries(Object.entries(plain).map(([k,v]) => [k, `set.${v}`])) } },
  { name: 'comment', write: true, positional: ['id', 'text'], flags: { file: 'text@file' } },
  ...['link', 'unlink'].map(name => ({ name, write: true, positional: ['id', 'dependsOn'], flags: { type: 'type' } })),
  { name: 'show', positional: ['id'] },
  { name: 'list', flags: { status: 'status' } },
  { name: 'search', positional: ['q'], flags: { status: 'status' } },
  ...['ready', 'report', 'export'].map(name => ({ name })),
  { name: 'import', write: true, positional: ['payload@file'] },
];

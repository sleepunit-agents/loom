import { z } from 'zod';

const parameter = z.object({
  name: z.string().trim().min(1),
  io_type: z.enum(['file', 'dir', 'text', 'json']),
  required: z.boolean(),
  description: z.string().trim().min(1),
}).strict();
const parameters = z.array(parameter).refine(items => new Set(items.map(item => item.name)).size === items.length);
const contract = z.object({ inputs: parameters, outputs: parameters }).strict();

/** An optional leading fenced JSON block belongs to the role page, alongside its authored brief. */
export function dossier(page: string, role: string, format: 'brief' | 'json') {
  const lines = page.trim().split(/\r?\n/);
  let declared: z.infer<typeof contract> | null = null;
  let brief = page.trim();
  if (lines[0].trimEnd() === '```loom-contract') {
    const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '```');
    if (end === -1) throw Error('Unclosed role contract');
    declared = contract.parse(JSON.parse(lines.slice(1, end).join('\n')));
    brief = lines.slice(end + 1).join('\n').trim();
  }
  if (format === 'json') return JSON.stringify({role, brief, contract: declared});
  const sections = [brief];
  if (declared) {
    for (const [heading, items] of [['Inputs', declared.inputs], ['Outputs', declared.outputs]] as const) {
      sections.push('## ' + heading + '\n\n' + (items.map(item =>
        '- ' + item.name + ' (' + item.io_type + ', ' + (item.required ? 'required' : 'optional') + ') — ' + item.description
      ).join('\n') || 'None declared.'));
    }
  }
  return sections.filter(Boolean).join('\n\n');
}

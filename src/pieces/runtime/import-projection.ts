/** Source-only physical row projection; no destination connection or importer execution. */
import type { readRuntimeImport } from './import-source.js';
export function runtimeImportTables(source: ReturnType<typeof readRuntimeImport>) {
  const tables: Record<string, Record<string,unknown>[]> = {};
  const names = {box:'boxes',job:'jobs',settings:'settings',binding:'bindings'} as const;
  for (const kind of Object.keys(names) as (keyof typeof names)[]) tables[`runtime_${names[kind]}`] = source.expected[kind].map(record=>({id:record.id,record:JSON.stringify(record),changed_at:'createdAt' in record?record.createdAt:0}));
  for (const name of ['inputs','results','deliveries','provenance_sources','owner_requests','job_heartbeats']) tables[`runtime_${name}`] = [];
  // Historical signatures and owner attestations cannot be reissued by an importer.
  // Until source provenance is reconciled, old conversations fail closed.
  tables.runtime_provenance = source.expected.binding.map(binding=>({conversation:binding.id,record:JSON.stringify({agent:binding.agent,history:{owners:[],people:[],owner:false,unknown:true},queue:[]})}));
  tables.runtime_import_meta = [{key:'source-checksum',value:source.checksum},{key:'source-options',value:source.options}];
  tables.runtime_import_sources = Object.entries(source.files).map(([path,content])=>({path,content}));
  tables.runtime_import_documents = source.documents.map(row=>({collection:row.collection,key:row.key,record:JSON.stringify(row)}));
  tables.runtime_import_revisions = source.revisions.map(row=>({id:row.id,record:JSON.stringify(row)}));
  return tables;
}

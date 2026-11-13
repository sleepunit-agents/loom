/** Source-derived rows only; never opens a destination. */
import type { readBridgeImport } from './import-plan.js';
export function bridgeImportTables(source:ReturnType<typeof readBridgeImport>){
  const records=(items:{id:string}[])=>items.map(r=>({id:r.id,record:JSON.stringify(r)}));
  return {bridges_venues:records(source.expected.venues),bridges_routes:records(source.expected.routes),bridges_links:records(source.expected.links),
    bridges_inbox:[],bridges_outbox:[],bridges_conversations:[],bridges_status:[],
    bridges_meta:[{key:'legacy-evidence',value:source.evidence},{key:'source-options',value:source.mapping},{key:'source-checksum',value:source.checksum}]};
}

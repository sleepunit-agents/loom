import { expect, it } from 'vitest';
import { modelCatalog, modelCatalogJson } from './model-catalog.js';
const role = {model:'custom-model',provider:'actual-provider',harness:'configured-runner',series:'independent-series'};
it('keeps all four configured roles explicit and snapshots them',()=>{
 const source=[{...role}],result=modelCatalog(source);source[0].provider='changed';source.push({...role,model:'second'});
 expect(result).toEqual([role]);expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result[0])).toBe(true);
 expect(modelCatalogJson(JSON.stringify([role]))).toEqual([role]);expect(modelCatalog([])).toEqual([]);
});
it('allows a newly configured role without deriving provider or harness from its model name',()=>{
 const added={model:'claude-looking-name',provider:'other-provider',harness:'custom-codex-compatible-runner',series:'another-series'};
 expect(modelCatalog([role,added])).toEqual([role,added]);
});
it.each(['duplicate','conflict','missing-provider','missing-harness','missing-series','extra-secret','blank','padded','nul','linebreak','not-array'] as const)('refuses %s catalog without exposing configured values',mode=>{
 const rows:Record<string,unknown>[]=[{...role}];
 if(mode==='duplicate')rows.push({...role});
 if(mode==='conflict')rows.push({...role,provider:'other',harness:'other-runner'});
 if(mode==='missing-provider')delete rows[0].provider;
 if(mode==='missing-harness')delete rows[0].harness;
 if(mode==='missing-series')delete rows[0].series;
 if(mode==='extra-secret')rows[0].apiKey='PRIVATE CONFIG VALUE';
 if(mode==='blank')rows[0].model='';
 if(mode==='padded')rows[0].provider=' padded ';
 if(mode==='nul')rows[0].harness='bad\0runner';
 if(mode==='linebreak')rows[0].series='bad\nseries';
 expect(()=>modelCatalog(mode==='not-array'?{roles:rows}:rows)).toThrow(/^Invalid model role catalog$/);
});
it.each(['{PRIVATE CONFIG VALUE','x'.repeat(1_048_577)])('refuses malformed or oversized JSON with a fixed diagnostic',value=>{
 expect(()=>modelCatalogJson(value)).toThrow(/^Invalid model role catalog$/);
});

import { it,expect,vi } from 'vitest';
const f=vi.hoisted(()=>({changed:undefined as undefined|((s:any)=>void),stop:vi.fn()}));
vi.mock('../../web/src/data',()=>({recordsSnapshot:()=>({status:'live'}),watchRecords:(_type:string,_scope:unknown,changed:(s:any)=>void)=>{f.changed=changed;return f.stop;}}));
import { watchTasks } from '../../web/src/legacy-work-live';
it('shared task chips use foundation records, project their status, and clear on scope loss',()=>{
  const chip=vi.fn();const stop=watchTasks('csrf',chip,true);
  f.changed!({status:'live',records:[{id:'t-1',title:'Current title',status:'open',assignee:'jonathan'}]});
  expect(chip.mock.lastCall?.[1].get('tasks/task/t-1')).toMatchObject({title:'Current title',refState:{status:'Needs Jonathan',ownerStatus:'Needs you'}});
  f.changed!({status:'denied',records:[]});expect(chip).toHaveBeenLastCalledWith(new Set(),new Map());
  stop();expect(f.stop).toHaveBeenCalledOnce();
});

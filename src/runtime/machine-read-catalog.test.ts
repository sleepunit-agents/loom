import { afterEach, expect, it, vi } from 'vitest';
import { machineReadCommand, parseMachineRead, runMachineRead } from './machine-read-catalog.js';

afterEach(() => vi.restoreAllMocks());

it('refuses unknown kinds, foreign keys, option injection and out-of-budget reads', () => {
  for (const input of [
    {kind:'worker-log',since:1441}, {kind:'cleanup-receipt',path:'/tmp/input'}, null, {kind: 'command'}, {kind: 'disk', path: '/etc'}, {kind:'failed-units'},
    ...['--all', '../other.service', 'unit*.service', 'foo.service\n', '$(id).service'].map(unit => ({kind:'unit-state',scope:'user',unit})),
    ...[{lines:0},{lines:101},{since:1441},{since:'today'},{scope:'remote'}].map(extra => ({kind:'unit-journal',scope:'system',unit:'a.service',...extra})),
  ]) expect(() => parseMachineRead(input)).toThrow();
});

it('binds a journal request to one unit, scope, time window and line budget', () => {
  const cmd = machineReadCommand(parseMachineRead({kind:'unit-journal',scope:'user',unit:'worker@box.service',lines:7,since:5}));
  expect(cmd[0]).toBe('/usr/bin/journalctl');
  expect(cmd).toEqual(expect.arrayContaining(['--user','--user-unit=worker@box.service','--lines=7','--since=5 minutes ago']));
});

const token = 'opaque-worker-credential';

it('runs a fixed catalog command and preserves ordinary journal lines', async () => {
  const execute = vi.fn(async () => ({stdout:'disk check completed'}));
  const result = await runMachineRead({kind:'unit-journal',scope:'system',unit:'disk.service'}, token, execute,[{scope:'system',unit:'disk.service'}]);
  expect(result).toEqual({ok:true,output:'disk check completed'});
  expect(execute).toHaveBeenCalledWith('/usr/bin/journalctl', [
    '--system','--quiet','--no-pager','--output=short-iso','--lines=30','--since=60 minutes ago','--unit=disk.service',
  ],expect.objectContaining({shell:false,signal:expect.any(AbortSignal)}));
});

it('refuses the entire answer for a worker credential, recognizable secret, or oversized output', async () => {
  for (const value of [token, Buffer.from(token).toString('base64'), 'Authorization: Bearer opaque', 'password=private', 'xoxb-examplevalue', 'AGE-SECRET-KEY-example', JSON.stringify(token).replace('opaque', String.raw`\u006fpaque`)]) {
    const result = await runMachineRead({kind:'worker-log'}, token, async () => ({stdout:'line with ' + value}),[{scope:'user',unit:'loom-worker.service'},{scope:'user',unit:'loom-new-worker.service'}]);
    expect(result).toEqual({ok:false, output:'Machine read contains a credential'});
  }
  const long = await runMachineRead({kind:'memory'}, token, async () => ({stdout:'x'.repeat(16385)}));
  expect(long).toEqual({ok:false, output:'Machine read exceeds the output limit'});
});

it('pins ZFS and running container lists to immutable argv', () => {
  expect(machineReadCommand(parseMachineRead({kind:'zpool'}))).toEqual(['/usr/sbin/zpool','status','-x']);
  expect(machineReadCommand(parseMachineRead({kind:'containers'}))).not.toContain('--all');
});

it.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('reads real host memory as the worker user', async () => {
  const result = await runMachineRead({kind:'memory'}, token);
  expect(result.ok).toBe(true);
  expect(result.output).toContain('Mem:');
});

it('refuses execution with effective uid zero', async () => {
  vi.spyOn(process, 'geteuid').mockReturnValue(0);
  expect((await runMachineRead({kind:'uptime'}, token)).ok).toBe(false);
});

it.each([
 [{kind:'unit-state',scope:'system',unit:'example.service'},'/usr/bin/systemctl',['--system','--no-pager','show','--property=Id,LoadState,ActiveState,SubState,Result,NRestarts,ExecMainCode,ExecMainStatus','--','example.service']],
 [{kind:'proxmox-containers'},'/usr/sbin/pct',['list']],
 [{kind:'proxmox-vms'},'/usr/sbin/qm',['list']],
 [{kind:'zfs'},'/usr/sbin/zfs',['list','-H','-o','name,type,used,avail,refer']],
 [{kind:'zpool'},'/usr/sbin/zpool',['status','-x']],
] as const)('dispatches %j with the exact allowed argument vector',async(input,file,argv)=>{
 const fake=vi.fn(async()=>({stdout:'sample'}));
 expect(await runMachineRead(input,token,fake)).toEqual({ok:true,output:'sample'});
 expect(fake).toHaveBeenCalledWith(file,argv,expect.objectContaining({shell:false,cwd:'/'}));
});

it('projects only timestamps and severity unless the operator lists the exact journal',async()=>{
 const execute=vi.fn(async()=>({stdout:JSON.stringify({__REALTIME_TIMESTAMP:'1700000000000000',PRIORITY:'3',MESSAGE:'an unlabelled private value'})}));
 const got=await runMachineRead({kind:'unit-journal',unit:'other.service',scope:'system'},token,execute,[{scope:'user',unit:'other.service'}]);
 expect(got).toEqual({ok:true,output:'2023-11-14T22:13:20.000Z priority 3'});
 expect(execute.mock.calls[0]).toBeDefined();
});

it('reads only the fixed operator-published cleanup journal summary', () => {
  expect(machineReadCommand(parseMachineRead({kind:'cleanup-week-journal'}))).toEqual([
    '/usr/bin/cat','--','/var/lib/loom/machine-facts/cleanup-week-journal.json',
  ]);
});

it('releases only current fixed-shape operator projections', async () => {
  const observedAt = Math.floor(Date.now()/1000);
  const fact = {observedAt, since:observedAt-604800, started:1, finished:0, kept:3, removed:0, wouldRemove:0, reasons:{dirty:3}, runs:[{at:observedAt,event:"start",count:2,apply:false}],removedHeads:[]};
  const read = (row: object) => runMachineRead({kind:'cleanup-receipt'},token,async()=>({stdout:JSON.stringify(row)}));
  expect(await read(fact)).toEqual({ok:true,output:JSON.stringify(fact)});
  for (const bad of [{kept:4},{observedAt:observedAt-901,since:fact.since-901},{since:1},{path:'/private'}])
    expect((await read({...fact,...bad})).ok).toBe(false);
});

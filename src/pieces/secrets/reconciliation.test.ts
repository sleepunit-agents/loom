import {expect,it,vi} from 'vitest';
import {FakeClock} from '../../core/index.js';
import type {Foundation} from '../../core/app.js';
import {startSecretReconciliation} from './reconciliation.js';
it('coalesces a large clock advance into one check, retries after failure and stops on foundation close',async()=>{
  const clock=new FakeClock(),stops:Array<()=>void>=[];
  // Scheduler-only fixture: no database, holder, network, or unrelated piece timers.
  const app={operations:{clock},onClose:(stop:()=>void)=>stops.push(stop)} as Foundation;
  const recovery={close:vi.fn(),reconcilePending:vi.fn(async()=>{throw Error('unavailable');})};
  const job=startSecretReconciliation(app,recovery);
  clock.advance(31*86400_000);await job.idle();expect(recovery.reconcilePending).toHaveBeenCalledTimes(1);
  clock.advance(59_999);await job.idle();expect(recovery.reconcilePending).toHaveBeenCalledTimes(1);
  clock.advance(1);await job.idle();expect(recovery.reconcilePending).toHaveBeenCalledTimes(2);
  for(const close of stops)close();clock.advance(31*86400_000);await job.run();
  expect(recovery.close).toHaveBeenCalledTimes(1);expect(recovery.reconcilePending).toHaveBeenCalledTimes(2);
});

import { expect, it } from 'vitest';
import { covered, exactTarget, vouchOf } from './targets.js';
import { approvalSchema } from './validation.js';

const uuid='w-01234567-89ab-4cde-8fab-0123456789ab';
it('keeps compact ids and UUID ids exact in a sorted unique vouch set',()=>{
  const ids=[uuid,'w-abcdef'];
  const target='art:'+ids.join(',');
  expect(vouchOf(target)).toEqual({agent:'art',ids});
  expect(covered({kind:'vouch-wake',target})).toEqual(ids);
  expect(vouchOf('art:'+ids.toReversed().join(','))).toBeUndefined();
  expect(vouchOf('art:'+uuid+','+uuid)).toBeUndefined();
  expect(vouchOf('art:'+Array.from({length:12},(_,i)=>'w-'+i.toString(16).padStart(6,'0')).join(','))).toBeDefined();
  expect(vouchOf('art:'+Array.from({length:13},(_,i)=>'w-'+i.toString(16).padStart(6,'0')).join(','))).toBeUndefined();
});
it.each([uuid.toUpperCase(),uuid+'a',uuid.slice(0,-1),uuid.replace('4cde','gcde'),'w-1234567','w-12345','w-01234567-89ab4cde-8fab-0123456789ab'])('refuses malformed or noncanonical wake id %s',id=>{
  expect(vouchOf('art:'+id)).toBeUndefined();
});
it('retains the 200-character target bound for UUID batches and stored receipts',()=>{
  const ids=Array.from({length:5},(_,i)=>uuid.slice(0,-1)+i);
  expect(exactTarget('art:'+ids.slice(0,4).join(','))).toHaveLength(159);
  const target='art:'+ids.join(',');
  expect(()=>exactTarget(target)).not.toThrow(); // five UUID ids fit at 198 characters
  const tooLong=target+',w-abcdef';
  expect(()=>exactTarget(tooLong)).toThrow();
  const receipt={id:'a-01234567',kind:'vouch-wake',target,what:'Vouch',why:'Resume',who:{agent:'art',where:'h-1'},for:'owner',minutes:60,at:'2026-11-12T22:00:00Z',state:'pending'};
  expect(approvalSchema.safeParse(receipt).success).toBe(true);
  expect(approvalSchema.safeParse({...receipt,target:tooLong}).success).toBe(false);
});

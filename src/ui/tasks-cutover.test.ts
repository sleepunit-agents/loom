import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUi, legacyUiAuth } from './handler.js';

it('retires Tasks page JSON and redirects old scoped task links without a piece call', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-tasks-route-'));
  try {
    const open = async (path: string, accept = 'application/json') => {
      let status = 0, headers: Record<string, unknown> = {}, body = '';
      const req = { method:'GET', url:path, headers:{authorization:'Bearer fixture',accept,host:'loom.invalid'} };
      const res = { writeHead(code:number,h:Record<string,unknown>){status=code;headers=h;},end(text=''){body=text;} };
      await handleUi(req as any,res as any,new URL(path,'http://loom.invalid').pathname,{
        contextDir:home,auth:legacyUiAuth(['fixture']),env:{LOOM_HOME:home,PATH:''},
      });
      return {status,headers,body};
    };
    for (const path of ['/p/tasks','/p/tasks/task/t-1','/p/tasks/ready?sort=updated']) {
      const result=await open(path);
      expect(result.status).toBe(410);expect(JSON.parse(result.body).code).toBe('not-found');
    }
    const old=await open('/a/art/p/tasks/task/t-1?sort=updated');
    expect(old.status).toBe(303);expect(old.headers.location).toBe('/p/tasks/task/t-1?sort=updated');
    const document=await open('/p/tasks','text/html');
    expect(document.status).toBe(200);expect(document.body).toContain('<html');
  } finally {rmSync(home,{recursive:true,force:true});}
});

/** Next-mode loom token link client. Never retries or prints credentials on failure. */
import { readFile } from 'node:fs/promises';
import type { IOStreams } from '../../cli/io.js';
export async function runSigninLink(argv: string[], io: IOStreams, request: typeof fetch = fetch): Promise<number> {
  const flags: Record<string,string>={};let agent=false;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--next')continue;
    if(argv[i]==='--agent'){agent=true;continue;}
    if(!['--member','--label','--ttl'].includes(argv[i])||!argv[i+1]){io.stderr('usage: loom token link --next --member <person> [--label <name>] [--agent] [--ttl <seconds>]\n');return 2;}
    flags[argv[i].slice(2)]=argv[++i];
  }
  if(!flags.member){io.stderr('A member is required\n');return 2;}
  try{
    const base=new URL(io.env.LOOM_URL ?? 'http://127.0.0.1:8787');
    const token=(await readFile(io.env.LOOM_TOKEN_FILE!,'utf8')).trim();if(!token)throw new Error();
    const res=await request(new URL('/api/signin/link',base),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({input:{member:flags.member,label:flags.label,agent,...(flags.ttl?{ttl:Number(flags.ttl)}:{})}})});
    const answer=await res.json();if(!res.ok||!answer.ok||typeof answer.value?.path!=='string'||!/^\/login\/[0-9a-f]{64}$/.test(answer.value.path))throw new Error();
    io.stdout(new URL(answer.value.path,base).href+'\n');return 0;
  }catch{io.stderr('Could not make a sign-in link\n');return 1;}
}

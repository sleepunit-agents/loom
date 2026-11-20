/** Next-mode loom token link client. Never retries or prints credentials on failure. */
import { readFile } from 'node:fs/promises';
import { requestLocalLink } from './operator.js';
import type { IOStreams } from '../../cli/io.js';
export async function runSigninLink(argv: string[], io: IOStreams, request: typeof fetch = fetch): Promise<number> {
  const flags: Record<string,string>={};let agent=false, local=false;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--next')continue;
    if(argv[i]==='--local'){local=true;continue;}
    if(argv[i]==='--agent'){agent=true;continue;}
    if(!['--member','--label','--ttl','--home','--page-url'].includes(argv[i])||!argv[i+1]){io.stderr('usage: loom token link --next --member <person> [--label <name>] [--agent] [--ttl <seconds>] [--local --home <dir> [--page-url <base>]]\n');return 2;}
    flags[argv[i].slice(2)]=argv[++i];
  }
  if(!flags.member){io.stderr('A member is required\n');return 2;}
  if((local && (!flags.home || agent)) || (!local && (flags.home || flags['page-url']))){io.stderr('Local links require --home and cannot use --agent\n');return 2;}
  try{
    if(local){
      // Validate any explicit base before asking the daemon to create a credential.
      const base=flags['page-url'] ? new URL(flags['page-url']) : undefined;
      if(base && (!['http:','https:'].includes(base.protocol) || base.username || base.password))throw new Error();
      const answer=await requestLocalLink(flags.home,{request:'link',member:flags.member,...(flags.label!==undefined?{label:flags.label}:{}),...(flags.ttl!==undefined?{ttl:Number(flags.ttl)}:{})});
      io.stdout(new URL(answer.path,base ?? answer.url).href+'\n');return 0;
    }
    const base=new URL(io.env.LOOM_URL ?? 'http://127.0.0.1:8787');
    const token=(await readFile(io.env.LOOM_TOKEN_FILE!,'utf8')).trim();if(!token)throw new Error();
    const res=await request(new URL('/api/signin/link',base),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({input:{member:flags.member,label:flags.label,agent,...(flags.ttl?{ttl:Number(flags.ttl)}:{})}})});
    const answer=await res.json();if(!res.ok||!answer.ok||typeof answer.value?.path!=='string'||!/^\/login\/[0-9a-f]{64}$/.test(answer.value.path))throw new Error();
    io.stdout(new URL(answer.value.path,base).href+'\n');return 0;
  }catch{io.stderr('Could not make a sign-in link\n');return 1;}
}

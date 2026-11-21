import { TASK_ID } from '../../slug.js';

/** The v1 mention grammar. Bare repo numbers were relative to the old household's GitHub owner. */
export function legacyCommsRefs(words:string,github?:string):string[] {
  const refs=new Set<string>();
  const mentions = new RegExp(String.raw`\b(${TASK_ID})\b|(?<![\w./-])([\w.-]+\/)?([\w.-]+)#(\d{1,10})\b|(?:^|\s)note:([\w./-]+)`, 'g');
  for(const [,task,owner,repo,number,note] of words.matchAll(mentions)){
    if(task) {
      // The original Comms writer indexed at most nine digits after the prefix.
      if(task.length <= 11) refs.add(task);
    }
    else if(number){
      const namespace=owner?.slice(0,-1)??github;
      if(namespace) refs.add(`github:${namespace}/${repo}#${number}`);
    }else{
      const path=note.replace(/[./]+$/,'');
      if(path && !path.split('/').includes('..')) refs.add('note:'+path);
    }
  }
  return [...refs].filter(ref=>ref.length<=200);
}

/** The index contains canonical IDs, after bare repository names received their household owner. */
export function validLegacyCommsRef(ref: string): boolean {
  if (ref.startsWith('github:')) return /^github:[\w.-]+\/[\w.-]+#\d{1,10}$/.test(ref);
  return legacyCommsRefs(ref)[0] === ref;
}

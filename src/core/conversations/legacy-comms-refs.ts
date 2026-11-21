/** The v1 mention grammar. Bare repo numbers were relative to the old household's GitHub owner. */
export function legacyCommsRefs(words:string,github?:string):string[] {
  const refs=new Set<string>();
  const mentions=/\b(t-\d{1,9})\b|(?<![\w./-])([\w.-]+\/)?([\w.-]+)#(\d{1,10})\b|(?:^|\s)note:([\w./-]+)/g;
  for(const [,task,owner,repo,number,note] of words.matchAll(mentions)){
    if(task) refs.add(task);
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

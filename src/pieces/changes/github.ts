/** The only forge boundary. A fixed query and URL: no caller can supply a mutation or destination. */
import { changeSchema, repoId, active, type Change } from './model.js';
import { withGitHub, type Secrets } from './roles.js';
const fields=`number title url state isDraft createdAt updatedAt closedAt mergedAt author { login ... on User { name } } headRefName headRefOid baseRefName bodyText mergeable reviewDecision
 reviewRequests(first:10){nodes{requestedReviewer{... on User{login name} ... on Team{slug name}}}}
 latestReviews(first:10){nodes{state author{login ... on User{name}}}} assignees(first:5){nodes{login name}} participants(first:15){nodes{login name}}
 commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}`;
const query=`query($owner:String!,$name:String!,$states:[PullRequestState!],$after:String){repository(owner:$owner,name:$name){pullRequests(states:$states,first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${fields}} pageInfo{hasNextPage endCursor}}}}`;
const failed=new Set(['FAILURE','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE','ERROR']);
// GitHub JSON is untrusted; pick normalized fields, then validate at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalize(repo:string,n:any):Change {
 repo=repoId(repo);
 const roll=n.commits?.nodes?.[0]?.commit?.statusCheckRollup;
 const failing:string[]=[],running:string[]=[];
 for(const c of roll?.contexts?.nodes??[]) {
  const name=c.name??c.context??'a check';
  if(c.__typename==='CheckRun') {if(c.status!=='COMPLETED') running.push(name);else if(failed.has(c.conclusion)) failing.push(name);}
  else if(['PENDING','EXPECTED'].includes(c.state)) running.push(name);else if(['FAILURE','ERROR'].includes(c.state)) failing.push(name);
 }
 const checks={state:!roll?'none':failed.has(roll.state)||failing.length?'failing':['PENDING','EXPECTED'].includes(roll.state)||running.length?'running':'passing',failing:failing.slice(0,10),running:running.slice(0,10),total:roll?.contexts?.nodes?.length??0};
 const reviews=n.latestReviews?.nodes??[],people: {login:string;name?:string;role:string}[]=[];
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const person=(p:any,role:string)=>{const login=p?.login??p?.slug;if(login&&!people.some(x=>x.login===login)) people.push({login,...(p.name?{name:p.name}:{}),role});};
 person(n.author,'author');for(const r of reviews) person(r?.author,'reviewer');for(const r of n.reviewRequests?.nodes??[]) person(r?.requestedReviewer,'requested');for(const p of n.assignees?.nodes??[]) person(p,'assignee');for(const p of n.participants?.nodes??[]) person(p,'commenter');
 return changeSchema.parse({id:`${repo}#${n.number}`,repo,number:n.number,page:`c/github/${repo.slice(7)}/${n.number}`,title:(n.title??'').slice(0,300),url:n.url?.startsWith('https://github.com/')?n.url:'',state:{OPEN:'open',MERGED:'merged',CLOSED:'closed'}[n.state as string]??'closed',draft:!!n.isDraft,author:{login:n.author?.login??'ghost',...(n.author?.name?{name:n.author.name}:{})},created:n.createdAt??null,updated:n.updatedAt??null,closed:n.mergedAt??n.closedAt??null,head:{ref:n.headRefName??'',id:(n.headRefOid??'').toLowerCase()},base:{ref:n.baseRefName??''},body:(n.bodyText??'').replaceAll('\r\n','\n').trim().slice(0,12000),checks,review:{state:({APPROVED:'approved',CHANGES_REQUESTED:'changes_requested',REVIEW_REQUIRED:'required'} as Record<string,string>)[n.reviewDecision]??'not_required',by:reviews.filter((r:{state:string})=>r?.state==='APPROVED').map((r:{author?:{name?:string;login:string}})=>r.author?.name??r.author?.login).filter(Boolean).slice(0,8)},mergeable:n.mergeable==='MERGEABLE'?'yes':n.mergeable==='CONFLICTING'?'no':'unknown',conflicts:n.mergeable==='CONFLICTING',people:people.slice(0,20)});
}
export function githubReader(secrets:Secrets, request:typeof fetch=fetch) {
 return async(repo:string,now:number):Promise<Change[]>=>{
  repo=repoId(repo);const [owner,name]=repo.slice(7).split('/');
  try {return await withGitHub(secrets,owner,async token=>{
   if(!token) throw new Error('Missing credential');
   const out:Change[]=[];
   for(const states of [['OPEN'],['MERGED','CLOSED']]) {
    let after:string|null=null;const seen=new Set<string>();
    for(;;) {
     const response=await request('https://api.github.com/graphql',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query,variables:{owner,name,states,after}}),signal:AbortSignal.timeout(20000)});
     if(!response.ok) throw new Error('GitHub read failed');
     // Even an upstream error or malicious PR text cannot smuggle the supplied token into app data.
     const text=(await response.text()).split(token).join('[redacted]').replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g,'[redacted]');
     const data=JSON.parse(text);const page=data.data?.repository?.pullRequests;
     if(data.errors?.length||!page||!Array.isArray(page.nodes)) throw new Error('GitHub read failed');
     const rows=page.nodes.filter(Boolean).map((n:unknown)=>normalize(repo,n));out.push(...rows.filter((c:Change)=>active(c,now)));
     if(!page.pageInfo?.hasNextPage||states[0]!=='OPEN'&&rows.some((c:Change)=>!active(c,now))) break;
     const cursor=page.pageInfo.endCursor;if(typeof cursor!=='string'||seen.has(cursor)) throw new Error('Invalid GitHub pagination');seen.add(cursor);after=cursor;
    }
   }
   return [...new Map(out.map(c=>[c.id,c])).values()];
  });} catch {throw new Error('GitHub read unavailable');} // Never persist/log an upstream exception or credential.
 };
}

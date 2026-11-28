/** The only forge boundary. A fixed query and URL: no caller can supply a mutation or destination. */
import { z } from 'zod';
import { submittedReviewSchema, type SubmittedReview, changeSchema, repoId, active, week, type Change } from './model.js';
import { parseRedactedJSON } from './redact.js';
import { withGitHub, type Secrets } from './roles.js';
const reviewFields = 'id url submittedAt state bodyText author{login} commit{oid}';
const reviewConnection = 'nodes{'+reviewFields+'} pageInfo{hasNextPage endCursor}';
const reviewPageQuery = 'query($owner:String!,$name:String!,$number:Int!,$after:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(first:50,after:$after){'+reviewConnection+'}}}}';
const reviewPage = z.object({
  nodes:z.array(z.object({id:z.string(),url:z.string(),state:z.string(),submittedAt:z.string().nullable(),
    bodyText:z.string(),author:z.object({login:z.string()}).nullable(),commit:z.object({oid:z.string()}).nullable()}).nullable()),
  pageInfo:z.object({hasNextPage:z.boolean(),endCursor:z.string().nullable()}),
});
const fields=`number title url state isDraft createdAt updatedAt closedAt mergedAt author { login ... on User { name } } headRefName headRefOid baseRefName bodyText mergeable reviewDecision
 reviews(first:10){${reviewConnection}}
 files(first:100){nodes{path additions deletions}}
 reviewRequests(first:10){nodes{requestedReviewer{... on User{login name} ... on Team{slug name}}}}
 latestReviews(first:10){nodes{state author{login ... on User{name}}}} assignees(first:5){nodes{login name}} participants(first:15){nodes{login name}}
 commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}`;
const query=`query($owner:String!,$name:String!,$states:[PullRequestState!],$after:String){repository(owner:$owner,name:$name){pullRequests(states:$states,first:20,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${fields}} pageInfo{hasNextPage endCursor}}}}`;
const failed=new Set(['FAILURE','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE','ERROR']);
// GitHub JSON is untrusted; pick normalized fields, then validate at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** The files GitHub lists, each once, with whole non-negative counts; a malformed entry is left out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const files=(connection:any)=>{const out=new Map<string,{path:string;additions:number;deletions:number}>();
 for(const f of Array.isArray(connection?.nodes)?connection.nodes:[]){
  if(typeof f?.path!=='string'||!f.path||f.path.length>1000||![f.additions,f.deletions].every(n=>Number.isInteger(n)&&n>=0))continue;
  out.set(f.path,{path:f.path,additions:f.additions,deletions:f.deletions});
 }
 return [...out.values()].slice(0,100);};
export function normalize(repo:string,n:any):Change {
 repo=repoId(repo);
 if(!n||!['OPEN','MERGED','CLOSED'].includes(n.state)) throw new Error('Invalid GitHub state');
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
 const person=(p:any,role:string)=>{const login=p?.login??p?.slug;if(login&&!people.some(x=>x.login===login && x.role===role)) people.push({login,...(p.name?{name:p.name}:{}),role});};
 person(n.author,'author');for(const r of reviews) person(r?.author,'reviewer');for(const r of n.reviewRequests?.nodes??[]) person(r?.requestedReviewer,'requested');for(const p of n.assignees?.nodes??[]) person(p,'assignee');for(const p of n.participants?.nodes??[]) person(p,'commenter');
 return changeSchema.parse({id:`${repo}#${n.number}`,repo,number:n.number,page:`c/github/${repo.slice(7)}/${n.number}`,title:(n.title??'').slice(0,300),url:n.url?.startsWith('https://github.com/')?n.url:'',state:{OPEN:'open',MERGED:'merged',CLOSED:'closed'}[n.state as string],draft:!!n.isDraft,author:{login:n.author?.login??'ghost',...(n.author?.name?{name:n.author.name}:{})},created:n.createdAt??null,updated:n.updatedAt??null,closed:n.mergedAt??n.closedAt??null,head:{ref:n.headRefName??'',id:(n.headRefOid??'').toLowerCase()},base:{ref:n.baseRefName??''},body:(n.bodyText??'').replaceAll('\r\n','\n').trim().slice(0,12000),checks,review:{state:({APPROVED:'approved',CHANGES_REQUESTED:'changes_requested',REVIEW_REQUIRED:'required'} as Record<string,string>)[n.reviewDecision]??'not_required',by:reviews.filter((r:{state:string})=>r?.state==='APPROVED').map((r:{author?:{name?:string;login:string}})=>r.author?.name??r.author?.login).filter(Boolean).slice(0,8)},mergeable:n.mergeable==='MERGEABLE'?'yes':n.mergeable==='CONFLICTING'?'no':'unknown',conflicts:n.mergeable==='CONFLICTING',people:people.slice(0,20),...(n.files?{files:files(n.files)}:{})});
}
export function githubReader(secrets:Secrets, request:typeof fetch=fetch) {
 return async(repo:string,now:number):Promise<Change[]>=>{
  repo=repoId(repo);const [owner,name]=repo.slice(7).split('/');
  try {return await withGitHub(secrets,owner,async token=>{
   if(!token) throw new Error('Missing credential');
   async function read(document:string,variables:Record<string,unknown>) {
    const response=await request('https://api.github.com/graphql',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query:document,variables}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('GitHub read failed');
    const result=parseRedactedJSON(await response.text(),token!) as {data?:{repository?:{pullRequests?:{nodes:unknown[];pageInfo?:{hasNextPage?:unknown;endCursor?:unknown}},pullRequest?:{reviews?:unknown}}};errors?:unknown[]};
    if(result.errors?.length||!result.data?.repository)throw new Error('GitHub read failed');
    return result.data.repository;
   }
   async function reviewsFor(change:Change,first:unknown) {
    const reviews=new Map<string,SubmittedReview>(), cursors=new Set<string>();
    let page=reviewPage.parse(first);
    for(;;){
     for(const review of page.nodes){
      if(!review || review.state==='PENDING') continue;
      if(!review.submittedAt)throw new Error('Missing review submission time');
      const url=new URL(review.url);
      if(url.origin!=='https://github.com'||url.pathname.toLowerCase()!=='/'+owner+'/'+name+'/pull/'+change.number||!/^#pullrequestreview-\d+$/.test(url.hash))throw new Error('Invalid review source');
      reviews.set(review.id,submittedReviewSchema.parse({id:review.id,login:review.author?.login??null,state:review.state,submittedAt:new Date(review.submittedAt).toISOString(),headCommit:review.commit?.oid??null,body:review.bodyText,url:url.origin+url.pathname+url.hash}));
     }
     if(!page.pageInfo.hasNextPage)return [...reviews.values()];
     const after=page.pageInfo.endCursor;
     if(!after||cursors.has(after))throw new Error('Invalid review pagination');
     cursors.add(after);
     page=reviewPage.parse((await read(reviewPageQuery,{owner,name,number:change.number,after})).pullRequest?.reviews);
    }
   }
   const out:Change[]=[];
   for(const states of [['OPEN'],['MERGED','CLOSED']]) {
    let after:string|null=null;const seen=new Set<string>();
    for(;;) {
     const page=(await read(query,{owner,name,states,after})).pullRequests;
     if(!page||!Array.isArray(page.nodes))throw new Error('GitHub read failed');
     let pastWindow=false;
     for(const node of page.nodes){
      if(!node)continue;
      const change=normalize(repo,node);
      // GitHub orders by updatedAt. Closing or merging also updates the PR,
      // so after an old update no later page can contain a recent closure.
      if(!states.includes('OPEN') && change.updated && Date.parse(change.updated)<=now-week)pastWindow=true;
      if(!active(change,now))continue;
      const first=(node as {reviews?:unknown}).reviews;
      change.submittedReviews=await reviewsFor(change,first);
      out.push(change);
     }
     const info=page.pageInfo;
     if(!info||typeof info.hasNextPage!=='boolean'||!(info.endCursor===null||typeof info.endCursor==='string')) throw new Error('Invalid GitHub pagination');
     if(!info.hasNextPage || pastWindow) break;
     const cursor:unknown=info.endCursor;if(typeof cursor!=='string'||!cursor||seen.has(cursor)) throw new Error('Invalid GitHub pagination');seen.add(cursor);after=cursor;
    }
   }
   return [...new Map(out.map(c=>[c.id,c])).values()];
  });} catch {throw new Error('GitHub read unavailable');} // Never persist/log an upstream exception or credential.
 };
}

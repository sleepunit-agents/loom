"""Copy promises from the approved pages; never edit those pages."""
import hashlib,json,re
from pathlib import Path
from html.parser import HTMLParser
ROOT=Path(__file__).resolve().parents[1]
class Node:
 def __init__(self,tag='',attrs=(),parent=None): self.tag=tag;self.attrs=dict(attrs);self.parent=parent;self.children=[]
 def text(self): return re.sub(r'\s+',' ',''.join(c if isinstance(c,str) else c.text()+' ' for c in self.children)).strip()
 def cls(self,c): return c in self.attrs.get('class','').split()
 def all(self):
  yield self
  for c in self.children:
   if isinstance(c,Node): yield from c.all()
 def within(self,c): return self.cls(c) or bool(self.parent and self.parent.within(c))
class Parser(HTMLParser):
 def __init__(self): super().__init__();self.root=Node();self.stack=[self.root]
 def handle_starttag(self,tag,attrs):
  n=Node(tag,attrs,self.stack[-1]);self.stack[-1].children.append(n)
  if tag not in ('area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'): self.stack.append(n)
 def handle_endtag(self,tag):
  for i in range(len(self.stack)-1,0,-1):
   if self.stack[i].tag==tag: self.stack=self.stack[:i];break
 def handle_data(self,data): self.stack[-1].children.append(data)
owners={'conversations':'t-2237','desk':'t-2240','tasks':'t-2239','approvals':'t-2239','tempo':'t-2238','changes':'t-2239','inbox':'t-2237','memory':'t-2243','machines':'t-2241','models':'t-2241','bridges':'t-2242','secrets':'t-2242','people':'t-2236','signing-in':'t-2236','outside':'t-2236','data':'t-2235','measuring':'t-2234','decided':'t-2190','index':'t-2190'}
# Narrow observable criteria supplement broad prose. Text presence proves only
# these visible facts, never the whole behavioral promise it came from.
ui={
 'conversations':[('Comms','The private thread displays the person message and agent reply.',['Please compare replacement pumps','Three fit. The quiet model']),('Comms','A question appears inline with Allow and Deny.',['Spend up to 180','Allow','Deny']),('Comms','Work made in the conversation is listed.',['Work','Compare garden pumps','Order the selected pump'])],
 'desk':[('Home','Home shows owned agents and their last answer.',['Fern','Moss','LAST ANSWER','Three fit.']),('Home','Home offers a message box for each owned agent.',['MESSAGE FERN','MESSAGE MOSS','Send'])],
 'tasks':[('Tasks','Ready work is listed in the Tasks tile.',['Ready','Measure the hose']),('Tasks','A task detail displays its title, goal, reason and owner.',['Measure the hose','Goal','Why','Owner: agent fern']),('Tasks','The task detail offers claim, close and comment.',['Claim','Close','Comment'])],
 'approvals':[('Approvals','The pending request shows its question, reason, outcomes and exact target.',['Inspect the example pump?','Why','If you allow','If you deny','command: example-worker:inspect-pump']),('Approvals','The request offers Allow and Deny.',['Allow','Deny']),('Approvals','The request shows its permanent request record.',['Permanent record','request'])],
 'tempo':[('Tempo','The trigger detail shows its source, lifespan, target and words.',['answer · once','An item in fern','Words','Continue after the example inspection']),('Tempo','The trigger offers Run now, Cancel and Pause agent.',['Run now','Cancel','Pause agent'])],
 'changes':[('Changes','The PR detail shows checks, review, head commit and linked task.',['Checks','Review','Commit:','Compare garden pumps'])],
 'inbox':[('Inbox','The waiting question displays reason and yes/no outcomes.',['Spend up to 180','If yes','If no','The example pump is available.']),('Inbox','The question offers Yes, No, a written answer, done and dismiss.',['Yes','No','Record answer','Mark done','Dismiss'])],
 'memory':[('Knowledge','Knowledge offers search and freshness folders.',['Search knowledge','Recently verified','Due a check']),('Activity','Activity shows a day and the conversation turns.',['Shown day','Repair the garden pump','3 turns'])],
 'people':[('Project sharing','The owner can open project sharing without an unavailable screen.',[]),('Household setup','The owner can open household members and agents without an unavailable screen.',[])],
 'signing-in':[('Your account','The signed-in member can see their account without an unavailable screen.',[])],
 'bridges':[('Bridges','The Bridges tile has connections, channel rules, person links and pending sends.',['Connections','Channel rules','Person links','Pending sends'])],
 'secrets':[('Settings','Secrets live in Settings with requests and grants.',['Secrets','Requests','Grants'])],
}
out=ROOT/'docs/rebuild-checklists';out.mkdir(exist_ok=True)
for f in sorted((ROOT/'docs/how-it-works/site').glob('*.html')):
 p=Parser();p.feed(f.read_text());nodes=list(p.root.all());rows=[];seen=set()
 def add(text,section,probe=None):
  if not text or text in seen:return
  seen.add(text);rows.append({'id':f.stem+'-'+str(len(rows)+1).zfill(3),'promise':text,'source':f'docs/how-it-works/site/{f.name}'+('#'+section if section else ''),**({'probe':probe} if probe else {})})
 for n in nodes:
  if n.tag=='li' and n.parent and (n.parent.cls('does') or n.parent.cls('see') or n.parent.cls('rules') or n.parent.cls('facts') or n.parent.cls('plumb')):
   add(n.text(),'see-h' if n.parent.cls('see') else '')
  elif n.tag=='p' and (n.within('ledger') or n.within('venue')): add(n.text(),'con-h')
  elif n.tag=='p' and n.parent and n.parent.cls('how__p'): add(n.text(),'how-h')
  elif n.tag=='p' and n.within('dec'): add(n.text(),'')
  elif n.tag=='span' and n.parent and n.parent.cls('node__body') and n.within('anat'): add(n.text(),'con-h')
  elif n.tag=='p' and len(n.text())>100 and n.within('wrap') and not any(n.within(c) for c in ('cols','how__pic','tile','band__head','foot')): add(n.text(),'')
 # Conversations' unique structural rules and its prose are outside .how.
 if f.stem=='conversations':
  for n in nodes:
   if n.tag=='p' and any(n.within(c) for c in ('stages','hub','out','inbox-flow')):add(n.text(),'')
 for app,text,contains in ui.get(f.stem,[]): add(text,'',{'kind':'ui','app':app,'contains':contains})
 if f.stem=='conversations':
  add('Sending in Comms persists the message after reload and creates one Inbox delivery item.','',{'kind':'action','action':'commsSend'})
  add('A question answered in Inbox becomes answered inline in Comms.','',{'kind':'action','action':'commsAnswer'})
 if f.stem=='inbox':add('Answering Yes records who answered and adds exactly one item for the agent.','',{'kind':'action','action':'inboxAnswer'})
 if f.stem=='memory':add('Create a provisional Knowledge fact, manually mark it due, verify it with Still true, then retain its words and Fresh state after reload.','',{'kind':'action','app':'Knowledge'})
 if f.stem=='signing-in':add('A first-run one-time link signs the browser in.','',{'kind':'signin'})
 if f.stem=='data':add('The real GraphQL websocket carries data after sign-in without protocol errors.','',{'kind':'live'})
 if f.stem=='desk':add('Every app discovered in the launcher opens a tile.','',{'kind':'launcher'})
 if f.stem=='data':
  for row in rows:
   if row['promise'].startswith('A query names a table from the model'):row['probe']={'kind':'legacy-data-socket'}
 if f.stem=='desk':
  for row in rows:
   if row['promise'].startswith('Each tile asks for its rows over the one live connection'):row['probe']={'kind':'legacy-data-socket'}
 if f.stem=='index':
  for row in rows:
   if row['promise'].startswith('5 One query endpoint'):row['probe']={'kind':'legacy-data-socket'}
 if f.stem=='tasks':
  for row in rows:
   if row['promise'].startswith('Lets a person or an agent claim work'):row['probe']={'kind':'action','action':'taskLifecycle'}
 # Carry source hashes so a changed approved page cannot silently reuse old results.
 obj={'page':f.stem,'title':next(n.text() for n in nodes if n.tag=='h1'),'ownerTask':owners[f.stem],'sourceSha256':hashlib.sha256(f.read_bytes()).hexdigest(),'promises':rows,'modelTables':[n.attrs['id'][2:] for n in nodes if n.tag=='details' and n.cls('tbl') and n.attrs.get('id','').startswith('t-')]}
 (out/(f.stem+'.json')).write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n')
 print(f.stem,len(rows))

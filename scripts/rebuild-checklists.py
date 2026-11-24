"""Copy promises from the approved pages; never edit those pages."""
import argparse,hashlib,json,re
from pathlib import Path
from html.parser import HTMLParser
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check',action='store_true',help='Fail if committed checklists differ, without writing them')
args=parser.parse_args()
mismatches=[]
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
owners={'conversations':'t-2237','desk':'t-2240','tasks':'t-2239','approvals':'t-2239','tempo':'t-2238','changes':'t-2239','inbox':'t-2237','memory':'t-2243','machines':'t-2241','models':'t-2241','bridges':'t-2242','secrets':'t-2242','people':'t-2236','signing-in':'t-2236','outside':'t-2236','data':'t-2254','measuring':'t-2234','decided':'t-2190','tools':'t-2190','index':'t-2190'}
# Narrow observable criteria supplement broad prose. Text presence proves only
# these visible facts, never the whole behavioral promise it came from.
ui={
 'conversations':[('Comms','The private thread displays the person message and agent reply.',['Please compare replacement pumps','Three fit. The quiet model']),('Comms','A question appears inline with Allow and Deny.',['Spend up to 180','Allow','Deny']),('Comms','Work made in the conversation is listed.',['Made here','Compare garden pumps','Order the selected pump'])],
 'desk':[('Home','Home shows owned agents and their last answer.',['Fern','Moss','LAST ANSWER','Three fit.']),('Home','Home offers a message box for each owned agent.',['MESSAGE FERN','MESSAGE MOSS','Send'])],
 'tasks':[('Tasks','Ready work is listed in the Tasks tile.',['Ready','Measure the hose']),('Tasks','A task detail displays its title, goal, reason and owner.',['Measure the hose','GOAL\nThe example garden has working water.','WHY\nThe old pump stopped.','OWNER\nFern']),('Tasks','The task detail offers claim, close and comment.',['Claim','Close','Comment'])],
 'approvals':[('Approvals','The pending request shows its question, reason, outcomes and exact target.',['May Fern inspect the example pump before ordering?','Check the hose before ordering.','IF YOU ALLOW','Fern inspects it.','IF YOU DENY','Fern waits.','command: example-worker:inspect-pump']),('Approvals','The request offers Allow and Deny.',['Allow','Deny']),('Approvals','The request shows its permanent request record.',['HISTORY','Asked '])],
 'tempo':[('Tempo','The trigger detail shows its source, lifespan, target and words.',['answer · once','An item in fern','Words','Continue after the example inspection']),('Tempo','The trigger offers Run now, Cancel and Pause agent.',['Run now','Cancel','Pause agent'])],
 'changes':[('Changes','The PR detail shows checks, review, head commit and linked task.',['Checks passing','REVIEW','Approved','COMMIT','aaaaaaaa','Compare garden pumps'])],
 'inbox':[('Inbox','The waiting question displays reason and yes/no outcomes.',['Spend up to 180','IF YES','Fern orders the pump.','IF NO','Fern compares cheaper pumps.','The example pump is available.']),('Inbox','The question offers Yes, No, a written answer, done and dismiss.',['Yes','No','Record answer','Mark done','Dismiss'])],
 'memory':[('Knowledge','Knowledge offers search and freshness folders.',['Search knowledge','Recently verified','Due a check']),('Activity','Activity shows a day and the conversation turns.',['Shown day','Repair the garden pump'])],
 'people':[('Sharing','The owner can open project sharing without an unavailable screen.',[]),('Household setup','The owner can open household members and agents without an unavailable screen.',[])],
 'signing-in':[('Your account','The signed-in member can see their account without an unavailable screen.',[])],
 'bridges':[('Bridges','The Bridges tile has connections, channel rules, person links and pending sends.',['Connections','Channel rules','Person links','Pending sends'])],
 'secrets':[('Settings','Secrets live in Settings with requests and grants.',['Secrets','Requests','Grants'])],
}
# These source promises already have behavior probes; regeneration must keep them.
action_promises={('inbox',"A trigger that fires drops an item in the recipient's inbox."):'scheduledInbox',
 ('tasks','Lets a person or an agent claim work, comment on it, close it, and hand it back or reopen it.'):'taskLifecycle'}
out=ROOT/'docs/rebuild-checklists'
if not args.check: out.mkdir(exist_ok=True)
# Pages put to the owner and not yet approved: on the site for reading, and no part of what the rebuild is measured against.
proposed={'houses'}
for f in sorted((ROOT/'docs/how-it-works/site').glob('*.html')):
 if f.stem in proposed:continue
 p=Parser();p.feed(f.read_text());nodes=list(p.root.all());rows=[];seen=set()
 source_hash=hashlib.sha256(f.read_bytes()).hexdigest()
 previous_path=out/(f.stem+'.json')
 previous=json.loads(previous_path.read_text()) if previous_path.exists() else {}
 # Bind evidence to unchanged source text and page bytes, never a shifting id.
 bindings={(row['promise'],row['source']):row['probe'] for row in previous.get('promises',[]) if 'probe' in row} if previous.get('sourceSha256')==source_hash else {}
 def add(text,section,probe=None):
  if not text or text in seen:return
  source=f'docs/how-it-works/site/{f.name}'+('#'+section if section else '')
  if probe is None and (f.stem,text) in action_promises: probe={'kind':'action','action':action_promises[(f.stem,text)]}
  if probe is None:probe=bindings.get((text,source))
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
 if f.stem=='conversations':
  for row in rows:
   if row['promise'].startswith('Each thing said or done is a turn:'):row['probe']={'kind':'action','action':'conversationTurns'}
   if row['promise'].startswith('A job works in one conversation, and a conversation points at the job working in it now.'):row['probe']={'kind':'action','action':'nativeProtocol'}
   if row['promise'].startswith('A private chat in Comms between one person and one agent.'):row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['conversationPrivatePair','commsSend','commsPrivacy']]}
   if row['promise']=='A channel or a direct message. A bot signed in to the server speaks for the agent.':row['probe']={'kind':'action','action':'discordConversations'}
   if row['promise']=='The same, in a Slack workspace.':row['probe']={'kind':'action','action':'slackConversations'}
   if row['promise'].startswith('Each incoming message goes into one conversation.'):row['probe']={'kind':'action','action':'bridgeMail'}
   if row['promise'].startswith('d Checked at the door.'):row['probe']={'kind':'all','probes':[{'kind':'action','action':name} for name in ['conversationCallers','conversationVisibility']]}
   if row['promise'].startswith('A request for a secret records the conversation'):row['probe']={'kind':'action','action':'conversationSecretSource'}
   if row['promise'].startswith('An inbox item links to the conversation it came from.'):row['probe']={'kind':'all','probes':[{'kind':'action','action':name} for name in ['privateConversationQuestion','inboxDiscussion','conversationDigest']]}
   if row['promise'].startswith('A task names the conversation it came from.'):row['probe']={'kind':'action','action':'conversationTaskSource'}
   if row['promise'].startswith('An approval records the conversation it was asked in.'):row['probe']={'kind':'action','action':'conversationApprovalSource'}
   if row['promise'].startswith(('A conversation is one agent talking in one place.', 'One table Every conversation', 'One per place An agent')):row['probe']={'kind':'action','action':'conversationRecords'}
   if row['promise'].startswith('A thread keeps the pull requests it mentions'):row['probe']={'kind':'action','action':'conversationChangeCard'}
   if row['promise'].startswith('When an agent finishes a stretch of work'):row['probe']={'kind':'action','action':'conversationDigest'}
   if row['promise'].startswith('One job at a time'):row['probe']={'kind':'action','action':'conversationSingleJob'}
   if row['promise'].startswith('A trigger drops an item into the conversation'):row['probe']={'kind':'action','action':'scheduledWorker'}
   if row['promise'].startswith('A trigger from Tempo drops an item'):row['probe']={'kind':'action','action':'conversationTempoDelivery'}
   if row['promise'].startswith('A piece of work one agent hands to another.'):row['probe']={'kind':'action','action':'nativeHandoff'}
   if row['promise'].startswith('That need becomes a question in the inbox'):row['probe']={'kind':'action','action':'privateConversationQuestion'}
 for app,text,contains in ui.get(f.stem,[]):
  probe={'kind':'ui','app':app,'contains':contains}
  if text in ('Home shows owned agents and their last answer.','Home offers a message box for each owned agent.'):probe={'kind':'action','action':'homeMessage'}
  if text=='Knowledge offers search and freshness folders.':probe={'kind':'action','action':'knowledgeSearchFolders'}
  if app=='Activity':probe['patterns']=[r'Repair the garden pump\s+[^\n]*\b[1-9][0-9]* turns\b']
  add(text,'',probe)
 if f.stem=='tempo':
  for row in rows:
   if row['promise']=='Shows a day as a calendar, with each trigger at the time it fires.':row['probe']={'kind':'action','action':'tempoCalendar'}
   if row['promise']=="Holds an agent's triggers while the agent is paused.":row['probe']={'kind':'action','action':'pausedWake'}
   if row['promise'].startswith('Each recipient sets a volume on an inbox item.'):row['probe']={'kind':'action','action':'inboxVolume'}
   if row['promise'].startswith('Waiting on an approval is a once-only trigger on that answer.'):row['probe']={'kind':'action','action':'tempoResumed'}
  for check,text in [('held','An answer arriving while the agent is paused does not fire its trigger.'),('resumed','Resuming fires the held once-only answer trigger exactly once.'),('settled','Run now delivers one person Inbox item, then the whole waiting batch notifies after settling.'),('cancelled','Cancelling a future trigger prevents delivery beyond its deadline.')]:add(text,'',{'kind':'action','action':'tempo'+check.capitalize()})
 if f.stem=='conversations':
  add('Sending in Comms persists the message after reload and creates one Inbox delivery item.','',{'kind':'action','action':'commsSend'})
  add('A question answered in Inbox becomes answered inline in Comms.','',{'kind':'action','action':'commsAnswer'})
 if f.stem in ('conversations','memory'):
  for row in rows:
   if row['promise'].startswith('A session leaves a short note'):row['probe']={'kind':'action','action':'sessionEpisode'}
 if f.stem=='secrets':
  evidence={
   'Keeps each value encrypted, in a separate file held by a separate small program.':'installedSecretHolder',
   'Lets an agent request a secret, and a person or a rule answer.':'installedSecretHolder',
   'Grants access for a set time, to one agent or to one job.':'installedSecretHolder',
   'Writes down every time a value is handed out.':'installedSecretHolder',
   'A rule is a standing answer for one secret, for the agents it lists. Answering always makes a rule. The household has a default for a secret with no rule of its own.':'secretStandingAnswer',
   'A grant goes to one agent and can be limited to one job. Each use names the job.':'installedSecretHolder',
   'An agent requests a secret with a reason and a length of time. A person answers, or a rule answers for them. A yes creates a grant that lasts a set time.':'installedSecretHolder',
   'c Agents. An agent is handed a value only under a grant, and each hand-off is recorded.':'installedSecretHolder',
   'A request records the conversation it was asked in.':'conversationSecretSource',
   'Work can wait on the request with a trigger that fires when it is answered.':'inboxSecretRequest',
   "Credentials agents need, and who may use each one. A secret is a named credential, such as a GitHub token.":'secretValues',
   "A pending request waits in a person's Inbox.":'inboxSecretRequest',
   "A connection's bot token is one of the stored secrets.":'bridgeSettings',
   "A secret's value never sits in loom's main database. The app can set or replace a value and cannot read one back.":'secretValues',
   "b Values are never shown. A value is write-only. Nobody reads one back in the app.":'secretValues',
  }
  for row in rows:
   if row['promise'] in evidence:row['probe']={'kind':'action','action':evidence[row['promise']]}
   if row['promise'].startswith('a Owners manage them. Household owners manage Settings,'):
    row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['deskPanelVisibility','settingsGrant']]}
   if row['promise']=="d Checked at the door. Loom applies this to callers from outside: a person, an agent, a machine, someone's own program. Loom's own parts read without asking.":
    row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['secretCallers','installedSecretHolder','settingsGrant','secretValues']]}
   if row['promise'].startswith('Every time a value leaves the key holder,'):
    row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['installedSecretHolder','secretValues']]}
 if f.stem=='secrets':add('The owner can add, replace and remove a Secret value in Settings; reload preserves the result, the value is not displayed or stored in the main database, and each change is recorded.','',{'kind':'action','action':'secretValues'})
 if f.stem=='secrets':add('The owner can change the household default from Ask to Never in Settings and it persists after reload.','',{'kind':'action','action':'secretDefault'})
 if f.stem=='approvals':
  for row in rows:
   if row['promise'].startswith('An open household approval card can show an advisory caution'):row['probe']={'kind':'action','action':'approvalCaution'}
 if f.stem in ['approvals','inbox']:
  for row in rows:
   if row['promise'].startswith(("A pending approval is an item in a person's Inbox", 'A pending approval arrives as an item')):row['probe']={'kind':'action','action':'approvalInbox'}
 if f.stem=='bridges':
  for row in rows:
   if row['promise'] in ('How agents talk to people in other apps. A connection is one bot signed in to one Discord server or Slack workspace, speaking for one agent.',
                          'Connects a bot to a server or workspace for one agent.',
                          'A connection is one bot signed in to one Discord server or Slack workspace, speaking for one agent. Attachments fetched from Slack are kept for 14 days.'):
    actions=['discordConversations','slackConversations']
    if row['promise'].endswith('Attachments fetched from Slack are kept for 14 days.'):actions.append('slackFileRetention')
    row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in actions]}
   if row['promise']=="An agent's run settings give each outside person a tier.":row['probe']={'kind':'action','action':'bridgeContactTiers'}
   if row['promise']=="b An agent's owners. An agent's owners see their agent's connections.":row['probe']={'kind':'action','action':'deskPanelVisibility'}
   if row['promise']=="The bot's token is a stored secret.":row['probe']={'kind':'action','action':'bridgeSettings'}
   if row['promise'].startswith('a Household things. Connections, channel rules and person links'):
    row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['bridgeSettings','deskPanelVisibility']]}
   if row['promise'].startswith('d Checked at the door. Loom applies this to callers from outside:'):row['probe']={'kind':'action','action':'inboxCallers'}
   if row['promise']=='Records whether each reply arrived, and says so when it cannot tell.':row['probe']={'kind':'action','action':'bridgeReceipts'}
   if row['promise'] in ('It arrives in the inbox with discord or slack as its source.', 'Decides which agent answers in a channel when nobody is addressed.',
     'The message goes into one conversation: the agent in that channel.',
     'A message from outside is kept as an incoming message, matched to a person and a channel rule, and passed into the right conversation. It can be held or dropped, with a reason.',
     'A channel rule names the agent that answers in a channel. A connection can listen only to some channels, or ignore some.',
     'Links an outside user to the household member they are.', 'A person link says which household member an outside user is.'):row['probe']={'kind':'action','action':'bridgeMail'}
 if f.stem=='bridges':add('The owner can save a Discord channel rule and a Slack person link in Bridges and inspect both after reload.','',{'kind':'action','action':'bridgeSettings'})
 if f.stem=='inbox':add('Answering Yes records who answered and adds exactly one item for the agent.','',{'kind':'action','action':'inboxAnswer'})

 if f.stem=='memory':add('Create a provisional Knowledge fact, manually mark it due, verify it with Still true, then retain its words and Fresh state after reload.','',{'kind':'action','app':'Knowledge'})
 if f.stem=='people':
  for row in rows:
   if row['promise']=='Lists the agents, and who owns each.':row['probe']={'kind':'action','action':'householdAgentOwners'}
  add('Adding a household member through the normal built program persists that member.','',{'kind':'action','app':'Household setup'})
  add('Creating a project through the normal built program persists its member list.','',{'kind':'action','app':'Sharing'})
 if f.stem=='signing-in':add('A first-run one-time link signs the browser in.','',{'kind':'signin'})
 if f.stem=='signing-in':add('Making and hiding a one-time sign-in link through Account persists one link without exposing it in evidence.','',{'kind':'action','app':'Your account'})
 if f.stem=='conversations':
  for row in rows:
   if row['promise'].startswith('e Words. Message words are kept'):row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['conversationRetention','conversationShortRetention']]}
 if f.stem=='data':add('The real GraphQL websocket carries data after sign-in without protocol errors.','',{'kind':'live'})
 if f.stem=='models':
  for row in rows:
   if row['promise']=='Adds a subscription: choose the service, label it, choose its machines, sign in.':row['probe']={'kind':'action','action':'subscriptionSignIn'}
   if row['promise']=='Lists every subscription to a model service, grouped by service, with how full it is.':row['probe']={'kind':'action','action':'subscriptionGroups'}
   if row['promise'].startswith("One subscription's fullest window, as a tiny bar and a word,"):row['probe']={'kind':'action','action':'subscriptionCapacity'}
   if row['promise'].startswith('An account is signed in on particular worker machines.'):row['probe']={'kind':'action','action':'modelsMachines'}
 if f.stem=='desk':add('Every app discovered in the launcher opens a tile.','',{'kind':'launcher'})
 if f.stem=='inbox':
  for row in rows:
   if row['promise']=='A pending request for a secret arrives as an item.':row['probe']={'kind':'action','action':'inboxSecretRequest'}
   if row['promise'].startswith("A task's question arrives as an item, with a link to the task."):row['probe']={'kind':'action','action':'inboxTaskArrival'}
   if row['promise'].startswith("A subagent's brief arrives as an item;"):row['probe']={'kind':'action','action':'nativeHandoff'}
   if row['promise'].startswith('The conversation it belongs to.'):row['probe']={'kind':'action','action':'conversationInboxIngress'}
   if row['promise'].startswith('Sends you to Approvals or the task when the answer belongs there.'):row['probe']={'kind':'action','action':'inboxSourceTargets'}
   if row['promise'].startswith('A question can name an approval or a task whose outcome settles it.'):row['probe']={'kind':'action','action':'inboxSourceOutcome'}
   if row['promise']=='Lists what needs you, with what happens on yes and on no.':row['probe']={'kind':'action','action':'inboxConsequences'}
   if row['promise'].startswith(('Takes a yes, a no', 'An item that is a question says')):row['probe']={'kind':'action','action':'inboxDecisions'}
   if row['promise'].startswith(('Marks what you have read', 'Opening an item marks it read')):row['probe']={'kind':'action','action':'inboxHistory'}
 if f.stem=='desk':
  for row in rows:
   if row['promise'].startswith("Home shows each agent's last answer and recent conversations"):row['probe']={'kind':'action','action':'homeMessage'}
   if row['promise'].startswith('Wears one of three looks'):row['probe']={'kind':'action','action':'deskLooks'}
   if row['promise'].startswith(('Each member keeps their own look','b Your own look.')):row['probe']={'kind':'action','action':'memberAppearance'}
   if row['promise'].startswith('A look is a set of colours'):row['probe']={'kind':'action','action':'deskAppearance'}

   if row['promise'].startswith('Each agent has a drawn face:'):row['probe']={'kind':'action','action':'deskFaces'}
   if row['promise'].startswith('The desk is loom on a desktop screen.'):row['probe']={'kind':'action','action':'deskShell'}
   if row['promise'] in ("A rail card lists the agent's current jobs.", "Shows each agent's face, its state and what it is doing."):row['probe']={'kind':'action','action':'deskJobs'}
   if row['promise'].startswith('The ticker reads counts'):row['probe']={'kind':'action','action':'deskTicker'}
   if row['promise'].startswith('The count comes from the items waiting in your inbox.'):row['probe']={'kind':'action','action':'deskWaiting'}
   if row['promise'].startswith('c The phone.'):row['probe']={'kind':'all','probes':[{'kind':'action','action':name} for name in ['dataDoor','deskPanelVisibility','phoneTask']]}
   if row['promise'].startswith('a What you may see.'):row['probe']={'kind':'action','action':'deskPanelVisibility'}
   if row['promise'].startswith('Places tiles by one rule'):row['probe']={'kind':'action','action':'deskGeometry'}
   if row['promise'].startswith('The first tile takes the big slot.'):row['probe']={'kind':'action','action':'deskLayout'}
   if row['promise'].startswith(('Keeps every installed app within reach', 'The launcher lists every app in groups')):row['probe']={'kind':'action','action':'deskLauncher'}
 if f.stem=='data':
  for row in rows:
   if row['promise'].startswith(('terminal_credentials ', 'terminal_sessions ', 'terminal_runs ')):row['probe']={'kind':'action','action':'deskJobs'}
   if row['promise'].startswith('A query names a table from the model'):row['probe']={'kind':'legacy-data-socket'}
 if f.stem=='desk':
  for row in rows:
   if row['promise'].startswith('Each tile asks for its rows over the one live connection'):row['probe']={'kind':'legacy-data-socket'}
 if f.stem=='index':
  for row in rows:
   if row['promise'].startswith('5 One query endpoint'):row['probe']={'kind':'legacy-data-socket'}

 if f.stem=='signing-in':
  for row in rows:
   if row['promise'].startswith(('Gives each agent', "An agent's body and each machine carry")):row['probe']={'kind':'action','action':'nativeProtocol'}
   if row['promise'].startswith('Sends notifications to the phones and browsers you turn on.'):row['probe']={'kind':'action','action':'signinNotifications'}
   if row['promise'].startswith('Signs a person in with a passkey or a one-time link.'):row['probe']={'kind':'all','probes':[{'kind':'signin'},{'kind':'action','action':'signinPasskey'}]}
   if row['promise'].startswith('Lists your signed-in browsers and passkeys, and lets you end them.'):row['probe']={'kind':'all','probes':[{'kind':'action','action':'signinPasskeyControls'},{'kind':'action','action':'signinBrowsers'}]}
   if row['promise'].startswith("A person's token names the member."):row['probe']={'kind':'action','action':'signinMember'}
   if row['promise'].startswith('A person gets a session with a passkey or by opening a one-time sign-in link.'):row['probe']={'kind':'action','action':'signinCounterRules'}
   if row['promise'].startswith(("A person's browser holds a session", 'b Owners.', 'c Never the token.')):row['probe']={'kind':'action','action':'signinDoor'}
   if row['promise'].startswith('a Your own.'):row['probe']={'kind':'action','action':'signinOwnSettings'}
 if f.stem=='tasks':
  for row in rows:
   if row['promise'].startswith('Lets a person or an agent claim work'):row['probe']={'kind':'action','action':'taskLifecycle'}
   # taskLifecycle claims, hands back, claims again, closes, reopens and closes again; taskStructure covers ready and blocked.
   if row['promise'].startswith('A task is ready when it is open'):row['probe']={'kind':'all','probes':[{'kind':'action','action':'taskStructure'},{'kind':'action','action':'taskLifecycle'}]}
 if f.stem=='machines':
  for row in rows:
   if row['promise'] in ("An agent's body carries a token, and one can belong to a single job.", 'A grant can be for one job only, and each use names the job.'):
    row['probe']={'kind':'action','action':'installedSecretHolder'}
   if row['promise'].startswith(('The agent it runs, the project it is for', 'a Jobs. A job carries its agent')):row['probe']={'kind':'action','action':'jobLabels'}
   if row['promise'].startswith(("Starts a job when an agent's inbox", "A non-empty inbox starts a job.", "A job works in one conversation")):row['probe']={'kind':'action','action':'scheduledWorker'}
   if row['promise']=="Shows each agent's current jobs on its card on Home.":row['probe']={'kind':'action','action':'homeJobs'}
   if row['promise'].startswith('A box is a machine with a worker on it.'):row['probe']={'kind':'action','action':'machinePlacement'}
   if row['promise'].startswith(('Records each machine with a worker', 'c Boxes. A box belongs')):row['probe']={'kind':'action','action':'machineRoster'}
   if row['promise'].startswith('A job is one run of an agent'):row['probe']={'kind':'action','action':'jobOutcomes'}
   if row['promise'].startswith(('Retries a job that fails to start','A job that fails to start is tried again')):row['probe']={'kind':'action','action':'workerRetries'}
 if f.stem=='tools':
  for row in rows:
   if row['promise']=='Write a note, read one by path, list notes under a prefix.':row['probe']={'kind':'action','action':'namedNotes'}
   if row['promise']=='Change a knowledge page, mark it still true or due a check, and restore an earlier version of it.':row['probe']={'kind':'action','action':'namedKnowledgeHistory'}
   if row['promise']=='Search knowledge pages, read one, and add one.':row['probe']={'kind':'action','action':'namedKnowledge'}
 if f.stem=='approvals':
  for row in rows:
   # approvalPreparedChanges denies one dangerous card with one answer and allows another, which takes the second yes.
   if row['promise'].startswith('Revoking a token, revoking a machine and signing out a browser cannot be put back.'):row['probe']={'kind':'action','action':'approvalPreparedChanges'}
 if f.stem=='memory':
  for row in rows:
   if row['promise'].startswith('A change saves the earlier version first.'):row['probe']={'kind':'action','action':'memoryRevisions'}
   if row['promise']=='Shows what happened each day in Activity.':row['probe']={'kind':'action','action':'activityDays'}
   if row['promise']=='Activity lists the tasks and pull requests each conversation touched.':row['probe']={'kind':'action','action':'activityWorkLinks'}
   if row['promise']=="Memories, notes, people cards, project cards and identity live in each agent's own folder. Knowledge pages and the people directory are shared by the household. Identity also holds a page for each harness, model, role and project the agent works in, loaded when asked for, and a summary of what its other bodies did in the last 24 hours.":
    row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['agentFolderContents','sharedHouseholdFiles','identityPages','sessionEpisode']]}
   if row['promise']=="each agent's folder Its memories and their history, drafts awaiting ratification, its notes and their earlier versions, people cards, project cards, and its identity files.":
    row['probe']={'kind':'action','action':'agentFolderContents'}
   if row['promise'].startswith(("Keeps each agent's memories in that agent's own files.","A memory belongs to one agent.","a Memories, notes and cards.")):row['probe']={'kind':'action','action':'agentMemoryFiles'}
   if row['promise'].startswith('Each memory has a temperature.'):row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['semanticRecall','memoryTemperature']]}
   if row['promise'].startswith('Recalls by meaning, and keeps what is used most'):row['probe']={'kind':'action','action':'semanticRecall'}
   if row['promise']=='shared by the household Knowledge pages and the people directory.':row['probe']={'kind':'action','action':'sharedHouseholdFiles'}
   if row['promise'].startswith('b Knowledge. Knowledge pages are shared by the household.'):row['probe']={'kind':'action','action':'sharedKnowledgeAudience'}
   if row['promise'].startswith('A knowledge page is a fact about the world'):row['probe']={'kind':'action','action':'knowledgeDue'}
   if row['promise'].startswith(('Keeps notes: longer working documents','A memory is a fact. A note is a document:')):row['probe']={'kind':'action','action':'noteLifetimes'}
 if f.stem=='data':
  for row in rows:
   if row['promise'].startswith('bridge_raw_events '):row['probe']={'kind':'action','action':'bridgeRetention'}
   if row['promise'].startswith('bridge_resume '):row['probe']={'kind':'action','action':'discordResume'}
   if row['promise'].startswith('bridge_file_messages '):row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['slackFileRetention','discordFileRetention']]}
   if row['promise'].startswith('machine_reads '):row['probe']={'kind':'action','action':'machineHistory'}
   if row['promise'].startswith('operation_results '):row['probe']={'kind':'action','action':'dataWriteReceipt'}
   if row['promise'].startswith('migrations The list of changes'):row['probe']={'kind':'action','action':'dataMigrations'}
   if row['promise'].startswith('A tile names exactly the fields'):row['probe']={'kind':'action','action':'dataSelectionSQL'}
   if row['promise'].startswith(('Loom runs one query', 'Loom turns the request into one database query', 'A page reads with one API call', 'Loom handles the request in one API call')):row['probe']={'kind':'action','action':'dataReadBounds'}
   if row['promise']=='The connection knows the caller from its session or token.':row['probe']={'kind':'action','action':'dataCaller'}
   if row['promise'].startswith(('After the first rows, loom sends only', 'After the first rows, changes arrive')):row['probe']={'kind':'action','action':'dataTaskPatches'}
   if row['promise'].startswith('A new inbox item reaches an open Inbox'):row['probe']={'kind':'action','action':'dataInboxChange'}
 if f.stem=='desk':
  for row in rows:
   if row['promise'].startswith('Each tile asks for its rows over the one live connection'):row['probe']={'kind':'action','action':'dataDoor'}
 if f.stem=='conversations':
  for row in rows:
   if row['promise'].startswith(('A conversation belongs to one agent', 'a Three labels.')):row['probe']={'kind':'action','action':'conversationLabels'}
   if row['promise'].startswith('b Who sees it.'):row['probe']={'kind':'action','action':'conversationVisibility'}
   if row['promise'].startswith('c Private.'):row['probe']={'kind':'action','action':'commsPrivacy'}
 if f.stem=='inbox':
  for row in rows:
   if row['promise'].startswith('c Checked at the door.'):row['probe']={'kind':'all','probes':[{'kind':'action','action':name} for name in ['inboxCallers','inboxVisibility']]}
   if row['promise'].startswith('The same inbox table is drawn'):row['probe']={'kind':'all','probes':[{'kind':'action','action':name} for name in ['inboxDocumentation','privateConversationBatch','inboxVolume']]}
   if row['promise']=='Each incoming message becomes one item.':row['probe']={'kind':'action','action':'bridgeMail'}
   if row['promise'].startswith(('One inbox for everything sent to anyone','Every item has a recipient. An agent')):row['probe']={'kind':'all','probes':[{'kind':'action','action':action} for action in ['inboxRecipients','privateConversationBatch','privateConversationQuestion']]}
   if row['promise'].startswith(('Every item has one recipient:', 'a The recipient.')):row['probe']={'kind':'action','action':'inboxRecipients'}
   if row['promise'].startswith('b Who else sees it.'):row['probe']={'kind':'action','action':'inboxVisibility'}
 # Carry source hashes so a changed approved page cannot silently reuse old results.
 obj={'page':f.stem,'title':next(n.text() for n in nodes if n.tag=='h1'),'ownerTask':owners[f.stem],'sourceSha256':source_hash,'promises':rows,'modelTables':[n.attrs['id'][2:] for n in nodes if n.tag=='details' and n.cls('tbl') and n.attrs.get('id','').startswith('t-')]}
 payload=(json.dumps(obj,indent=2,ensure_ascii=False)+'\n').encode('utf-8')
 target=out/(f.stem+'.json')
 if args.check:
  if not target.is_file() or target.read_bytes()!=payload: mismatches.append(str(target.relative_to(ROOT)))
 else: target.write_bytes(payload)
 print(f.stem,len(rows))

if mismatches: raise SystemExit('Checklist regeneration differs: '+', '.join(mismatches)+'. Regenerate the copies and retain evidence bindings to unchanged source promises.')

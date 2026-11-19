"""The ten pages after Tasks, in the Tasks pattern: hero with a drawn picture, what it does, how it connects,
how it works, who can see it, and the collapsed data model from model.py. Imported by site_build.py."""
import html
from site_build import (PATH, N, NUM, TINT, FILE, key, plink, tile, page, foot, data_model, FACE_A, FACE_B, desk_html,
                        chat, c_me, c_art, c_ask, c_ref, c_work, c_step, hero_two, CTL)
from model import PLUMBING

e = html.escape
WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]

# ───────────────────────── pieces
def split_mock(search, folders, list_title, count, top, rows, reader, chips=()):
    nav = [f'<div class="sp__search">{search}</div>'] if search else []
    for f in folders:
        if isinstance(f, str):
            nav.append(f'<span class="lbl">{f}</span>')
        else:
            label, n, on = (list(f) + [False])[:3]
            nav.append(f'<div class="sp__f"{" data-on" if on else ""}><span>{label}</span><em>{n}</em></div>')
    lst = []
    for r in rows:
        title, meta, status, on = (list(r) + [False])[:4]
        lst.append(f'<div class="row"{" data-on" if on else ""}><b>{title}</b><span>{meta}</span><em>{status}</em></div>')
    ch = "".join(f'<span{" data-on" if i == 0 else ""}>{c}</span>' for i, c in enumerate(chips))
    topbtn = f'<span class="mbtn">{top}</span>' if top else ""
    return (f'<div class="tile__body sp"><div class="sp__nav">{"".join(nav)}</div><div class="sp__list">'
            f'<div class="sp__top"><b>{list_title}</b><em>{count}</em>{topbtn}</div><div class="sp__chips">{ch}</div>{"".join(lst)}</div>'
            f'<div class="sp__read">{reader}</div></div>')

def reader(meta, title, sub, btns=(), kv=(), extra=""):
    b = "".join(f'<span class="mbtn{" mbtn--on" if x.startswith("*") else ""}">{x.lstrip("*")}</span>' for x in btns)
    k = "".join(f"<dt>{a}</dt><dd>{v}</dd>" for a, v in kv)
    return (f'<span class="meta">{meta}</span><h4>{title}</h4><span class="meta">{sub}</span>'
            + (f'<dl class="kv">{k}</dl>' if k else "") + extra + (f'<div class="sp__acts">{b}</div>' if b else ""))

def anatomy(head_code, head_title, rows):
    """rows: (code, value) or (code, value, side 'l'|'r', page title, text)."""
    out = [f'<div class="anat__row"><div class="anat__side anat__l"></div><div class="anat__f"><code>{head_code}</code><b>{head_title}</b></div><div class="anat__side anat__r"></div></div>']
    for r in rows:
        code, value = r[0], r[1]
        left = right = tint = ""
        if len(r) > 2:
            side, title, text = r[2], r[3], r[4]
            tint = f"t-{TINT[title]}"
            body = f'{key(title)}<div class="node__body"><b>{plink(title)}</b><span>{text}</span></div>'
            if side == "l":
                left = body + '<i class="wire"></i>'
            else:
                right = '<i class="wire"></i>' + body
        out.append(f'<div class="anat__row {tint}"><div class="anat__side anat__l {tint}">{left}</div><div class="anat__f"><code>{code}</code><span>{value}</span></div>'
                   f'<div class="anat__side anat__r {tint}">{right}</div></div>')
    return f'<div class="anat">{"".join(out)}</div>'

def flow(*parts):
    """state, label, state, label, state"""
    out = []
    for i, p in enumerate(parts):
        out.append(f"<span>{p}</span>" if i % 2 == 0 else f'<i class="wire"><em>{p}</em></i>')
    return f'<div class="flow">{"".join(out)}</div>'

def gate(*items):
    return '<ul class="gate">' + "".join(f"<li>{i}</li>" for i in items) + "</ul>"

def opts(*items):
    return '<ul class="opts">' + "".join(f"<li><b>{a}</b><span>{b}</span></li>" for a, b in items) + "</ul>"

def card(tint, lbl, title, text=""):
    t = f'<span class="muted">{text}</span>' if text else ""
    return f'<div class="card t-{tint}" style="flex:none"><span class="lbl">{lbl}</span><b>{title}</b>{t}</div>'

def log(*rows):
    return '<ol class="logl">' + "".join(f"<li><code>{a}</code><span>{b}</span></li>" for a, b in rows) + "</ol>"

def how(panels):
    out = []
    for title, tint, pic, text in panels:
        out.append(f'<div class="how__p t-{tint}"><h3>{title}</h3><div class="how__pic" aria-hidden="true">{pic}</div><p>{text}</p></div>')
    return f'<div class="how">{"".join(out)}</div>'

OWNER = "A household owner sees everything, including what is private to another member."
PRIVATE = "Private to a member means that member plus household owners."
DOOR = "Loom applies this to callers from outside: a person, an agent, a machine, someone's own program. Loom's own parts read without asking."

def see(labels, items):
    lab = "".join(f'<span class="t-{t}">{l}</span>' for l, t in labels)
    li = "".join(f'<li><span class="key key--sm t-ink" aria-hidden="true">{chr(97 + i)}</span><span><b>{b}</b> {t}</span></li>' for i, (b, t) in enumerate(items))
    return (f'<div class="labels">{lab}</div>' if lab else "") + f'<ul class="see">{li}</ul>'

def app_page(title, kind, lead_b, lead, does, fig, cap, con_h, con_p, anat, how_h, panels, labels, see_items, groups, note="", ref_extra="", chat=None, ctl=False):
    idx = NUM[title]
    tint = TINT[title]
    n = sum(len(names) for _, names in groups)
    dm = (f'<p class="muted">{WORDS[n].capitalize()} table{"s" if n != 1 else ""}. Open one to see its columns, what each means and what it points to.</p>{data_model(groups, tint)}'
          if n else "")
    if ctl:
        cap += CTL
    if chat:
        hero = hero_two(idx, tint, kind, title, f"<b>{lead_b}</b> {lead}", does, fig, chat[0], cap, chat[1])
    else:
        hero = f'''
<section class="hero hero--app">
  <div class="hero__text t-{tint}">
    <p class="eyebrow">Page {idx} of {N} · {kind}</p>
    <h1>{e(title)}</h1>
    <p class="lead"><b>{lead_b}</b> {lead}</p>
    <ul class="does">{"".join(f"<li>{d}</li>" for d in does)}</ul>
  </div>
  <figure class="hero__fig">
    <div class="shadowed" aria-hidden="true">{fig}</div>
    <figcaption class="cap">{cap}</figcaption>
  </figure>
</section>'''
    body = f'''
{hero}

<section class="band" aria-labelledby="con-h">
  <div class="band__head"><span class="tag">Connections</span><h2 id="con-h">{con_h}</h2><p>{con_p} The number on each part is its page on the path.</p></div>
  {anat}
</section>

<section class="band" aria-labelledby="how-h">
  <div class="band__head"><span class="tag">How it works</span><h2 id="how-h">{how_h}</h2><p></p></div>
  {how(panels)}
</section>

<div class="ref">
  <section class="ref__col" aria-labelledby="see-h">
    <h2 id="see-h">Who can see this</h2>
    {see(labels, see_items)}
  </section>
  <section class="ref__col" aria-labelledby="data-h">
    <h2 id="data-h">Data model</h2>
    {dm}{ref_extra}
    {f'<p class="note">{note}</p>' if note else ""}
  </section>
</div>
{foot(idx)}
'''
    return page(idx, f"{title} · loom", body)

# ───────────────────────── 3 Approvals
def approvals():
    mock = split_mock("Search approvals", [("Pending", 1, True), ("History", ""), ("Rules", ""), ("Reported steps", "")], "Approvals", 1, "",
        [("Merge the pump order script", "Checks pass and the task is done.", "art · pending", True)],
        reader("merge · pending", "Merge the pump order script", "art · for you", ["*Allow", "Always for pond", "Deny"],
               [("Why", "Checks pass and the task is done."), ("If you allow", "Art merges it at this exact commit."), ("If you deny", "The pull request stays open."),
                ("Exactly what this allows", "merge: github:owner/repo#12 at one commit")]),
        chips=["Pending 1", "History", "Rules", "Reported steps"])
    anat = anatomy("a-25b12eab · approval", "Merge the pump order script", [
        ("kind, target", "merge · github:owner/repo#12 at one commit", "r", "Changes", "A merge approval names a pull request at one exact commit."),
        ("agent, project, member", "art · pond", "l", "People and projects", "The agent asking, the project it concerns, and a member when it is private."),
        ("conversation", "cv-1a2b3c4d5e6f", "r", "Conversations", "An approval records the conversation it was asked in."),
        ("state", "pending <small>then allowed, denied, used, withdrawn or expired</small>"),
        ("inbox item", "waiting for jonathan", "l", "Inbox", "A pending approval is an item in a person's Inbox, with a link back here."),
        ("minutes", "how long an allowance lasts"),
        ("triggers.watches", "a once-only trigger on this answer", "r", "Tempo", "Work that waits on an approval is a trigger that fires once, when it is answered."),
    ])
    panels = [
        ("One request, one use", "pink", flow("pending", "allow", "allowed", "use", "used"),
         "An agent files what it wants to do, to exactly what, and why. An allowance lasts a set number of minutes and is spent once. A request can also be denied, withdrawn or expire."),
        ("Rules", "violet", opts(("Ask me", "ask first"), ("Tell me after", "do it and report"), ("Just do it", "no question")),
         "A rule answers one kind of request the same way every time, for a scope such as certain repositories or commands. A rule that names a person is a grant to that person. Only the household owner edits rules."),
        ("Asked for in chat", "cyan", card("cyan", "Change a setting", "Wake jonathan's inbox every minute", "Before: the default. After: 60 seconds."),
         "When a person asks an agent in chat to change a setting or do something dangerous, the agent proposes it. Loom shows an approval card inline, with exactly what will change, before and after. On Allow loom makes the change itself and records it. Ordinary work needs no card."),
        ("A dangerous action", "pink", log(("propose", "an agent names it exactly"), ("allow", "a person says yes"), ("confirm", "and says yes a second time")),
         "Revoking a token, revoking a machine and signing out a browser cannot be put back. An agent proposes one the same way as a settings change. Allowing it takes a second, explicit yes. Denying it takes one answer."),
        ("The record", "amber", log(("request", "art asks to merge"), ("allow", "jonathan allows"), ("use", "art merges")),
         "Loom keeps every request, answer and use in a record that is never edited. Steps an agent took under a tell-me-after rule are listed as reported steps."),
    ]
    return app_page("Approvals", "an app", "Permission from a person for an agent to do one specific thing.",
        "An approval covers one of four things: a merge, running a command on a machine, changing a setting, or another dangerous action.",
        ["Shows each request with what happens if you allow it and if you deny it.", "Lets a person allow or deny, with the exact change in front of them.",
         "Shows a card inline in chat when a setting change or a dangerous action is asked for there.", "Holds standing rules, and keeps a permanent record of every request, answer and use."],
        tile("pink", "approvals", "Approvals", mock), "One approval shown two ways, with example content: as a request in the Approvals tile, and as a question with Allow and Deny inline in the conversation it was asked in.",
        "How an approval connects to other parts", "One approval, with a thread from each field that reaches another part.", anat,
        "Requests, rules, chat, dangerous actions and the record", panels,
        [("agent", "cyan"), ("project", "violet"), ("member, when private", "pink")],
        [("Three labels.", "An approval carries the agent asking, the project it concerns, and a member when it is private to them."),
         ("Who sees it.", f"{OWNER} Anyone else sees approvals in their projects and approvals of agents they own. {PRIVATE}"),
         ("Checked at the door.", DOOR)],
        [("", ["approvals", "approval_rules", "approval_notices", "approval_record"])], ctl=True,
        chat=(chat("Pond pump", c_art('The order script is ready in <span class="chip">github:owner/repo#12</span>.')
                   + c_ask("Merge the pump order script?", "Checks pass and the task is done.", "Art merges it at this exact commit.", "The pull request stays open.", "github:owner/repo#12")), "Approvals"))

# ───────────────────────── Tempo
def tempo():
    mock = split_mock("Search tempo", [("Due", 2, True), ("Standing", 2), ("Household lanes", 1), ("Recent history", "")], "Tempo", 2, "Create trigger",
        [("Check the pump delivery", "Nov 14, 2026, 8:31 AM CT · art", "a time · once", True),
         ("Merge when allowed", "when the approval is answered · art", "an answer · once"),
         ("night-shift", "22:00 CT · Every day · art", "a time · until stopped")],
        reader("a time · once · art", "Check the pump delivery", "Due: Nov 14, 2026, 8:31 AM CT", ["Run now", "Cancel"],
               [("Project", "pond"), ("Target", "an item in art's inbox"), ("Words", "See whether the pump has shipped. Comment on t-2190.")]),
        chips=["Due 2", "Standing 2", "Household lanes 1", "Recent history"])
    tchat = chat("Tempo settings", c_me("Change tempo so my inbox wakes me every minute.") + c_art("I can do that. Here is exactly what would change.")
                 + '<div class="msg msg--ask"><div class="msg__b"><b>Change a setting: how long jonathan\'s inbox waits before waking him</b><small>Before: the default</small><small>After: 60 seconds</small>'
                   '<small>Yes: loom makes the change and records it. No: nothing changes.</small><span class="yn"><span class="mbtn mbtn--on t-cyan">Allow</span><span class="mbtn">Deny</span></span></div></div>')
    anat = anatomy("trigger", "Check the pump delivery", [
        ("owner", "agent art", "l", "People and projects", "Who set it: the household, an agent or a person."),
        ("source = time", "Nov 14, 8:31 AM"),
        ("source = pull request", "a pull request changing", "r", "Changes", "A pull request changing can fire a trigger."),
        ("source = answer", "an answer arriving", "l", "Approvals", "Waiting on an approval is a once-only trigger on that answer."),
        ("source = job", "a job stopping", "r", "Machines and jobs", "A job stopping can fire a trigger."),
        ("lifespan", "the next time only"),
        ("target = inbox", "an item for art", "l", "Inbox", "A trigger never wakes anyone directly. It drops an item in an inbox, with trigger as its source."),
        ("then", "a non-empty inbox starts the agent", "r", "Conversations", "The agent's body starts in that conversation and takes everything waiting at once."),
    ])
    panels = [
        ("A trigger's four parts", "violet", opts(("source", "a time, a pull request changing, an answer arriving, a job stopping"), ("lifespan", "until stopped, for today, the next time only"),
                                                 ("owner", "who set it"), ("target", "run an operation, or drop an item in an inbox")),
         "A schedule is a standing time trigger. A lane is a standing time trigger with instructions. A one-off wake is a time trigger that fires once. Waiting on an approval is a once-only trigger on that answer. One trigger can be stopped and started again without touching the rest. Its words, times and label can be edited, and loom keeps what they said before and who changed them."),
        ("Fire, inbox, start", "pink", flow("trigger", "fires", "inbox", "settles", "agent"),
         "A trigger fires in code, with no model. It drops an item in the recipient's inbox. After a short settle time, a non-empty inbox starts an agent's body or notifies a person, with everything waiting at once. Pausing an agent holds its triggers."),
        ("The sweep", "cyan", log(("Changes", "2 open, oldest 3 days"), ("Tasks", "4 ready, oldest 6 days"), ("Approvals", "1 pending, 2 hours")),
         "Each part contributes a short list of what is open and how long it has sat. One session per recipient sorts them. When nothing is open, no session starts."),
        ("Volume", "amber", opts(("full", "the default"), ("dim", "one line"), ("mute", "hidden, and always ends")),
         "Each recipient sets a volume on an inbox item. Dim returns to full when the item changes or has sat long enough. Mute ends after a week by default. A change breaks dim but not mute. Being asked by name breaks both."),
        ("Three settings", "violet", opts(("settle", "how long an inbox waits before waking its owner"), ("dim", "how long before a dimmed item returns to full"), ("mute", "how long a mute lasts: 7 days by default")),
         "The timings are settings a person can change, each with a default. Loom keeps a row only for a person or agent that has changed them."),
    ]
    return app_page("Tempo", "an app", "Triggers: what starts work without anyone asking.",
        "A trigger fires in code and drops an item in someone's inbox. A non-empty inbox is what starts an agent or notifies a person.",
        ["Lists what is standing and what is due.", "Fires on a time, a pull request changing, an answer arriving or a job stopping.",
         "Drops an item in an inbox, or runs an operation that needs no agent.", "Holds an agent's triggers while the agent is paused."],
        tile("violet", "clock", "Tempo", mock),
        "The Tempo tile with example triggers, and a settings change asked for in chat: the agent proposes it, and loom shows an approval card inline with before and after.",
        "How a trigger connects to other parts", "One trigger, with a thread from each part of it that reaches another page.", anat,
        "Four parts, firing, the sweep, volume and settings", panels,
        [("owner", "cyan"), ("for an agent or a person", "pink"), ("project", "violet")],
        [("What it carries.", "A trigger names who set it, the agent or person it is for, and its project."),
         ("Who sees it.", f"{OWNER} Anyone else sees triggers in their projects and triggers for agents they own, and a person also sees a trigger they set for themselves or one that is for them."),
         ("Checked at the door.", DOOR)],
        [("", ["triggers", "trigger_log", "trigger_edits", "agent_pauses", "tempo_settings"])], chat=(tchat, "Tempo"))

# ───────────────────────── 5 Changes
def changes():
    extra = ('<div class="sec"><span class="lbl">Checks</span><span>passing · 4 checks</span></div><div class="sec"><span class="lbl">Review</span><span>approved</span></div>'
             '<div class="sec"><span class="lbl">Merge answer</span><span class="sp__acts"><span class="mbtn mbtn--on">Yes, merge it</span><span class="mbtn">Not yet</span><span class="mbtn">Always for pond</span></span></div>'
             '<div class="sec"><span class="lbl">Tasks</span><span>Order the pump <span class="chip">t-2190</span></span></div>')
    mock = split_mock("Search changes", [("All changes", 2, True), ("Waiting on you", 1), ("Lately", ""), ("loom", ""), ("pond", 2)], "Changes", 2, "Refresh",
        [("Add the pump order script", "github:owner/repo#12 · pond", "CI green, approved, Waiting on you", True),
         ("Fix the winter checklist link", "github:owner/repo#13 · pond", "CI running")],
        reader("github:owner/repo#12 · pond", "Add the pump order script", "CI green, approved, Waiting on you", [], [], extra),
        chips=["All changes 2", "Waiting on you 1", "Lately", "pond 2"])
    anat = anatomy("github:owner/repo#12 · change", "Add the pump order script", [
        ("repository, agent", "owner/repo · opened by art", "l", "People and projects", "Its repository files it under a project. An agent's GitHub login says which agent opened it."),
        ("checks, review, mergeable", "passing · approved · yes"),
        ("change_tasks", "t-2190 Order the pump", "r", "Tasks", "Linked to the tasks its title, branch or description mention."),
        ("waiting_on", "you"),
        ("merge answer", "an approval of kind merge", "l", "Approvals", "Merging needs an approval, or a merge rule that already answers it."),
        ("thread_refs", "mentioned in Pond pump", "r", "Conversations", "A thread that mentions the pull request shows it as a card."),
    ])
    panels = [
        ("Who it is waiting on", "pink", opts(("you", "your answer"), ("agent", "ready to merge"), ("ci", "checks running"), ("reviewer", ""), ("author", "")),
         "For each change loom works out who it is waiting on: you, an agent, the checks, a reviewer or its author. The list is ordered that way, with finished ones last."),
        ("Reading GitHub", "cyan", card("cyan", "change_sync", "Last read 9:12 AM CT", "One row: when loom last read, whether that failed, when it reads next."),
         "Loom reads the pull requests in each project's repositories and keeps a copy, so the desk shows what is waiting without asking GitHub each time."),
        ("Checks and review", "violet", opts(("checks", "passing, failing, running, none"), ("review", "approved, changes requested, required, not required"), ("mergeable", "yes, no, unknown")),
         "Loom keeps the state of a change's checks and review, plus the names of the checks that are failing or still running."),
        ("People on it", "amber", opts(("author", ""), ("reviewer", ""), ("requested", ""), ("assignee", ""), ("commenter", "")),
         "A change lists the GitHub logins on it and the part each plays."),
    ]
    return app_page("Changes", "an app", "Pull requests the household cares about.", "A change is one pull request, read from GitHub and kept as a copy.",
        ["Lists pull requests across the household's projects.", "Says who each one is waiting on.", "Shows its checks, its review and the tasks it mentions.", "Takes your answer on a merge. The agent does the merging."],
        tile("pink", "changes", "Changes", mock), "One pull request shown two ways, with example content. In a chat it is a reference: its card shows the title and state and opens the tile, where the merge is answered.",
        "How a change connects to other parts", "One pull request, with a thread from each field that reaches another part.", anat,
        "Waiting on, reading GitHub, checks and people", panels,
        [("project", "violet"), ("agent", "cyan")],
        [("Two labels.", "A change gets its project from its repository, and its agent when an agent opened it."),
         ("Who sees it.", f"{OWNER} Anyone else sees changes in their projects and changes opened by agents they own."),
         ("Checked at the door.", DOOR)],
        [("", ["changes", "change_checks", "change_people", "change_tasks", "change_sync"])],
        chat=(chat("Pond pump", c_art('The order script is up as <span class="chip">github:owner/repo#12</span>.')
                   + c_ref("Pull request", "Add the pump order script", "CI green, approved, Waiting on you")
                   + c_work(("Add the pump order script", "CI green, approved, Waiting on you · github:owner/repo#12 · Made here"))), "Changes"))

# ───────────────────────── 6 Inbox
def inbox():
    extra = ('<div class="sec"><span class="lbl">Record your answer</span><span class="sp__acts"><span class="mbtn mbtn--on">Yes</span><span class="mbtn">No</span></span>'
             '<span class="field">Or answer in your own words</span><span class="sp__acts"><span class="mbtn">Record answer</span><span class="mbtn">Mark done</span><span class="mbtn">Dismiss</span></span></div>')
    mock = split_mock("Search asks", [("Needs you", 2, True), ("Alerts", ""), ("Answered", 5), ("FYI", ""), ("Errors", ""), "By agent", ("Art", 2), ("Mark", "")], "Needs you", 2, "",
        [("Spend up to $180 on the pump Art picked?", "The pump is in stock today.", "Art · open · Unread", True),
         ("Allow the merge of the pump order script?", "Checks pass and the task is done.", "Art · open · Read")],
        reader("Art · open", "Spend up to $180 on the pump Art picked?", "Nov 14, 2026, 9:20 AM CT · pond", [],
               [("Why", "The pump is in stock today."), ("If yes", "Art orders it today."), ("If no", "Art looks for a cheaper one.")], extra),
        chips=["Needs you 2", "Alerts", "Answered 5", "FYI"])
    anat = anatomy("inbox item · a question", "Spend up to $180 on the pump Art picked?", [
        ("to_kind, to", "person · jonathan", "l", "People and projects", "Every item has one recipient: a person or an agent."),
        ("conversation", "cv-1a2b3c4d5e6f", "r", "Conversations", "The conversation it belongs to. An agent's messages, wakes and handoffs arrive the same way."),
        ("source = task", "a question carried by a task", "l", "Tasks", "A task's question arrives as an item, with a link to the task."),
        ("source = approval", "a request for permission", "r", "Approvals", "A pending approval arrives as an item, and is answered in Approvals."),
        ("source = trigger", "an item a trigger dropped", "l", "Tempo", "A trigger that fires drops an item in the recipient's inbox."),
        ("source = discord, slack", "a message from outside, for an agent", "r", "Discord and Slack", "Each incoming message becomes one item."),
        ("source = secret-request", "a request for a secret", "l", "Secrets", "A pending request for a secret arrives as an item."),
        ("source = handoff", "a brief from another agent", "r", "Machines and jobs", "A subagent's brief arrives as an item; its conversation's place is the parent job."),
    ])
    panels = [
        ("Two directions, one table", "cyan", opts(("to an agent", "its body takes the item"), ("to a person", "it waits in their Inbox app")),
         "Every item has a recipient. An agent's body takes the items addressed to it, in order. A person's Inbox app is the items addressed to them that are waiting."),
        ("A question", "pink", card("cyan", "Question · yes or no", "Spend up to $180 on the pump?", "If yes, Art orders it today. If no, Art looks for a cheaper one."),
         "An item that is a question says how it is answered, with yes or no or in words, and what happens on each answer. The answer, who gave it and when are recorded on the item. Loom also adds a new item for the agent in the same conversation, with answer as its source and the question as its source id."),
        ("Settled without an answer", "violet", flow("waiting", "its task closes", "resolved"),
         "A question can name an approval or a task whose outcome settles it. When that finishes, the item resolves and records why."),
        ("Read marks and references", "amber", log(("inbox_reads", "jonathan opened it, 9:21 AM"), ("inbox_refs", "t-2190"), ("inbox_refs", "github:owner/repo#12")),
         "Opening an item marks it read for that member. An item lists the tasks, approvals, pull requests or conversations it is about."),
    ]
    return app_page("Inbox", "an app", "One inbox for everything sent to anyone, person or agent.",
        "The Inbox app is a person's side of it: the items addressed to you that are waiting.",
        ["Lists what needs you, with what happens on yes and on no.", "Takes a yes, a no, or an answer in your own words.",
         "Sends you to Approvals or the task when the answer belongs there.", "Marks what you have read and keeps what was answered."],
        tile("cyan", "inbox", "Inbox", mock), "One question shown two ways, with example content: waiting in the Inbox tile, and inline in the conversation that raised it, where Allow and Deny answer it.",
        "Where an inbox item comes from", "One item, with a thread to each part that sends items.", anat,
        "Recipients, questions, settling and read marks", panels,
        [("recipient", "cyan"), ("project", "violet"), ("agent", "cyan"), ("member, when private", "pink")],
        [("The recipient.", "An item is for one person or one agent. A person's Inbox shows the waiting items addressed to them."),
         ("Who else sees it.", f"An item also carries the usual labels: a project's people, an agent's owners, or one member alone. {OWNER} {PRIVATE}"),
         ("Checked at the door.", DOOR)],
        [("", ["inbox", "inbox_refs", "inbox_reads", "action_results"])],
        note="The same inbox table is drawn from the agent's side on the " + plink("Conversations") + " page. Volume (full, dim, mute) is explained on the " + plink("Tempo") + " page.",
        chat=(chat("Pond pump", c_me("Can you find a pump that fits the old hose?") + c_art("Three fit. The middle one is in stock at $164.")
                   + c_ask("Spend up to $180 on the pump Art picked?", "The pump is in stock today.", "Art orders it today.", "Art looks for a cheaper one.")), "Inbox"))

# ───────────────────────── 7 Machines and jobs
def machines():
    fig = f'''<div class="panels">
      <div class="panel"><span class="lbl">One computer</span><h4>Loom and a worker, side by side</h4>
        <div class="sec"><span class="lbl">Machine: attic</span><span><span class="chip">loom</span> <span class="chip">worker</span></span><span class="meta">same machine as loom: yes</span></div>
        <div class="sec"><span class="lbl">The worker runs</span><span>Reply in Pond pump <span class="chip">running</span></span></div></div>
      <div class="panel"><span class="lbl">Several computers</span><h4>Workers spread out</h4>
        <div class="sec"><span class="lbl">Machine: attic</span><span><span class="chip">loom</span></span></div>
        <div class="sec"><span class="lbl">Machine: workshop</span><span><span class="chip">worker</span> gpu:5090</span><span class="meta">may run art</span></div>
        <div class="sec"><span class="lbl">Machine: den</span><span><span class="chip">worker</span></span><span class="meta">may run art · mark</span></div></div>
      <div class="panel"><div class="agent" style="border:0;padding:0;background:none">{FACE_A}<div><b>Art</b><i>working</i></div></div>
        <div class="sec"><span class="lbl">Runtime jobs · 2</span><span><b>Reply in Pond pump</b><br><span class="meta">running · Box attic</span><br><span class="meta">Queued 9:14 AM</span></span>
        <span><b>Compare pump models</b><br><span class="meta">queued · Box workshop</span><br><span class="meta">Queued 9:16 AM</span></span></div></div>
    </div>'''
    anat = anatomy("job", "Reply in Pond pump", [
        ("agent, project, member", "art · pond", "l", "People and projects", "The agent it runs, the project it is for, and a member when the work is private."),
        ("box", "attic <small>the machine it runs on</small>"),
        ("conversation", "cv-1a2b3c4d5e6f", "r", "Conversations", "A job works in one conversation and takes that agent's inbox items there."),
        ("started_by", "a member or an agent", "l", "Tempo", "A non-empty inbox starts a job. Triggers are one of the things that fill it."),
        ("state", "running"),
        ("tokens.job", "the body's own credential", "r", "Signing in", "An agent's body carries a token, and one can belong to a single job."),
        ("secret_grants.job", "what it has been handed", "l", "Secrets", "A grant can be for one job only, and each use names the job."),
    ])
    panels = [
        ("A job's life", "cyan", flow("queued", "claimed", "running", "ends", "done"),
         "A job is one run of an agent's body on a box. It is queued, picked up by a worker, runs, and ends done or failed. It can also be stopped or lost."),
        ("Retries", "pink", flow("job 1", "retry of", "job 2", "retry of", "job 3"),
         "A job that fails to start is tried again, up to three times. Each retry is a new job that points back at the one before."),
        ("Boxes", "violet", gate("Its owner says which agents may run there", "An agent can be lent a machine", "A box can report health and never run agents", "An always-on box raises an alert when it goes quiet"),
         "A box is a machine with a worker on it. A member owns it. A worker can share a machine with loom or sit on another one. Facts such as gpu:5090 match work to a machine."),
        ("Run settings", "amber", opts(("house", "the repository that defines it"), ("boxes", "preferred machines, in order"), ("may use", "named secrets, ports, a GPU")),
         "Each agent has run settings. The first preferred machine that is up is used. Settings also say how the agent treats each outside person and which tools its body is not given. How a house is defined and built is on the <a href=\"houses.html\">Houses</a> page."),
    ]
    return app_page("Machines and jobs", "no app of its own", "Where agents run and what they are running.",
        "There are always two programs: loom and a worker. A worker runs agents' bodies and builds, on the same machine as loom or on another. Nothing runs inside loom itself.",
        ["Records each machine with a worker, who owns it and which agents may run there.", "Starts a job when an agent's inbox has something waiting.",
         "Retries a job that fails to start, up to three times.", "Shows each agent's current jobs on its card on Home."],
        fig, "Two ways to set loom up, as a picture with example content: one computer with loom and a worker side by side, or several with workers spread out. Machines and jobs has no tile; an agent's card on Home lists its current jobs.",
        "How a job connects to other parts", "One job, with a thread from each field that reaches another part.", anat,
        "Jobs, retries, boxes and run settings", panels,
        [("agent", "cyan"), ("project", "violet"), ("member, when private", "pink")],
        [("Jobs.", "A job carries its agent, the project it is for, and a member when the work is private."),
         ("Who sees it.", f"{OWNER} Anyone else sees jobs in their projects and jobs of agents they own. {PRIVATE}"),
         ("Boxes.", "A box belongs to the member who owns it, and lists the agents allowed to run there."),
         ("Checked at the door.", DOOR)],
        [("Machines", ["boxes", "box_agents", "box_facts"]), ("Jobs", ["jobs", "job_needs"]),
         ("How each agent runs", ["agent_run_settings", "agent_boxes", "agent_house_secrets", "agent_house_ports", "agent_people", "agent_denied_tools"])])

# ───────────────────────── 8 Discord and Slack
def bridges():
    extra = ('<div class="sec"><span class="lbl">Last 24 hours</span><span>12 received · 12 delivered · 0 held</span></div>'
             '<div class="sec"><span class="lbl">Edit connection</span><span class="field">Token secret name: discord-bot-token</span><span class="field">Only channels (one per line)</span>'
             '<span class="sp__acts"><span class="mbtn">Save connection</span><span class="mbtn">Remove connection</span></span></div>')
    mock = split_mock("", [("Connections", 2, True), ("Person links", 1), ("Routes", 1), ("Pending sends", ""), ("Staged effects", "")], "Connections", 2, "New connection",
        [("art · discord", "Pond server · 12 received · 12 delivered · 0 held in 24 hours", "connected", True),
         ("art · slack", "Pond workspace · 3 received · 3 delivered · 0 held in 24 hours", "connected")],
        reader("connected", "art · discord", "Workspace: Pond server", [], [], extra),
        chips=["Connections 2", "Person links 1", "Routes 1", "Pending sends"])
    anat = anatomy("bridge_incoming · a message from outside", "Is the electrician booked for Friday?", [
        ("connection", "art's bot on Discord", "r", "Secrets", "The bot's token is a stored secret."),
        ("user, member", "an outside user, known to be jonathan", "l", "People and projects", "A person link says which household member an outside user is."),
        ("channel", "who answers here when nobody is addressed"),
        ("conversation", "cv-7c1d0e9a2b3f", "r", "Conversations", "The message goes into one conversation: the agent in that channel."),
        ("becomes", "one inbox item for the agent", "l", "Inbox", "It arrives in the inbox with discord or slack as its source."),
        ("bridge_sends", "the agent's reply, going out"),
        ("agent_people", "how much the agent does for this person", "r", "Machines and jobs", "An agent's run settings give each outside person a tier."),
    ])
    panels = [
        ("In", "amber", flow("pending", "matched", "delivered"),
         "A message from outside is kept as an incoming message, matched to a person and a channel rule, and passed into the right conversation. It can be held or dropped, with a reason."),
        ("Out", "pink", flow("pending", "sending", "sent"),
         "The agent's reply goes out as a send. Loom records whether it arrived. Uncertain means loom could not confirm it, and a person reviews it. A held send waits for a person to release or dismiss it."),
        ("Who answers", "violet", opts(("answers", "the agent that replies to messages addressed to nobody"), ("bots may talk", "whether bots may talk to each other here"), ("only / ignore", "channels a connection listens to or skips")),
         "A channel rule names the agent that answers in a channel. A connection can listen only to some channels, or ignore some."),
        ("Connections and files", "cyan", opts(("state", "connecting, connected, backoff, disconnected"), ("files", "Slack attachments, kept 14 days")),
         "A connection is one bot signed in to one Discord server or Slack workspace, speaking for one agent. Attachments fetched from Slack are kept for 14 days."),
    ]
    return app_page("Discord and Slack", "an app, called Bridges", "How agents talk to people in other apps.",
        "A connection is one bot signed in to one Discord server or Slack workspace, speaking for one agent.",
        ["Connects a bot to a server or workspace for one agent.", "Decides which agent answers in a channel when nobody is addressed.",
         "Links an outside user to the household member they are.", "Records whether each reply arrived, and says so when it cannot tell."],
        tile("amber", "bridges", "Bridges", mock), "The Bridges tile, drawn with example connections: folders, the list, and the connection that is open.",
        "How an outside message connects to other parts", "One incoming message, with a thread from each field that reaches another part.", anat,
        "Messages in, replies out, channel rules and connections", panels, [],
        [("Household things.", "Connections, channel rules and person links belong to the household. Household owners manage them and see them all."),
         ("An agent's owners.", "An agent's owners see their agent's connections."),
         ("Messages.", f"An incoming message follows the labels of the conversation it goes into. {OWNER}"),
         ("Checked at the door.", DOOR)],
        [("Connections and rules", ["bridge_connections", "bridge_channel_filters", "bridge_channels", "bridge_people"]),
         ("Messages", ["bridge_incoming", "bridge_sends", "bridge_files"])], ctl=True)

# ───────────────────────── 9 Secrets
def secrets():
    extra = ('<div class="sec"><span class="lbl">Who may use it</span><span>art · Granted · this job · No expiry</span><span class="checks"><span data-on>Always allow art when asked</span><span>Allow art at startup</span></span></div>'
             '<div class="sec"><span class="lbl">Recorded use</span><span>Nov 14, 9:15 AM · art · Delivered</span></div>'
             '<div class="sec"><span class="lbl">Replace github-token</span><span class="muted">The value is write-only. It cannot be read back here.</span><span class="sp__acts"><span class="mbtn">Save replacement</span></span></div>')
    mock = split_mock("Search Settings", [("Secrets", 2, True), ("Requests", 1), ("Grants", ""), ("Piece settings", "")], "Secrets", 2, "Add a secret",
        [("github-token", "Reads and merges pull requests", "", True), ("discord-bot-token", "The bot's sign-in for the Pond server", "Not changed in a year")],
        reader("secret", "github-token", "Reads and merges pull requests", [], [], extra),
        chips=["Secrets 2", "Requests 1", "Grants", "Piece settings"])
    anat = anatomy("q-1a2b3c4d · secret request", "art asks for github-token", [
        ("secret", "github-token <small>the name, never the value</small>"),
        ("agent, job", "art · the job that needs it", "r", "Machines and jobs", "A grant goes to one agent and can be limited to one job. Each use names the job."),
        ("conversation", "cv-1a2b3c4d5e6f", "l", "Conversations", "A request records the conversation it was asked in."),
        ("why, minutes", "To merge repo#12 · 30"),
        ("state", "pending", "r", "Inbox", "A pending request waits in a person's Inbox."),
        ("triggers.watches", "a once-only trigger on this answer", "l", "Tempo", "Work can wait on the request with a trigger that fires when it is answered."),
        ("token_secret", "a bot's token", "r", "Discord and Slack", "A connection's bot token is one of the stored secrets."),
    ])
    panels = [
        ("Ask, answer, grant", "amber", flow("pending", "allow", "allowed"),
         "An agent requests a secret with a reason and a length of time. A person answers, or a rule answers for them. A yes creates a grant that lasts a set time."),
        ("Rules", "violet", opts(("ask", "ask each time"), ("auto", "grant automatically"), ("never", "never grant")),
         "A rule is a standing answer for one secret, for the agents it lists. Answering always makes a rule. The household has a default for a secret with no rule of its own."),
        ("The key holder", "cyan", card("cyan", "A separate small program", "Values, encrypted, in a separate file", "Loom's main database holds only names and descriptions."),
         "A secret's value never sits in loom's main database. The app can set or replace a value and cannot read one back."),
        ("Every use written down", "pink", log(("secret_uses", "github-token to art, 9:15 AM, released"), ("secret_changes", "replace, by jonathan")),
         "Every time a value leaves the key holder, loom records which secret, for which agent and job, and when. Each time a value is set, replaced or removed is recorded too."),
    ]
    return app_page("Secrets", "a panel in Settings", "Credentials agents need, and who may use each one.",
        "A secret is a named credential, such as a GitHub token.",
        ["Keeps each value encrypted, in a separate file held by a separate small program.", "Lets an agent request a secret, and a person or a rule answer.",
         "Grants access for a set time, to one agent or to one job.", "Writes down every time a value is handed out."],
        tile("amber", "settings", "Settings", mock), "Secrets have no tile of their own. This is the Settings tile, where they live, drawn with example secrets.",
        "How a request for a secret connects to other parts", "One request, with a thread from each field that reaches another part.", anat,
        "Requests, rules, the key holder and the use record", panels, [],
        [("Owners manage them.", "Household owners manage Settings, which is where secrets, requests and grants are."),
         ("Values are never shown.", "A value is write-only. Nobody reads one back in the app."),
         ("Agents.", "An agent is handed a value only under a grant, and each hand-off is recorded."),
         ("Checked at the door.", DOOR)],
        [("", ["secrets", "secret_grants", "secret_requests", "secret_rules", "secret_rule_agents", "secret_uses", "secret_changes"])], ctl=True)

# ───────────────────────── 10 People and projects
def people():
    body = f'''<div class="tile__body sp sp--two">
      <div class="sp__list"><div class="sp__top"><b>Projects</b><em>2</em><span class="mbtn">New project</span></div>
        <div class="row" data-on><b>Pond</b><span>pond</span><em>2 members · 1 agents</em></div>
        <div class="row"><b>Loom</b><span>loom</span><em>1 members · 2 agents</em></div></div>
      <div class="sp__read"><span class="meta">pond</span><h4>Pond</h4>
        <div class="sec"><span class="lbl">Members</span><span class="checks"><span data-on>jonathan</span><span data-on>sam</span></span><span class="sp__acts"><span class="mbtn">Save members</span></span></div>
        <div class="sec"><span class="lbl">Agents</span><span class="checks"><span data-on>art</span><span>mark</span></span><span class="sp__acts"><span class="mbtn">Save agents</span></span></div></div>
    </div>'''
    anat = anatomy("the labels on a record", "Who sees it", [
        ("project", "the project's people see it", "r", "Changes", "A pull request gets its project from its repository."),
        ("agent", "the agent's owners see it", "l", "Conversations", "Every conversation belongs to one agent."),
        ("member", "private: that member plus household owners", "r", "Inbox", "An item can be for one member alone."),
        ("owner", "a member, an agent or the household", "l", "Tasks", "Every task has an owner. Without a project, its owner decides who sees it."),
        ("role = owner", "a household owner sees everything", "r", "Signing in", "A token says which member or agent is calling."),
        ("boxes.owner", "a member owns each machine", "l", "Machines and jobs", "A box's owner says which agents may run there."),
    ])
    panels = [
        ("Members and owners", "amber", opts(("owner", "household authority"), ("full owner", "owns every agent, present and future"), ("member", "access through projects and owned agents")),
         "A member is a person who can sign in. A household owner sees everything, including another member's private thread. Everyone else reaches things through their projects and the agents they own."),
        ("Agents", "violet", f'<div style="display:flex;gap:14px"><div class="agent" style="flex:1">{FACE_A}<div><b>Art</b><span>owned by jonathan</span></div></div><div class="agent" style="flex:1">{FACE_B}<div><b>Mark</b><span>owned by jonathan, sam</span></div></div></div>',
         "An agent is one of the household's assistants. A member owns any number of agents, and an agent can have more than one owner. Each agent has a short description of itself, badge colours and a drawn face."),
        ("Projects", "cyan", card("violet", "Project", "Pond", "members jonathan, sam · agent art · repository github:owner/repo"),
         "A project is the unit of sharing. Put a person and an agent on the same project and they can work together on it. A project also lists its code repositories."),
        ("Household and preferences", "pink", opts(("household", "default agent, time zone, how long words are kept, backups"), ("each member", "look, desk background, sound, motion, contrast")),
         "One row holds the household-wide settings. Each person has their own preferences for how loom looks and behaves."),
    ]
    return app_page("People and projects", "under every part", "Who is in the household, which agents they own, and which projects they share.",
        "Everything else in loom points back at these three: members, agents and projects.",
        ["Lists the members: people who can sign in.", "Lists the agents, and who owns each.", "Puts people and agents on projects so they can work together.", "Supplies the labels every other part uses to decide who sees what."],
        tile("violet", "sharing", "Sharing", body), "The Sharing tile, where people and agents are put on projects, drawn with example projects. Owners and members are set in Household setup, which is not drawn here.",
        "How the labels reach every other part", "The labels a record can carry, with a thread to a part that uses each.", anat,
        "Members, agents, projects and household settings", panels,
        [("project", "violet"), ("agent", "cyan"), ("member, when private", "pink")],
        [("The rule.", f"{OWNER} Anyone else sees what is in their projects, plus what belongs to agents they own."),
         ("Private.", PRIVATE),
         ("Tasks.", "A task with a project is seen by the project's people. A task without one is seen by its owner, and for an agent's task, by that agent's owners."),
         ("Checked at the door.", DOOR)],
        [("People and agents", ["members", "agents", "member_agents", "agent_accounts", "agent_sprites"]),
         ("Projects", ["projects", "project_members", "project_agents", "project_repositories"]),
         ("Household", ["household", "backup_recipients", "member_preferences"])], ctl=True)

# ───────────────────────── 11 Signing in
def signing():
    fig = '''<div class="panels">
      <div class="panel"><span class="lbl">The sign-in screen</span><h4>Sign in to loom</h4><span class="sp__acts"><span class="mbtn mbtn--on t-violet">Sign in with a passkey</span></span>
        <span class="muted">Have a one-time sign-in link? Open it and press Sign in.</span></div>
      <div class="panel"><span class="lbl">Your account</span><h4>jonathan</h4>
        <div class="sec"><span class="lbl">Passkeys</span><span><b>Laptop</b><br><span class="meta">Active · Added Oct 2 · Last used today</span></span><span class="sp__acts"><span class="mbtn">Add a passkey</span></span></div>
        <div class="sec"><span class="lbl">Signed-in browsers</span><span><b>Chrome on Mac</b><br><span class="meta">Signed in · Last used today</span></span><span class="sp__acts"><span class="mbtn">Sign out browser</span></span></div>
        <div class="sec"><span class="lbl">Notifications</span><span class="sp__acts"><span class="mbtn">Enable notifications on this browser</span></span></div>
        <span class="sp__acts"><span class="mbtn">Make sign-in link</span><span class="mbtn">Sign out this device</span></span></div>
    </div>'''
    anat = anatomy("token", "One credential", [
        ("kind", "owner, agent or runner"),
        ("member", "for a person's token: whose it is", "l", "People and projects", "A person's token names the member."),
        ("agent, job, box", "for a body or a machine", "r", "Machines and jobs", "An agent's body and each machine carry a token of their own."),
        ("sessions.token", "a signed-in browser stands for a token"),
        ("passkeys, signin_links", "each signs in as a token"),
        ("who is calling", "known for every request", "l", "How a tile gets its data", "The live connection runs each request as the caller it knows."),
        ("fingerprint", "loom stores a fingerprint, never the token"),
    ])
    panels = [
        ("Three kinds of caller", "violet", opts(("a person", "a browser session"), ("an agent's body", "a token of its own"), ("a machine", "a token of its own")),
         "Every caller from outside loom presents a token. A token belongs to one member, one agent or one machine. This is the one place loom checks identity."),
        ("Sessions", "pink", card("violet", "Session", "Chrome on Mac", "signed in with a passkey · stands for jonathan's token"),
         "A person's browser holds a session, which stands for one of their tokens. An agent driving a browser gets a session that lasts six hours."),
        ("Passkeys and links", "cyan", opts(("passkey", "registered once, used each time"), ("sign-in link", "works once, then expires")),
         "A person gets a session with a passkey or by opening a one-time sign-in link. A passkey's counter goes up with each use, so a lower number than last time means a copied key."),
        ("After that, labels", "amber", flow("token", "known caller", "labels"),
         "Once loom knows the caller, the labels on each record decide what it may see. Loom's own parts never present a token to each other."),
    ]
    return app_page("Signing in", "under every part", "How a person, an agent or a machine proves who it is.",
        "Loom checks identity in one place, at the door.",
        ["Signs a person in with a passkey or a one-time link.", "Gives each agent's body and each machine a token of its own.",
         "Lists your signed-in browsers and passkeys, and lets you end them.", "Sends notifications to the phones and browsers you turn on."],
        fig, "What a person sees: the sign-in screen and their account page, drawn with example content. Household owners also see tokens and sessions in Household setup.",
        "How a token connects to other parts", "One token, with a thread from each field that reaches another part.", anat,
        "Callers, sessions, passkeys and what happens next", panels, [],
        [("Your own.", "A person sees their own passkeys, signed-in browsers and notification devices, and can end each one."),
         ("Owners.", "Household owners see the household's tokens and sessions and can revoke them."),
         ("Never the token.", "Loom stores a one-way fingerprint of each token, session cookie and sign-in link.")],
        [("", ["tokens", "sessions", "signin_links", "passkeys", "notification_devices"])], ctl=True)

# ───────────────────────── 12 How a tile gets its data
def data():
    fig = f'''<div class="seq">
      <div class="seq__head"><span class="seq__who t-violet"><span class="key key--sm">T</span>A tile</span><span></span><span class="seq__who seq__who--loom">Loom</span></div>
      <div class="seq__row"><div class="seq__l"><b>1 · It sends a query</b><pre class="req">query {{
  tasks(
    where: {{ status: open, project: "pond" }}
  ) {{
    id
    title
    priority
    ownerKind
    owner
    commentCount
  }}
}}</pre></div><i class="wire t-violet"></i><div class="seq__r seq__r--empty"></div></div>
      <div class="seq__row"><div class="seq__l seq__l--empty"></div><span></span><div class="seq__r"><b>2 · One query</b><span>Loom knows who is asking. It uses a fixed small number of sane SQL statements, independent of row count, with filtering and visibility checked in the database.</span></div></div>
      <div class="seq__row"><div class="seq__l"><b>3 · Rows</b><span>The tile draws the rows it was sent.</span></div><i class="wire wire--back t-cyan"></i><div class="seq__r seq__r--empty"></div></div>
      <div class="seq__row"><div class="seq__l"><b>4 · Then only changes</b><span>Changes arrive as a subscription. The tile updates in place.</span></div><i class="wire wire--back t-cyan"></i><div class="seq__r"><b>Something changes</b><span>Loom sends that change to every tile whose request it matches.</span></div></div>
    </div>'''
    anat = anatomy("one query", "The Tasks tile asks for open tasks", [
        ("tasks", "the fields it named", "r", "Tasks", "A query names a table from the model and the fields it wants. Any app's tile asks the same way."),
        ("who is asking", "the signed-in caller", "l", "Signing in", "The connection knows the caller from its session or token."),
        ("where", "open, in the pond project"),
        ("visibility", "checked inside the query", "r", "People and projects", "The labels on each row decide whether this caller gets it."),
        ("commentCount", "a connected thing, joined in"),
        ("changes", "sent as they happen", "l", "Inbox", "A new inbox item reaches an open Inbox tile as a change."),
    ])
    panels = [
        ("One definition", "cyan", flow("schema", "generates", "endpoint"),
         "The endpoint is generated from the same Drizzle schema as the tables, so there is one definition of the data and no hand-written reads. GraphQL is a widely used standard with ready-made tools on both ends."),
        ("One query", "violet", gate("Filter on real columns", "Join the connected tables", "Apply the caller's visibility", "Sort"),
         "Loom handles the request in one API call using a fixed small number of sane SQL statements, independent of the number of rows. Several batched statements are fine. Filtering and visibility checks happen in the database."),
        ("Only changes", "pink", flow("rows", "then", "changes"),
         "After the first rows, changes arrive as subscriptions over the websocket. A tile never asks again for what it already has."),
        ("One schema", "amber", card("amber", "Defined once", "Drizzle on SQLite", "Moving to another database later is a configuration change."),
         "The tables on every page of this site are one schema, defined once. A query is written against that schema, so nothing is stored as a bundle the database cannot look inside."),
    ]
    plumb = "".join(f"<li><code>{e(n)}</code><span>{e(t)}</span></li>" for n, t in PLUMBING)
    return app_page("How a tile gets its data", "under every part", "One GraphQL endpoint, generated from the same schema as the database.",
        "A tile sends a query naming exactly the fields and connected things it wants, gets the rows, then receives changes as subscriptions over the websocket.",
        ["There is one definition of the data, and no hand-written reads.", "A tile names exactly the fields and connected things it wants.",
         "A page reads with one API call, backed by a fixed small number of SQL statements that does not grow with the number of rows, with visibility checked for whoever is asking.", "After the first rows, loom sends only what changed."],
        fig, "The sequence between a tile and loom, with one query: the open tasks in a project, with their owner and comment count.",
        "How a query connects to other parts", "One query, with a thread from each part of it that reaches another page.", anat,
        "One definition, one query, changes and the schema", panels, [],
        [("Checked in the query.", "The visibility check runs inside the query, for whoever is asking. A caller never receives a row it may not see, or that row's changes."),
         ("The rule.", f"{OWNER} Anyone else sees what is in their projects, plus what belongs to agents they own. {PRIVATE}"),
         ("Installed means trusted.", "The check is for callers from outside. Loom's own parts never ask each other for permission.")],
        [], ref_extra=f'<p class="muted">This page has no tables of its own. These are the things loom keeps that no screen reads.</p><ul class="plumb">{plumb}</ul>')

# ───────────────────────── The desk
def desk():
    anat = anatomy("the desk", "Loom on a desktop screen, 1024 px and wider", [
        ("tiles", "two to six, by screen width", "r", "How a tile gets its data", "Each tile asks for its rows over the one live connection."),
        ("agent rail", "face, name, state, what it asks you", "l", "Machines and jobs", "A rail card lists the agent's current jobs."),
        ("Needs you", "the first waiting item, and how many more", "r", "Inbox", "The count comes from the items waiting in your inbox."),
        ("ticker", "agents, tasks, tempo, bridges, changes, boxes", "l", "Tasks", "The ticker reads counts from each part, such as tasks in progress and ready."),
        ("Home", "one card for each agent you own", "r", "Conversations", "Home shows each agent's last answer and recent conversations, with a box to message it."),
        ("look", "chosen by each person", "l", "People and projects", "Each member keeps their own look and switches."),
    ])
    panels = [
        ("Tiling", "pink", opts(("under 1280 px", "2 tiles"), ("from 1280", "3 tiles"), ("from 1600", "4 tiles"), ("from 2560", "6 tiles")),
         "The first tile takes the big slot. The others share the space beside it on a wide screen, or below it on a tall one. When one more will not fit, the least recently used tile goes to the dock. A tile can be made the big one, minimized to the dock, or closed."),
        ("Launcher and dock", "violet", card("violet", "Apps", "Type to find an app", "Work · People &amp; agents · Library · System · Look &amp; feel · Pieces"),
         "The launcher lists every app in groups and finds one as you type. Enter opens the first match. Every installed app also stays within reach in the dock."),
        ("Faces", "cyan", f'<div style="display:flex;gap:14px"><div class="agent" style="flex:1">{FACE_A}<div><b>Art</b><i>working</i></div></div><div class="agent" style="flex:1">{FACE_B}<div><b>Mark</b><i class="idle">quiet</i></div></div></div>',
         "Each agent has a drawn face: one of four shapes (pebble, trefoil, clover, drop) with dot or oval eyes. Its expression is its state: quiet, thinking, working, waiting on you, done, needs a look, talking."),
        ("Looks", "amber", opts(("Neon Noir", "loud and lit"), ("Low Light", "the same, calmer"), ("Daylight", "light")),
         "A look is a set of colours and type over one structure. A person also picks the desk background (depth, contours or wash), reduced motion, higher contrast, and one window at a time."),
    ]
    return app_page("The desk", "the shell", "The desk is loom on a desktop screen.",
        "App tiles side by side, the agents on a rail, a ticker along the top and a dock along the bottom.",
        ["Places tiles by one rule, so the desk is full and nothing overlaps.", "Keeps every installed app within reach in the launcher and the dock.",
         "Shows each agent's face, its state and what it is doing.", "Wears one of three looks: Neon Noir, Low Light or Daylight."],
        desk_html(), "The desk, drawn small with example content: three tiles, the agent rail on the right, the ticker in the top bar, the dock below.",
        "How the desk connects to other parts", "The things on the desk, with a thread from each to the part that feeds it.", anat,
        "Tiling, the launcher, faces and looks", panels, [],
        [("What you may see.", "The desk shows each person only what they may see. Every tile gets its rows through the same visibility check."),
         ("Your own look.", "The look, the desk background and the switches belong to each member."),
         ("The phone.", "The phone does what the desk does, built after the desk is right.")],
        [("", ["member_preferences", "agent_status", "agent_sprites"])], ctl=True)

# ───────────────────────── Memory
def memory():
    mock = split_mock("Search knowledge", [("All pages", 12, True), ("Recently verified", 3), ("Due a check", 1), "Topics", ("household", 8), ("pond", 4)], "All pages", 12, "Add a fact",
        [("The pond pump takes a 25 mm hose", "verified Nov 12 · pond", "Fresh", True),
         ("The electrician works Fridays", "written Oct 30 · household", "Getting old"),
         ("The winter checklist is in the pond repository", "verified Oct 1 · pond", "Due a check")],
        reader("pond", "The pond pump takes a 25 mm hose", "Fresh · Pages are re-checked every 30 days", ["Still true", "Check again"],
               [("Sources", "Pond pump thread, Nov 12"), ("Cited by", "1 page"), ("Written by", "art")]),
        chips=["All pages 12", "Recently verified 3", "Due a check 1"])
    anat = anatomy("one memory · category user", "Jonathan wants the cheaper pump only if it fits the hose", [
        ("agent", "kept in art's own files", "l", "People and projects", "A memory belongs to one agent. The agent, its owners and household owners see it."),
        ("category", "user, project, self, feedback, reference, pursuit, episode"),
        ("episode", "where, what, and what is open", "r", "Conversations", "A session leaves a short note for the next one. Activity builds each day from them."),
        ("person card", "what art knows about jonathan"),
        ("activity", "the tasks and pull requests a conversation touched", "l", "Tasks", "Activity lists the tasks and pull requests each conversation touched."),
        ("salience", "hot, warm or cool"),
        ("history", "the newest ten versions"),
    ])
    panels = [
        ("What an agent keeps", "cyan", opts(("memories", "in seven categories"), ("knowledge pages", "facts, with their sources"), ("people cards", "what it knows about a person"),
                                             ("project cards", "a project's card"), ("notes", "working documents, kept by path"), ("identity", "its creed, preferences and self-model")),
         "Memories, notes, people cards, project cards and identity live in each agent's own folder. Knowledge pages and the people directory are shared by the household. Identity also holds a page for each harness, model, role and project the agent works in, loaded when asked for, and a summary of what its other bodies did in the last 24 hours."),
        ("Top of mind", "pink", opts(("hot", "used or written lately"), ("warm", "cooling"), ("cool", "not used in a while")),
         "Each memory has a temperature. Writing it heats it fully, recalling it adds heat, and it cools with time: an episode within a day, what an agent knows about a person over months. The hottest fill the agent's top of mind. Recall finds memories by meaning. A memory can be given a time to live, and is archived when that runs out. A lesson the agent was taught can be confirmed or contradicted later, which raises or lowers how much it is trusted."),
        ("Notes", "cyan", opts(("keep", "until removed"), ("while", "60 days after its last change"), ("short", "14 days after its last change")),
         "A memory is a fact. A note is a document: a handoff, a review, a pile of evidence. A note is kept by path, written whole, and read by asking for it by name. It is never recalled by meaning and never fills the top of mind. A memory usually says a note exists and where. Each note has a lifespan, and a change restarts it."),
        ("Changing a memory", "violet", log(("propose", "a draft recall cannot see"), ("ratify", "the draft becomes real"), ("archive", "set aside, can be restored"), ("forget", "deleted, and the deletion recorded")),
         "A change saves the earlier version first. Loom keeps the newest ten versions of each memory, knowledge page and person card, and any of them can be restored."),
        ("Knowledge", "amber", opts(("Fresh", ""), ("Getting old", ""), ("Due a check", "")),
         "A knowledge page is a fact about the world that says where it came from. Without a source it stays provisional. Pages are re-checked every 30 days."),
    ]
    files = ('<p class="muted">Memory is not in loom\'s database. It lives in files, and it is the one kind of data loom treats as precious.</p><ul class="plumb">'
             "<li><code>each agent's folder</code><span>Its memories and their history, drafts awaiting ratification, its notes and their earlier versions, people cards, project cards, and its identity files.</span></li>"
             "<li><code>shared by the household</code><span>Knowledge pages and the people directory.</span></li></ul>")
    return app_page("Memory", "two apps and each agent's own files", "What an agent remembers and knows.",
        "Memories, notes, knowledge pages, people cards and project cards. Memories are the one kind of data loom treats as precious. Notes come second.",
        ["Keeps each agent's memories in that agent's own files.", "Recalls by meaning, and keeps what is used most at the top of mind.",
         "Keeps notes: longer working documents, by path, each with a lifespan.",
         "Keeps knowledge pages with where each fact came from, and re-checks them.", "Shows what happened each day in Activity."],
        tile("cyan", "knowledge", "Knowledge", mock), "The Knowledge tile, drawn with example pages: folders, the list, and the page that is open. People, Projects and Activity are tiles of their own.",
        "How a memory connects to other parts", "One memory, with a thread from each part of it that reaches another page.", anat,
        "What is kept, top of mind, notes, changes and knowledge", panels,
        [("agent", "cyan")],
        [("Memories, notes and cards.", "The agent itself, the agent's owners, and household owners. Being on a project together does not open an agent's memories or notes."),
         ("Knowledge.", "Knowledge pages are shared by the household. Household owners and household agents can read and write them, including agents in terminal sessions without a job. Non-owner members cannot."),
         ("Precious.", "Agents' memories are the only data loom treats as precious."),
         ("Notes come second.", "Every backup and every move to a new home carries all of an agent's notes, whatever their lifespan. They are not on a par with memories: a note still ends when its lifespan does.")],
        [], ref_extra=files)

# ───────────────────────── Models and accounts
def models():
    fig = '''<div class="panels">
      <div class="panel t-cyan"><span class="lbl">What its owner and household owners see</span><h4>Main subscription</h4><span class="meta">owner jonathan · one provider</span>
        <div class="sec"><span class="lbl">Usage</span><ul class="bars"><li style="grid-template-columns:minmax(0,1fr) 44px"><i style="--w:58%"></i><span>58%</span></li></ul><span class="meta">read 9:10 AM · resets Thu</span></div>
        <div class="sec"><span class="lbl">Signed in on</span><span>attic · workshop</span></div>
        <div class="sec"><span class="lbl">Has room</span><span>yes</span></div></div>
      <div class="panel t-amber"><span class="lbl">What anyone else sees</span><h4>Main subscription</h4>
        <div class="sec"><span class="lbl">Level</span><span><span class="chip">getting full</span></span><span class="meta">one of: plenty, getting full, almost full</span></div></div>
      <div class="panel t-violet"><span class="lbl">Art's models, in order</span><h4>Allowed and preferred</h4>
        <div class="sec"><span class="lbl">1</span><span>its preferred model</span></div><div class="sec"><span class="lbl">2</span><span>the next it may use</span></div></div>
    </div>'''
    anat = anatomy("one job", "Reply in Pond pump", [
        ("agent_models", "art's models, in order", "l", "People and projects", "Each agent has a list of the models it may use, in order of preference. A member owns each account."),
        ("model", "the model this job was asked to use"),
        ("model_accounts", "the subscription it draws from", "r", "Machines and jobs", "An account is signed in on particular worker machines."),
        ("runner", "the program that starts the body", "l", "Signing in", "A runner's token names its machine. It sees and reports only the jobs assigned to it."),
        ("turns.model", "the model behind each turn", "r", "Conversations", "Each of an agent's turns records the model that produced it."),
    ])
    panels = [
        ("Per agent, per account", "cyan", opts(("model", "chosen per agent"), ("capacity", "shared per account and window")),
         "The primary conversational model is per agent. Capacity is shared per actual subscription, account and window, so two agents on one account draw down the same allowance."),
        ("Quota", "amber", card("amber", "Fuel", "58% of the week", "resets Thu"),
         "An account's use is counted in windows that reset, such as five hours and seven days. A reserve of about five percent is the starting point. It can be lent near a reset when the forecast is safe, and is not a rigid floor."),
        ("Harnesses", "violet", opts(("claude", ""), ("codex", "")),
         "A harness is the program a model runs in, such as Claude Code or Codex. A worker starts each body in the harness its model needs; in a house, loom's own body program starts it. Loom keeps models, series, providers and harnesses distinct, and roles can be added through configuration."),
        ("Signing in to an account", "pink", card("pink", "Kept apart", "A separate private program", "The runtime calls it as a configured command."),
         "Signing in to a model account is handled by a separate private program. The runtime handles which account, which harness and which model a body uses."),
    ]
    return app_page("Models and accounts", "part of the runtime", "Which model a body runs on, and the accounts it draws from.",
        "The runtime handles model accounts, harnesses and which model a body uses.",
        ["Gives each agent a primary conversational model.", "Shares each account's capacity across the agents that draw on it.",
         "Starts each body in its model's harness, on a worker machine.", "Records the model each job asked for and each turn used."],
        fig, "One account seen two ways, with example content: its owner and household owners see everything, anyone else sees the label and a coarse level. On the right, an agent's models in order.",
        "How a model choice connects to other parts", "One job, with a thread from each part of it that reaches another page.", anat,
        "Models, quota, harnesses and account sign-in", panels,
        [("owner", "cyan")],
        [("The owner and household owners.", "They see everything about an account: usage, when it resets, and where it is signed in."),
         ("Anyone else.", "They see only the account's label and a coarse level: plenty, getting full, or almost full."),
         ("Checked at the door.", DOOR)],
        [("", ["model_accounts", "model_account_boxes", "account_signins", "agent_models"])])

# ───────────────────────── Outside programs
def outside():
    def caller(tint, k, name, text):
        return f'<li class="node t-{tint}"><span class="key key--sm" aria-hidden="true">{k}</span><div class="node__body"><b>{name}</b><span>{text}</span></div><i class="wire"></i></li>'
    fig = f'''<div class="map map--door">
      <div class="map__col"><h3>Who calls</h3><ul>
        {caller("pink", "cli", "The command line", "a client with a token")}
        {caller("violet", "web", "The web app", "a signed-in browser")}
        {caller("cyan", "a", "An agent's body", "a token that is one agent")}
        {caller("cyan", "r", "A runner", "a token for one machine")}
        {caller("amber", "p", "Someone's own program", "what an owner granted it")}
        {caller("amber", "ph", "The phone", "a caller like any other")}
      </ul></div>
      <div class="core"><span class="core__tag">The one door</span><h3>The API</h3>
        <ol class="stages"><li><i>1</i><div><b>A token</b><span>Says who is calling.</span></div></li>
        <li><i>2</i><div><b>One permission check</b><span>The same for every caller from outside.</span></div></li>
        <li><i>3</i><div><b>The same operations</b><span>The page, the command line and agents call the same ones.</span></div></li></ol></div>
    </div>'''
    anat = anatomy("one call", "Create a task, from the command line", [
        ("token", "says who is calling", "l", "Signing in", "A token belongs to one member, one agent or one machine."),
        ("operation", "the same one the web app uses", "r", "Tasks", "Every part's operations are reached the same way."),
        ("permission", "checked here, for callers from outside", "l", "People and projects", "The labels on each record decide what this caller may reach."),
        ("granted", "the record types and operations an owner allowed"),
        ("live data", "one of the API's doors", "r", "How a tile gets its data", "The live connection is how a caller gets rows and then changes."),
        ("a runner", "sees only its own jobs", "l", "Machines and jobs", "A runner sees and reports only the jobs assigned to it."),
    ])
    panels = [
        ("Narrow tokens", "amber", opts(("a member", "what that person may see"), ("an agent", "a token that is one agent"), ("a runner", "only the jobs assigned to it"), ("a program", "only what an owner granted")),
         "Anything outside loom calls the API with a token. Someone else's program is a caller with a token: it sees only the record types and operations a household owner granted it."),
        ("One program, one data folder", "pink", card("pink", "Install", "npm install -g @jbarket/loomai", "then loom serve"),
         "There is one loom per home: one program and one data folder. Loom itself needs nothing beyond Node and npm. A machine whose worker runs houses also needs git and a container engine. A restart is an acceptable deploy."),
        ("Parts can be replaced", "violet", flow("tasks role", "filled by", "one module"),
         "Each part is a module with a declared, typed interface. A role has one implementation at a time, so replacing the task store means writing another module that fills the tasks role. A bridge is replaced the same way."),
        ("The phone", "cyan", card("cyan", "After the desk", "The phone", "calls the same API"),
         "The phone does what the desk does, built after the desk is right. It is a caller like any other."),
    ]
    return app_page("Outside programs", "the one door", "An outside program has one door: the API, with a token.",
        "The command line, the web app, agents and anything outside loom call the same operations through the same permission check.",
        ["One API for the command line, the web app and agents.", "A token says who is calling and what it may reach.",
         "Someone else's program sees only what a household owner granted it.", "The phone and any other interface are callers like any other."],
        fig, "A picture of the one door: every caller presents a token to the same API.",
        "How a call connects to other parts", "One call, with a thread from each part of it that reaches another page.", anat,
        "Tokens, one program, replaceable parts and the phone", panels, [],
        [("Checked here.", "Permission is checked where something outside calls the API, and nowhere else."),
         ("Installed means trusted.", "Loom's own parts never ask each other for permission."),
         ("The rule.", f"{OWNER} Anyone else sees what is in their projects, plus what belongs to agents they own. {PRIVATE}")],
        [("", ["tokens"])])

# ───────────────────────── Tools for agents
def tools():
    def row(text, how_):
        return f'<li><p>{text}</p><span class="at">{how_}</span></li>'
    G = "the general tools"
    parts = [
        ("Memory", "cyan", [
            row("Load its identity: creed, preferences and top of mind, and on request its self-model, the last 24 hours, and the pages for its harness, model, role and project.", "identity"),
            row("Save a memory, find memories by meaning, edit one, delete one.", "remember · recall · update · forget"),
            row("See recent activity across its bodies.", "episodes"),
            row("Write a note, read one by path, list notes under a prefix.", "note_write · note_read · note_list"),
            row("Search knowledge pages, read one, and add one.", "knowledge_recall · knowledge_read · knowledge_write"),
            row("Change a knowledge page, mark it still true or due a check, and restore an earlier version of it.", "knowledge_edit · knowledge_check · knowledge_restore"),
            row("Draft a memory and ratify it. Archive a memory, restore it, or bring back an earlier version.", "memory_propose · memory_drafts · memory_ratify · memory_archive · memory_restore · memory_history"),
            row("Read and write its cards on people and on projects, by slug, or list them.", "person · person_write · project · project_write"),
        ]),
        ("Conversations and inbox", "pink", [
            row("Reply, show a progress card, report what it is doing, and title the conversation.", G + ", with a job"),
            row("Write a digest, with a question for a person when it needs one.", G + ", with a job"),
            row("Hand a piece of work to another agent.", G + ", with a job"),
            row("Read the items addressed to it.", "inbox"),
            row("Confirm each item it has dealt with.", G + ", with a job"),
        ]),
        ("Work", "violet", [
            row("Tasks: see what is ready, read one, create, edit, move to another project, claim or hand back, comment, close or reopen.", "task_ready · task · task_create · task_edit · task_move_to_project · task_claim · task_comment · task_close"),
            row("Tasks: move one in the hand-kept order, put one under a parent or behind a blocker, and put a question to a person.", G),
            row("Approvals: ask permission for a merge or a command. Withdraw the request, use an allowance once, or report a step taken under a tell-me-after rule.", G + ", with a job"),
            row("Propose a dangerous action for a person to allow and confirm: revoking a token, revoking a machine, signing out a browser, merging one project into another. Loom carries it out.", "propose"),
            row("Ask to be let onto a project it is not on. A household owner answers each such card; no standing rule does.", "propose"),
            row("Propose that a project be retired, or revived. A retired project keeps everything; its unfinished tasks are shelved, not work, until it is revived.", "propose"),
            row("See the approvals it may see, and which are still waiting.", "approvals"),
            row("Changes: read pull requests and who each is waiting on. Merge under an approval.", G),
            row("Tempo: set a trigger, stop it, or run it now.", G),
            row("Discord and Slack: reply to an incoming message.", G + ", with a job"),
            row("Discord and Slack: read the attachments a message carried.", G),
            row("Secrets: request one with a reason and a length of time, and check on the request.", G),
        ]),
        ("Settings and reads", "amber", [
            row("Propose a change to any setting a person can change: tempo timings, a bridge, a secret's rule, a machine, how an agent runs, its models, measuring, people and projects, a standing approval rule, how an agent treats outside people, the household's own settings. A person allows it.", "propose"),
            row("Read anything it may see, naming the fields it wants: tasks, conversations, the inbox, approvals, changes, triggers, machines, models, the measuring store.", "loom_query"),
        ]),
    ]
    secs = "".join(f'<section class="t-{t}"><h2>{e(g)}</h2><ul>{"".join(items)}</ul></section>' for g, t, items in parts)
    panels = [
        ("Named tools", "cyan", opts(("identity", "who the agent is"), ("remember, recall", "its memories"), ("task_ready, task_claim", "the work queue")),
         "What an agent does often has a tool with a plain name. Each named tool maps to one operation or one read, so a tool that works means the operation under it works."),
        ("Three general tools", "violet", opts(("loom_commands", "lists the operations and what each takes"), ("loom_command", "calls one"), ("loom_query", "reads through the data endpoint")),
         "Everything else on these pages is reached with three general tools. Nothing an agent may do is out of reach for want of a named tool."),
        ("With a job, or without", "pink", opts(("a body with a job", "works in one conversation"), ("a terminal session", "no job and no conversation")),
         "A body that loom started carries a token for one job and works in that job's conversation. A terminal session carries the agent's own token and has no job. It has memory, notes, knowledge, tasks and every read, and no conversation to reply in. When it proposes something, the card it files is where a conversation about it can begin."),
        ("What it will not do", "amber", log(("credentials", "made by a person, never through a tool"), ("settings", "proposed, then allowed by a person"), ("secret values", "handed over only under a grant")),
         "Three things stay out. An agent cannot make a token, a sign-in link or a passkey. It cannot change a setting directly: it proposes the change and a person allows it. It is handed a secret's value only under a grant."),
    ]
    idx = NUM["Tools for agents"]
    body = f'''
<section class="hero2">
  <div class="hero2__text t-cyan">
    <div><p class="eyebrow">Page {idx} of {N} · the door, for agents</p><h1>Tools for agents</h1>
    <p class="lead"><b>An agent reaches loom through MCP, with its own token.</b> Its tools call the same operations as the web app and the command line, through the same permission check.</p></div>
    <p class="lead">{sum(len(i) for _, _, i in parts)} things an agent can do, in {len(parts)} groups. Each names the tool that does it.</p>
  </div>
</section>

<section class="band" aria-labelledby="how-h">
  <div class="band__head"><span class="tag">How it works</span><h2 id="how-h">Named tools, general tools, jobs and limits</h2><p></p></div>
  {how(panels)}
</section>
<div class="dec">{secs}</div>
{foot(idx)}
'''
    return page(idx, "Tools for agents · loom", body)

# ───────────────────────── Houses (beside Machines and jobs; proposed, not yet on the guided path)
HOUSEFILE = """# The house of the agent Fern: the image a body of hers runs in.
# A loom worker builds it from this repository at one commit, on the core house loom provides.
# The worker hands every build the core house's image under this name.
ARG LOOM_CORE
FROM ${LOOM_CORE}

# Furniture: what this agent wants beyond the core. The core already has the system, git, Node,
# Claude Code and Codex, the home at /home/agent, a body file for each harness, and both labels.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \\
 && rm -rf /var/lib/apt/lists/* \\
 && git config --global user.name "Fern"

# This repository's own files, at the place every house keeps its repository. A body starts there.
COPY . /home/agent/repo"""
BODYFILE = """{"command": "/usr/local/bin/claude", "cwd": "/home/agent/repo", "reach": "all"}"""

def houses():
    idx = NUM["Machines and jobs"]
    def row(text, at):
        return f'<li><p>{text}</p><span class="at">{at}</span></li>'
    def group(title, tint, items):
        return f'<section class="t-{tint}"><h2>{e(title)}</h2><ul>{"".join(items)}</ul></section>'
    def band(tag, hid, title, intro, inner):
        return f'<section class="band" aria-labelledby="{hid}"><div class="band__head"><span class="tag">{tag}</span><h2 id="{hid}">{title}</h2><p>{intro}</p></div>{inner}</section>'

    what = how([
        ("A container for a body", "cyan", flow("job", "starts", "container", "from", "house image"),
         "A body is one run of an agent on a machine. It runs in a container, and the image that container is made from is the agent's house. The house holds what the agent works with: its harnesses (a harness is the program a model runs in, such as Claude Code or Codex), its tools, and its own repository."),
        ("One worker, any agent", "violet", gate("A container engine", "git", "The loom worker, signed in to loom"),
         "A worker runs any agent's house. Nothing is installed or configured on the machine for an agent: once a machine has a worker that loom knows, any agent allowed to run there can be sent to it, and its house is built there the first time it is needed. What a machine does hold is model sign-ins, which belong to accounts and not to agents."),
        ("A core house, and the agent's furniture", "pink", opts(("loom", "provides the core house"), ("the Housefile", "adds the agent's own things"), ("no Housefile", "the core house and the repository")),
         "Loom provides a core house: the system, the basic tools and the harnesses, laid out the same for every agent. An agent's own repository adds to it with one file, called a Housefile, which is an ordinary container build file. An agent that names no Housefile lives in the core house with its repository copied in."),
    ])

    named = '<div class="dec">' + group("An agent's run settings name its house", "amber", [
        row("<b>Repository.</b> The address of the git repository that holds the Housefile. It must be an <code>https://</code> address.", "set by the agent's owners"),
        row("<b>Housefile.</b> The file's path inside the repository, for example <code>Housefile</code> or <code>house/Housefile</code>. Left empty, the agent has no Housefile: it runs in the core house with its repository copied in, and a card that proposes this says so in words.", "set by the agent's owners · may be empty"),
        row("<b>Branch.</b> The branch to build. Each job builds the commit that branch is at when the job starts.", "set by the agent's owners"),
        row("<b>Repository secret.</b> For a private repository: the stored secret that fetches it. Left empty for a public one.", "a stored secret, named here"),
        row("<b>Startup secrets.</b> Stored secrets a body is handed when it starts, each under an alias. The alias is the name of the environment variable the body finds it in.", "a stored secret and an alias, each"),
    ]) + group("Who decides", "pink", [
        row("An agent's owners set its run settings. An agent can propose a change to its own; a person allows it before it takes effect.", f'{plink("People and projects")} · {plink("Tools for agents")}'),
        row("A secret named here is still a stored secret: who may use it, and whether a person is asked first, is decided by its own rule.", plink("Secrets")),
        row("A job keeps the repository, Housefile and branch its agent had when the job was admitted. Changing the settings does not change a job already waiting.", plink("Machines and jobs")),
    ]) + '</div>'

    housefile = f"""<div class="two"><pre class="req">{e(HOUSEFILE)}</pre>
<p class="note">A complete Housefile. Everything loom needs of a house comes with the core, the body files among them. A body file is one line, such as <code>{e(BODYFILE)}</code>: the harness program in the image, the directory it starts in, and <code>reach</code>, which is <code>loom</code> for loom's own tools only or <code>all</code> for the harness's own tools as well (files, a shell, the web). A Housefile may put its own body file over the core's. One that does not start from the core still works, when its image has the labels and the layout below by itself.</p></div>
<div class="dec">""" + group("What the image must say", "cyan", [
        row("<code>loom.house</code> is the version of this agreement between a house and loom, and of the layout beside it. It is <code>2</code>. An image that says <code>1</code> is refused.", "a label"),
        row("<code>loom.house.harnesses</code> names the harnesses the house serves, with a space between: <code>claude</code>, <code>codex</code>, <code>agy</code>. It is the one thing houses differ in that loom must know before it starts a body.", "a label"),
        row("An environment. A body runs with the image's <code>ENV</code>, and as the image's <code>USER</code>. Loom sets two variables of its own: the home, and the body's scratch directory. The image's <code>WORKDIR</code> is not read.", "ENV · USER"),
    ]) + group("Where things are in every house", "violet", [
        row("<b>The home</b> is <code>/home/agent</code>. No path in a house is named for its agent: who lives there is the repository it was built from. Loom sets <code>HOME</code> to it when a body starts.", "/home/agent"),
        row("<b>The agent's repository</b> is at <code>/home/agent/repo</code>. Every body starts in that directory.", "/home/agent/repo"),
        row("<b>Node</b> is at <code>/usr/local/bin/node</code>, Node 22 or later. Loom's body program is run with it. The core house has it.", "/usr/local/bin/node"),
        row("<b>A harness's body file</b> is at <code>/etc/loom/body/&lt;harness&gt;.json</code>, one for each harness the house serves.", "/etc/loom/body"),
        row("<b>An account's sign-in</b> appears at <code>/run/loom/login/&lt;harness&gt;</code> when a body starts. The core house points Claude Code and Codex there.", "/run/loom/login"),
        row("<b>The user.</b> The core house names none, so a body in it runs as the container's root. On a machine whose engine runs without root, that is the worker's own user outside the container, the one that can write the mounted sign-in.", "root inside the container"),
        row("A repository must not assume its own name in a path, a home other than <code>$HOME</code>, or a user of some name. A house that wants an older path makes a link to the fixed one.", "the same on every machine"),
    ]) + group("What the image must not hold", "amber", [
        row("A copy of loom. Loom mounts its own body program into every container at <code>/opt/loom</code>, so the image must keep nothing there.", "nothing at /opt/loom"),
        row("A declared volume. Loom checks that a container has exactly the storage it asked for, and an image that declares a <code>VOLUME</code> is refused.", "no VOLUME"),
        row("A credential. A sign-in, a token or a key in an image is in every copy of that image. A body gets its model sign-in and its secrets when it starts, from outside the image.", "nothing secret"),
        row("Anything that is not in the repository, in the core house or at a public address. The build is given the repository's files and the core house's name, and nothing else: no secret, no file of the machine.", "builds from the repository and the core"),
    ]) + '</div>'

    steps = how([
        ("1 · Fetch", "cyan", log(("https only", "no ssh, no path, no plain http"), ("no user settings", "none of the machine user's git configuration or credentials"), ("one commit", "the branch as it is now")),
         "The worker fetches the branch with the machine's git, into a copy of the repository it keeps for itself. Git is used to store and hand back the repository's objects, and nothing more: it runs with none of the machine user's settings, takes no address but an https one, and is not asked to check out, inspect or run anything. The reason is that whoever may set an agent's house chooses the address, and must not thereby borrow the machine user's access or have a program started. A repository secret is given to that one fetch and kept nowhere."),
        ("2 · The files of the commit", "violet", log(("goes in", "every file, byte for byte; links as links"), ("left out", "submodules"), ("refused", "over 100 MiB a file, 1 GiB in all, 50,000 files")),
         "The worker writes the build's input itself: every file of the commit, byte for byte, with whether it is executable, and every symbolic link as a link. Nothing in the repository changes what goes in: files that tell git to leave things out, substitute text or convert line endings are ordinary files here. A submodule is left out. A commit past the limits, or with a file name that could land outside the build (an absolute name, a name with <code>..</code> in it, one name twice), fails the job before anything is sent."),
        ("3 · Build", "pink", flow("core house", "then", "the Housefile", "builds", "image"),
         "The machine's container engine builds the Housefile, on the core house. The worker builds the core house first when the machine does not have it: from a definition that comes with loom, never from an image someone published, so a machine whose worker was installed a moment ago needs nothing else. The core's build counts toward the same limit. A build has 30 minutes unless the machine's configuration says otherwise, and 60 at most; a job still waiting then fails, saying the build ran out of time. While a house builds, the worker goes on telling loom the job is alive, so a long build does not lose the job. Before there was a core house, a first build of a house with the same tools from a bare base image took about ten minutes on a small machine and made an image of about 1.5 GB. The core house has been built once on a machine, on 2026-11-17 through rootless Podman 5.4.2: an image of 1.29 GB with Node 24.18.1, Claude Code 2.1.326 and Codex 0.164.0, on which a house with no Housefile was built and a body started. No harness has yet signed in or called a model from it."),
        ("4 · Found again", "amber", opts(("the same commit", "the image is reused"), ("a new commit", "built, reusing unchanged steps"), ("a new week", "built again, once")),
         "An image is named for its repository, its Housefile, its commit and the core house it was built on. The next job at the same commit finds the image and starts at once. A new commit is built, and the engine reuses the steps that did not change. The core house is built again once in each new week, which keeps its system current, and when a new loom changes its definition; each house is then built again on its next job. A job that already has its image is never interrupted for this. No image holds any of loom itself."),
    ])

    runtime = '<div class="dec">' + group("What a body is given when it starts", "cyan", [
        row("<b>Loom's body program.</b> The program that takes the job, starts the harness and reports back. It comes from the worker's own installation, read-only, so it is always the one that matches the loom that is running.", "mounted at /opt/loom"),
        row("<b>Its account's sign-in.</b> A model sign-in is a directory of files that the harness's program rewrites when it renews, so it cannot be in an image. The machine's configuration names one directory for each account and harness, and a body gets the one for its job's account and no other, at <code>/run/loom/login/&lt;harness&gt;</code> in every house on every machine. It is the same directory for every body on that account, never a copy: a renewal changes the sign-in, so copies would cancel each other. Loom does not read, clean or write anything in it.", "mounted at /run/loom/login"),
        row("<b>Its agent's own directories.</b> The machine's configuration can give an agent directories of the machine, read-only unless it says otherwise: a little state kept between bodies, say. Each lands under the home, at the path the configuration gives, and never on the repository. A body gets its own agent's and never another agent's.", "from the machine's configuration"),
        row("<b>Its startup secrets.</b> Each is in the environment of the harness under its alias. They are handed over when the body starts, not before, and are in no image.", plink("Secrets")),
        row("<b>What its house was built from.</b> Three environment variables that loom sets, whatever the image says: <code>LOOM_HOUSE_REPOSITORY</code> (the address, which never holds a credential), <code>LOOM_HOUSE_BRANCH</code> and <code>LOOM_HOUSE_COMMIT</code>, the exact commit the image was built from, so a repository can make the copy of itself a real checkout.", "set by loom"),
        row("<b>Its job.</b> The work, and a credential of its own that is good for this one job.", plink("Signing in")),
    ]) + group("What it is not given", "amber", [
        row("The engine socket stays with the worker. A worker configured to pass it through stops at startup, and a job requesting nested containers cannot start.", "container engine"),
        row("The worker refuses mounts overlapping its configuration, credentials, private state or protected server storage. Apply the same protection to custom storage paths in the worker configuration.", "private storage"),
    ]) + '</div>'

    several = how([
        ("Slots", "violet", opts(("slots", "4 unless the machine says otherwise"), ("at most", "16")),
         "A worker runs several jobs side by side, each in a slot. A house being built takes one slot, so another agent's job, whose house is already built, starts in a free one. Two jobs that want the same new image wait for one build. Loom keeps no count of a machine's jobs: a worker asks for a job only when it has a free slot."),
        ("Bodies on one account", "pink", opts(("Claude Code", "4 at once"), ("Codex", "1 at a time"), ("either", "as the machine says")),
         "Bodies on one model account share its sign-in, as several sessions of one person do, and each harness's own program renews it when it needs to. Loom has no renewer and no lock of its own. Claude Code takes a lock in the sign-in directory and reads the sign-in again before it renews; that was read in the program, in the version the core house pins, and has not been tested here with two bodies renewing at once. For Codex it is not established what happens then, so its bodies run one at a time on an account unless the machine's configuration says more. If a renewal is refused all the same, that body fails and its work is tried again. A job beyond the limit waits, and loom shows it as starting."),
        ("What is kept on the disk", "cyan", log(("images", "two a house, ten in all"), ("repositories", "the eight used most recently"), ("leftovers", "unnamed images after a day, build cache after a week")),
         "After a build the worker removes what it no longer needs: house images beyond the two newest of each house and the ten newest in all, never one a job is using. A core house stays while a house image that is kept was built on it, which in practice is this week's and last week's. It keeps its copies of the eight repositories used most recently. It also asks the engine to remove unnamed images older than a day and build cache unused for a week, which reaches every such leftover on that engine, not only loom's."),
    ])

    wrong = '<div class="dec">' + group("A job fails, and the worker carries on", "pink", [
        row("<b>Build failed.</b> The address is not https, the branch or Housefile is not there, the secret does not fetch the repository, the commit is past a limit, a step of the Housefile failed, or the core house could not be built (a download address that does not answer, say).", "worker build · exit code 22"),
        row("<b>The build ran out of time.</b> The fetch, the core house's build when it was needed, and the house's build together took longer than the build's limit.", "worker build time · exit code 32"),
        row("<b>The house image does not meet the image contract</b>, followed by what is at fault: <code>loom.house</code>, <code>loom.house.harnesses</code> or <code>VOLUME</code>.", "worker house · exit code 30"),
        row("<b>Launch failed.</b> Node or the repository is not in the image at its place, or the engine could not start the container.", "worker launch · exit code 23"),
        row("<b>Runner failed.</b> The machine has no sign-in directory for the job's account and harness.", "worker runner · exit code 27"),
        row("<b>Body config.</b> The harness's body file is not in the image at its place, or is not a body file.", "body config · exit code 16"),
    ]) + group("The worker stops when it starts, with one line", "amber", [
        row("<b>git 2.32.0 or later, which fetches each house's repository, could not be run on this machine.</b>", "worker exit code 54"),
        row("<b>The directory the worker is installed in cannot give containers the body program.</b> The worker's packages are not inside its own directory.", "worker exit code 55"),
        row("<b>A path the configuration gives to containers, or an engine socket, cannot be used.</b> The line ends with the key of the entry at fault, never a path.", "worker exit code 52"),
        row("<b>The directory the worker is installed in has no definition of the core house.</b> The install is not a whole one.", "worker exit code 56"),
        row("<b>The configuration has a key that a worker with container bodies no longer takes.</b> A build command, a runner, directories listed for every agent at once, or a place in the container for a sign-in. The line ends with the key.", "worker exit code 53"),
    ]) + '</div>'

    needs = '<div class="dec">' + group("What a machine needs", "cyan", [
        row("A container engine that serves the Docker Engine API on a socket: Docker, or Podman.", "the engine"),
        row("git 2.32 or later.", "to fetch"),
        row("Network access from the engine's builds to Debian's mirrors, nodejs.org, Claude Code's release address and the npm registry: the core house is built from them, once a week.", "to build the core"),
        row("The loom worker, installed with its packages inside its own directory, as <code>npm install -g</code> does. An install that shares packages with a project, the npx cache and pnpm are not supported.", "to run bodies"),
        row("A token for the machine, and a configuration that names the engine's socket.", plink("Signing in")),
    ]) + group("Not supported", "amber", [
        row("A repository at an <code>ssh</code> address, or fetched with a deploy key.", "https only"),
        row("Submodules. A submodule's files are not in the build.", "left out"),
        row("Git LFS. A file kept in LFS reaches the build as the small pointer file the commit holds.", "pointer only"),
        row("A base image in a registry that needs a sign-in, unless the engine itself is signed in to it. Loom passes no registry credential.", "the engine's own"),
    ]) + group("Not built yet", "violet", [
        row("The harness <code>agy</code> in the core house. There is no install of it pinned to a version and a checksum to put there; a house that wants it installs it in its own Housefile and lists it in the label.", "not in the core"),
        row("A check, with real sign-ins, of two bodies on one account renewing at the same moment. Until it is done for Codex, its bodies run one at a time.", "to be run by a person"),
        row("A conversation's harness session carried from one body to the next. Today each body starts its harness afresh.", "stated direction"),
    ]) + '</div>'

    body = f"""
<section class="hero2">
  <div class="hero2__text t-cyan">
    <div><p class="eyebrow">Beside page {idx} · where a body runs</p><h1>Houses</h1>
    <p class="lead"><b>A house is the container image an agent's body runs in.</b> Loom provides the core of it; one file in the agent's own repository, the Housefile, adds the rest.</p></div>
    <p class="lead">Any worker builds and runs any agent's house. Nothing is set up on a machine for an agent.</p>
  </div>
</section>
{band("What it is", "what-h", "A house, a worker and a Housefile", "", what)}
{band("Where it is named", "named-h", "An agent's run settings", "", named)}
{band("The Housefile", "file-h", "What a house says about itself", "An ordinary container build file that starts from the core house. Where things are inside a house is the same in every house, so the image says only two things with labels, and the core says both. Loom reads labels, and not a file inside the image, because an image's labels can be read without starting anything from it.", housefile)}
{band("How it works", "how-h", "When a job needs a house", "", steps)}
{band("At run time", "run-h", "What is not in the image", "", runtime)}
{band("On one machine", "many-h", "Several jobs at once, and the disk", "", several)}
{band("When it goes wrong", "wrong-h", "What a person sees", "", wrong)}
{band("Limits", "limits-h", "What a machine needs, and what is not there", "", needs)}
<footer class="foot"><p>Houses sits beside <b>Machines and jobs</b>.</p><a class="btn" href="{FILE["Machines and jobs"]}">Machines and jobs <span aria-hidden="true">›</span></a></footer>
"""
    return page(idx, "Houses · loom", body, beside="Machines and jobs")

# ───────────────────────── Measuring
def measuring():
    fig = f'''<div class="fork">
      <div class="panel t-violet"><span class="lbl">Set by a household owner</span><h4>Measuring</h4><span class="sw"><i></i>Off</span>
        <span class="muted">Off by default. Off costs nothing, and someone who never sets it up never sees it.</span>
        <div class="sec"><span class="lbl">Turned on</span><span>Loom is instrumented once, in the standard way monitoring tools understand.</span></div></div>
      <div class="fork__to">
        <div class="node t-amber"><i class="wire"></i><div class="panel"><span class="lbl">Either</span><h4>A monitoring tool you already run</h4><span class="muted">Any tool that accepts the standard format.</span></div></div>
        <div class="node t-cyan"><i class="wire"></i><div class="panel"><span class="lbl">Or both</span><h4>Loom's own small store</h4><span class="muted">One rolled-up record per day for each kind of request, operation and background job.</span>
          <div class="agent" style="border:0;padding:6px 0 0;background:none;border-top:1px solid var(--line);border-radius:0">{FACE_A}<div><b>Art reads it</b><span>through the same data endpoint as everything else</span></div></div></div></div>
      </div>
    </div>'''
    anat = anatomy("timing_days · one day's record", "Requests for tasks on Nov 14", [
        ("kind, name", "request · tasks"),
        ("count, typical, slowest", "412 times · 12 ms · 80 ms"),
        ("read by", "an agent", "r", "How a tile gets its data", "An agent asks for it through the same data endpoint as everything else."),
        ("alongside", "which model answered, how the turn went, how long the person waited", "l", "Conversations", "Loom already records these about every turn."),
        ("who sees it", "household owners and agents", "r", "People and projects", "Household owners turn it on and see it. Agents read it."),
    ])
    panels = [
        ("Off by default", "violet", '<span class="sw"><i></i>Off</span>',
         "Measuring is off unless a household owner turns it on. Off costs nothing, and someone who never sets it up never sees it."),
        ("One instrumentation, two destinations", "amber", opts(("outside tool", "any that accepts the standard format"), ("local store", "kept by loom itself")),
         "Loom is instrumented once with OpenTelemetry, the standard monitoring tools understand. Turned on, the same measurements go to a tool the household already runs, to loom's own store, or both."),
        ("What the local store holds", "cyan", log(("request", "tasks · 412 times · typical 12 ms"), ("operation", "create a task · 9 times · typical 6 ms"), ("job", "reading GitHub · 288 times · slowest 132 ms")),
         "A rolled-up record per day of how long each kind of request, operation and background job took, and how often it ran."),
        ("Why agents read it", "pink", card("pink", "Real numbers", "Did the change make things faster?", "three weeks before · three weeks after"),
         "Work that judges loom itself has real numbers to go on: comparing two harnesses, or checking whether an experimental change made things faster or slower over a few weeks."),
    ]
    return app_page("Measuring", "off until you turn it on", "Loom keeps count of how long things take, so slow spots are visible.",
        "It does this on your own machine, and only when a household owner turns it on.",
        ["Off unless a household owner turns it on. Off costs nothing.", "Instrumented once, in the standard way monitoring tools understand.",
         "Sends measurements to a tool you already run, to loom's own store, or both.", "Lets agents read the local store, so work that judges loom has real numbers."],
        fig, "A switch that is off by default, then the two places measurements can go. An agent reads the local one.",
        "How a day's record connects to other parts", "One record from the local store, with a thread from each part of it that reaches another page.", anat,
        "The switch, the two destinations, the store and its readers", panels, [],
        [("Who sees it.", "Household owners and agents."),
         ("Who turns it on.", "A household owner. Until then nothing is counted and nothing is shown.")],
        [("", ["timing_days", "measuring_settings"])])

# ───────────────────────── What we decided
def decided():
    def d(text, *titles):
        at = " · ".join(f'<a href="{"index.html" if t == "The front door" else FILE[t]}">{e(t)}</a>' for t in titles)
        return f'<li><p>{text}</p><span class="at">shows up on: {at}</span></li>'
    groups = [
        ("The product", "pink", [
            d("One program and one data folder, quick for someone else to install.", "Outside programs"),
            d("One API for the command line, the web app and agents.", "Outside programs"),
            d("A restart is an acceptable deploy.", "Outside programs"),
            d("The tiled desk is the product on a desktop screen. The phone does what the desk does, built after the desk is right.", "The desk", "Outside programs"),
            d("Parts can be replaced, such as the task store or a bridge, because each is a module with a typed interface.", "Outside programs", "The front door"),
        ]),
        ("Conversations and chat", "pink", [
            d("Everything is a conversation, and there is one conversations table.", "Conversations"),
            d("One inbox for everything sent to anyone, person or agent.", "Inbox", "Conversations"),
            d("Every app also appears inline in chat.", "Tasks", "Approvals", "Tempo", "Changes", "Inbox"),
            d("Chat is how you control loom. Screens are for seeing.", "The front door", "The desk", "Secrets", "People and projects"),
            d("A settings change or a dangerous action asked for in chat gets an approval card inline, with before and after. Ordinary work needs no card.", "Approvals", "Tempo", "The front door"),
        ]),
        ("People and trust", "amber", [
            d("A small team that trusts each other. The project is the unit of sharing. No fine-grained permissions.", "People and projects"),
            d("Household owners see everything, including another member's private thread.", "People and projects", "Conversations"),
            d("Whatever is installed is trusted. Permission is checked only for callers from outside.", "Signing in", "Outside programs"),
            d("An outside program has one door: the API with a token.", "Outside programs"),
            d("An agent reaches loom through MCP: named tools for what it does every session, three general tools for everything else. It cannot make credentials, and it proposes a settings change instead of making it.", "Tools for agents"),
            d("Every task has an owner.", "Tasks"),
        ]),
        ("Data", "cyan", [
            d("A concrete data model in real columns, defined once in Drizzle. The database does the work.", "How a tile gets its data"),
            d("SQLite by default. The database is a configuration choice.", "How a tile gets its data"),
            d("One query endpoint in a community standard, GraphQL, generated from the same schema. Changes arrive as subscriptions over a websocket.", "How a tile gets its data"),
            d("Agents' memories are the only data loom treats as precious.", "Memory"),
            d("Notes come second to memories. Every backup and every move carries all of them, whatever their lifespan, but they are not irreplaceable.", "Memory"),
        ]),
        ("Running", "violet", [
            d("The clock is part of tempo: triggers, the inbox as the pile, the sweep, volume.", "Tempo", "Inbox"),
            d("Measuring is off unless a household owner turns it on. Loom is instrumented once in the standard way, and measurements go to a monitoring tool you already run, to loom's own store, or both. Agents can read the local store.", "Measuring"),
            d("There are always two programs, loom and a worker. Nothing runs inside loom itself. A worker may share loom's machine.", "Machines and jobs"),
            d("Tempo's timings are adjustable per person, with defaults.", "Tempo"),
            d("The runtime handles model accounts, harnesses and which model a body uses.", "Models and accounts"),
            d("An account's owner and household owners see its detail. Everyone else sees a summary.", "Models and accounts"),
        ]),
    ]
    secs = "".join(f'<section class="t-{t}"><h2>{e(g)}</h2><ul>{"".join(items)}</ul></section>' for g, t, items in groups)
    idx = NUM["What we decided"]
    body = f'''
<section class="hero2">
  <div class="hero2__text t-pink">
    <div><p class="eyebrow">Page {idx} of {N} · the ledger</p><h1>What we decided</h1>
    <p class="lead"><b>Every decision behind this site, in plain words.</b> Each one names the page where it shows up, so you can check that nothing is missing.</p></div>
    <p class="lead">{sum(len(i) for _, _, i in groups)} decisions in {len(groups)} groups.</p>
  </div>
</section>
<div class="dec">{secs}</div>
{foot(idx)}
'''
    return page(idx, "What we decided · loom", body)

def pages():
    return [("desk.html", desk()), ("approvals.html", approvals()), ("tempo.html", tempo()), ("changes.html", changes()), ("inbox.html", inbox()),
            ("memory.html", memory()), ("machines.html", machines()), ("models.html", models()), ("bridges.html", bridges()), ("secrets.html", secrets()),
            ("people.html", people()), ("signing-in.html", signing()), ("outside.html", outside()), ("tools.html", tools()), ("data.html", data()), ("measuring.html", measuring()),
            ("decided.html", decided()), ("houses.html", houses())]

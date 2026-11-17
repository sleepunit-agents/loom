#!/usr/bin/env python3
"""Build draft 2 of the loom docs site into site/: index.html, conversations.html, tasks.html.
Data-model sections are generated from model.py so tables are never hand-copied.
Run: python3 site_build.py   (static output, no script needed to read it)."""
import html, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from model import AREAS

e = html.escape
OUT = os.path.join(HERE, "site")

# ───────────────────────── the guided path
# (file or None when not written yet, title, one line, tint)
PATH = [
    ("conversations.html", "Conversations", "Every exchange with an agent, wherever it happens. The hub.", "pink"),
    ("desk.html", "The desk", "The tiled desktop: tiles, the launcher, the agent rail, the ticker, Home, the looks.", "pink"),
    ("tasks.html", "Tasks", "The household's work queue.", "violet"),
    ("approvals.html", "Approvals", "Permission from a person for an agent to do one specific thing.", "pink"),
    ("tempo.html", "Tempo", "Triggers: what starts work without anyone asking.", "violet"),
    ("changes.html", "Changes", "Pull requests the household cares about.", "pink"),
    ("inbox.html", "Inbox", "One inbox for everything sent to anyone, person or agent.", "cyan"),
    ("memory.html", "Memory", "What an agent remembers and knows. The one thing loom treats as precious.", "cyan"),
    ("machines.html", "Machines and jobs", "Where agents run and what they are running.", "cyan"),
    ("models.html", "Models and accounts", "Which model a body runs on, and the accounts it draws from.", "cyan"),
    ("bridges.html", "Discord and Slack", "How agents talk to people in other apps.", "amber"),
    ("secrets.html", "Secrets", "Credentials agents need, and who may use each one.", "amber"),
    ("people.html", "People and projects", "Who is in the household, which agents they own, which projects they share.", "amber"),
    ("signing-in.html", "Signing in", "How a person, an agent or a machine proves who it is.", "violet"),
    ("outside.html", "Outside programs", "The one door: the API with a token.", "amber"),
    ("tools.html", "Tools for agents", "What an agent can do through the door, part by part.", "cyan"),
    ("data.html", "How a tile gets its data", "One live connection. A tile says what it wants and then gets only changes.", "cyan"),
    ("measuring.html", "Measuring", "How long things take, counted when you turn it on, and readable by agents.", "violet"),
    ("decided.html", "What we decided", "Every decision in plain words, with the page where it shows up.", "pink"),
]
N = len(PATH)
NUM = {title: i + 1 for i, (_, title, _, _) in enumerate(PATH)}
TINT = {title: t for _, title, _, t in PATH}
FILE = {title: f for f, title, _, _ in PATH}

def plink(title):
    return f'<a href="{FILE[title]}">{e(title)}</a>'

def key(title, small=False):
    return f'<span class="key{" key--sm" if small else ""} t-{TINT[title]}" aria-hidden="true">{NUM[title]}</span>'

ICONS = {
    "knowledge": '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6"/>',
    "approvals": '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4"/>',
    "clock": '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"/>',
    "changes": '<path d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9v12M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 15V9a3 3 0 0 0-3-3h-3"/>',
    "bridges": '<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
    "settings": '<path d="M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6"/>',
    "sharing": '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 7M22 21a7 7 0 0 0-4-6"/>',
    "tasks": '<path d="M3 7l2 2 4-4M3 17l2 2 4-4M13 7h8M13 17h8"/>',
    "comms": '<path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.4A8.5 8.5 0 1 1 21 12z"/>',
    "inbox": '<path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5"/>',
}

def tile(tint, icon, title, body, cls=""):
    return (f'<div class="tile t-{tint} {cls}"><div class="tile__bar"><span class="tile__key"><svg viewBox="0 0 24 24">{ICONS[icon]}</svg></span>'
            f'<b>{title}</b><span class="tile__acts"><i></i><i></i><i></i></span></div>{body}</div>')

def chat(title, body, foot=None, sub="with Art"):
    """A Comms thread drawn alone: the same example thing, inline in a conversation."""
    foot = foot if foot is not None else '<div class="cm__compose"><span>Message Art</span><span class="mbtn mbtn--on">Send</span></div>'
    return tile("pink", "comms", "Comms", f'<div class="tile__body"><div class="cm__thread"><div class="cm__head"><b>{title}</b><span>{sub}</span><span class="chip">pond</span></div>'
                f'<div class="cm__msgs cm__msgs--plain">{body}</div>{foot}</div></div>')
def c_me(t): return f'<div class="msg msg--me t-pink"><div class="msg__b">{t}</div></div>'
def c_art(t): return f'<div class="msg"><div class="msg__b">{t}</div></div>'
def c_ask(q, why, yes, no, ref=""):
    r = f'<span><span class="chip">{ref}</span></span>' if ref else ""
    return (f'<div class="msg msg--ask"><div class="msg__b"><b>{q}</b><small>{why}</small><small>Yes: {yes}</small><small>No: {no}</small>{r}'
            '<span class="yn"><span class="mbtn mbtn--on t-cyan">Allow</span><span class="mbtn">Deny</span></span></div></div>')
def c_ref(kind, title, status):
    return f'<div class="refc"><span class="lbl">{kind}</span><b>{title}</b><span>{status}</span><span class="yn"><span class="mbtn">Open</span></span></div>'
def c_work(*items):
    return '<div class="wk"><span class="lbl">Work in this thread</span>' + "".join(f"<p>{t}<em>{m}</em></p>" for t, m in items) + "</div>"
def c_step(meta, text): return f'<div class="step"><em>{meta}</em><span>{text}</span></div>'

def hero_two(idx, tint, kind, title, lead, does, app_tile, chat_tile, cap, app_name):
    return f'''
<section class="hero2">
  <div class="hero2__text t-{tint}">
    <div><p class="eyebrow">Page {idx} of {N} · {kind}</p><h1>{e(title)}</h1><p class="lead">{lead}</p></div>
    <ul class="does">{"".join(f"<li>{d}</li>" for d in does)}</ul>
  </div>
  <figure class="hero__fig">
    <div class="two" aria-hidden="true">
      <div class="two__a"><span class="lbl">In the {app_name} tile</span><div class="shadowed">{app_tile}</div></div>
      <div class="two__b"><span class="lbl">In a chat</span><div class="shadowed">{chat_tile}</div></div>
    </div>
    <figcaption class="cap">{cap}</figcaption>
  </figure>
</section>'''

CTL = " Screens are for seeing: to change something here, ask an agent in chat, or use the tile."

FACE_A = '<svg class="face a" viewBox="0 0 40 40"><path class="body" d="M20 3c9 0 16 6 16 16s-6 18-16 18S4 30 4 19 11 3 20 3z"/><circle class="eye" cx="14.5" cy="18" r="2.4"/><circle class="eye" cx="25.5" cy="18" r="2.4"/><path class="mouth" d="M16 26q4 3 8 0"/></svg>'
FACE_B = '<svg class="face b" viewBox="0 0 40 40"><path class="body" d="M20 3c5 6 14 12 14 21a14 14 0 0 1-28 0C6 15 15 9 20 3z"/><ellipse class="eye" cx="15" cy="22" rx="2.2" ry="2.8"/><ellipse class="eye" cx="25" cy="22" rx="2.2" ry="2.8"/><path class="mouth" d="M17 30h6"/></svg>'

# ───────────────────────── shared frame
def page(idx, title, body, beside=None):
    """idx 0 is the front door; 1..N are the path. A page that is not on the path names the path page it
    sits beside: it is shown as beside that page, and leads back to it."""
    dots = ['<li><a href="index.html" title="Start here"%s><span class="sr">Start here</span></a></li>' % (' aria-current="page"' if idx == 0 else "")]
    for i, (f, t, _, _) in enumerate(PATH, 1):
        if f:
            cur = ' aria-current="page"' if i == idx else ""
            dots.append(f'<li><a href="{f}" title="{i}. {e(t)}"{cur}><span class="sr">{i}. {e(t)}</span></a></li>')
        else:
            dots.append(f'<li><span title="{i}. {e(t)} (coming)"><span class="sr">{i}. {e(t)}, coming</span></span></li>')
    where = "<b>Start here</b>" if idx == 0 else f"<b>{idx}</b> of {N} · {e(PATH[idx-1][1])}"
    go = []
    if beside:
        dots = [d.replace(' aria-current="page"', "") for d in dots]
        where = f"beside <b>{idx}</b> · {e(beside)}"
        go.append(f'<a href="{PATH[idx-1][0]}" rel="prev">‹ <span class="pl">{e(PATH[idx-1][1])}</span></a>')
    elif idx == 1:
        go.append('<a href="index.html" rel="prev">‹ <span class="pl">Start</span></a>')
    elif idx > 1:
        f, t, _, _ = PATH[idx - 2]
        go.append(f'<a href="{f}" rel="prev">‹ <span class="pl">{e(t)}</span></a>')
    if idx < N and not beside:
        f, t, _, _ = PATH[idx]
        go.append(f'<a class="next" href="{f}" rel="next"><span class="pl">{e(t)}</span> ›</a>' if f
                  else f'<span><span class="pl">Next: {e(t)}, coming</span><span aria-hidden="true"> ›</span></span>')
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(title)}</title>
<link rel="stylesheet" href="site.css">
<script src="site.js"></script>
</head>
<body>
<header class="top"><div class="top__in">
  <a class="brand" href="index.html"><b>LO<i>O</i>M</b><span>how it works</span></a>
  <nav class="path" aria-label="Guided path">
    <ol class="path__dots">{"".join(dots)}</ol>
    <span class="path__where">{where}</span>
    <span class="path__go">{"".join(go)}</span>
  </nav>
  <button class="theme" id="theme" type="button" aria-label="Switch between light and dark">Theme</button>
</div></header>
<main class="wrap">
{body}
</main>
</body>
</html>
'''

def foot(idx):
    if idx < N:
        f, t, one, _ = PATH[idx]
        return f'<footer class="foot"><p>Next on the path: <b>{e(t)}</b>. {e(one)}</p><a class="btn" href="{f}">{e(t)} <span aria-hidden="true">›</span></a></footer>'
    return '<footer class="foot"><p>That is the end of the path.</p><a class="btn" href="index.html">Back to the start</a></footer>'

# ───────────────────────── data model, from model.py
TABLES = {t["name"]: (a["key"], t) for a in AREAS for t in a["tables"]}
PAGE_OF = {"tasks": "tasks.html", "conversations": "conversations.html", "comms": "conversations.html", "inbox": "inbox.html",
           "approvals": "approvals.html", "tempo": "tempo.html", "changes": "changes.html", "runtime": "machines.html",
           "bridges": "bridges.html", "models": "models.html", "measuring": "measuring.html", "secrets": "secrets.html", "people": "people.html", "signin": "signing-in.html"}
LABEL_TABLE = {"project": "projects", "agent": "agents", "member": "members"}

def targets(name, link):
    """A combined column such as 'project, member' points at more than one table; model.py names only the first.
    A link may itself name several tables ('members, agents') when the column holds one or the other."""
    if not link:
        return []
    links = [l.strip() for l in link.split(",")]
    if len(links) > 1:
        return links
    parts = [p.strip() for p in name.split(",")]
    mapped = [LABEL_TABLE[p] for p in parts if p in LABEL_TABLE]
    return mapped if len(mapped) > 1 and link in mapped else [link]

def table_details(name, shown, tint):
    area, t = TABLES[name]
    n = sum(len(c[0].split(",")) for c in t["cols"])
    rows = []
    for cname, ctype, meaning, link in t["cols"]:
        tos = []
        for tgt in targets(cname, link):
            if tgt in shown:
                tos.append(f'<a href="#t-{tgt}">{tgt}</a>')
            elif tgt in TABLES and PAGE_OF.get(TABLES[tgt][0]):
                tos.append(f'<a href="{PAGE_OF[TABLES[tgt][0]]}#t-{tgt}">{tgt}</a>')
            else:
                tos.append(tgt)
        to = f'<span class="to">points to {", ".join(tos)}</span>' if tos else "<span></span>"
        rows.append(f'<div class="col"><div><code>{e(cname)}</code><small>{e(ctype)}</small></div><p>{e(meaning)}</p>{to}</div>')
    return (f'<details class="tbl t-{tint}" id="t-{name}"><summary><code>{name}</code><em>{n} columns</em>'
            f'<span>{e(t["holds"])}</span></summary><div class="cols">{"".join(rows)}</div></details>')

def data_model(groups, tint):
    shown = {n for _, names in groups for n in names}
    out = []
    for label, names in groups:
        head = f'<h3 class="lbl">{e(label)}</h3>' if label else ""
        out.append(f'<div class="tgroup">{head}<div class="tgrid">{"".join(table_details(n, shown, tint) for n in names)}</div></div>')
    return "".join(out)

def desk_html():
    comms_mini = '''<div class="tile__body"><div class="mini">
      <div class="msg msg--me t-pink"><div class="msg__b">Can you find a pump that fits the old hose?</div></div>
      <div class="msg msg--card"><div class="msg__b">Looked up three pumps · done</div></div>
      <div class="msg"><div class="msg__b">Three fit. The middle one is in stock at $164. I filed <span class="chip">t-2190</span> to order it.</div></div>
      <div class="msg msg--ask"><div class="msg__b"><b>Spend up to $180 on the pump I picked?</b><span class="yn"><span class="mbtn mbtn--on t-cyan">Allow</span><span class="mbtn">Deny</span></span></div></div>
      <div class="cm__compose" style="margin:2px 0 0"><span>Message Art</span><span class="mbtn mbtn--on">Send</span></div>
    </div></div>'''
    tasks_mini = '''<div class="tile__body"><div class="mini">
      <div class="row"><b>Pick a replacement pond pump</b><em>t-2188 · P1 · open</em></div>
      <div class="row"><b>Order the pump</b><em>t-2190 · P1 · open</em></div>
      <div class="row"><b>Book the electrician</b><em>t-2175 · P2 · open</em></div>
    </div></div>'''
    inbox_mini = '''<div class="tile__body"><div class="mini">
      <div class="askc"><b>Spend up to $180 on the pump Art picked?</b><small>from a task · t-2190</small><span class="yn"><span class="mbtn mbtn--on">Yes</span><span class="mbtn">No</span></span></div>
    </div></div>'''

    return f'''<div class="desk" aria-hidden="true">
      <div class="desk__bar"><b>LO<i>O</i>M</b><span class="desk__tick">2 agents · <u>Art · Comparing pond pumps</u> · Mark · Nothing right now · Tasks · 2 in progress · 4 ready · Tempo · 3 due · Changes · 2 open</span></div>
      <div class="desk__main">
        {tile("pink", "comms", "Comms", comms_mini, "a")}
        {tile("violet", "tasks", "Tasks", tasks_mini, "b")}
        {tile("cyan", "inbox", "Inbox", inbox_mini, "c")}
        <div class="desk__rail">
          <div class="agent">{FACE_A}<div><b>Art</b><i>working</i><span>Comparing pond pumps</span></div></div>
          <div class="agent">{FACE_B}<div><b>Mark</b><i class="idle">idle</i><span>Nothing right now</span></div></div>
        </div>
      </div>
      <div class="desk__dock"><span class="t-violet">Tasks</span><span class="t-cyan">Inbox</span><span class="t-pink">Comms</span><span class="t-pink">Approvals</span><span class="t-violet">Tempo</span><span class="t-pink">Changes</span></div>
    </div>'''

# ───────────────────────── index
def index():
    steps = []
    for i, (f, t, one, _) in enumerate(PATH, 1):
        start = '<span class="start">Start here</span>' if i == 1 else ""
        steps.append(f'<li><span class="n">{i:02d}</span><span><a class="ttl" href="{f}">{e(t)}</a>{start}</span><span class="one">{e(one)}</span></li>')

    body = f'''
<section class="hero">
  <div class="hero__text">
    <p class="eyebrow">Loom · how it works</p>
    <h1>Everything is a <em>conversation</em>.</h1>
    <p class="lead"><b>Loom is a program one household runs for itself.</b> A few people and a few AI agents share a desk in the browser: small app windows side by side, the agents at the edge, a ticker along the top.</p>
    <p class="lead">Whatever an agent does, it does in a conversation. You chat with it in loom. Someone talks to it on Discord or Slack. A trigger starts it. One agent hands work to another. Each of these is the same thing to loom, so conversations sit at the centre and every other part touches them.</p>
    <p class="lead"><b>Chat is how you control loom. Screens are for seeing.</b> Every app also appears inline in a conversation.</p>
    <div class="cta"><a class="btn" href="conversations.html">Start with Conversations <span aria-hidden="true">›</span></a><span class="cap">{N} pages on the path.</span></div>
  </div>
  <figure class="hero__fig">
    {desk_html()}
    <figcaption class="cap">The desk, drawn small with example content: app tiles side by side, the agents on the right, the ticker in the top bar.</figcaption>
  </figure>
</section>

<section class="band" aria-labelledby="map-h">
  <div class="band__head"><span class="tag">The map</span><h2 id="map-h">How the parts connect</h2>
    <p>A conversation starts in one of five places and reaches the parts on the right. The number on each part is its page on the path.</p></div>
  <div class="map">
    <div class="map__col map__in">
      <h3>Where a conversation happens</h3>
      <ul>
        <li class="node t-pink">{key("Conversations")}<div class="node__body"><b>A thread in loom</b><span>You and an agent, chatting in Comms.</span></div><i class="wire"></i></li>
        <li class="node t-amber">{key("Discord and Slack")}<div class="node__body"><b>Discord</b><span>Someone talks to the agent in a channel or a direct message.</span></div><i class="wire"></i></li>
        <li class="node t-amber">{key("Discord and Slack")}<div class="node__body"><b>Slack</b><span>The same, in a Slack workspace.</span></div><i class="wire"></i></li>
        <li class="node t-violet">{key("Tempo")}<div class="node__body"><b>A trigger</b><span>A time, or something changing, drops an item in the agent's inbox.</span></div><i class="wire"></i></li>
        <li class="node t-cyan">{key("Machines and jobs")}<div class="node__body"><b>A subagent</b><span>One agent hands a piece of work to another.</span></div><i class="wire"></i></li>
      </ul>
    </div>
    <div class="core">
      <span class="core__tag">The centre · page 1</span>
      <h3><a href="conversations.html" style="text-decoration-color:var(--core-pink);text-underline-offset:6px;text-decoration-thickness:2px">A conversation</a></h3>
      <p>One agent talking in one place. Loom keeps one record for each, whatever the place.</p>
      <ol class="stages">
        <li><i>IN</i><div><b>One inbox</b><span>Everything sent to anyone, person or agent, lands in one inbox that knows where each item came from.</span></div></li>
        <li><i>WORK</i><div><b>Turns</b><span>Each thing said or done, in order.</span></div></li>
        <li><i>OUT</i><div><b>A digest</b><span>The write-up at the end: what happened, what was decided, what it needs from a person.</span></div></li>
      </ol>
    </div>
    <div class="map__col map__out">
      <h3>What it reaches</h3>
      <ul>
        <li class="node t-cyan"><i class="wire"></i>{key("Inbox")}<div class="node__body"><b><a href="{FILE["Inbox"]}">Inbox</a></b><span>A question for a person lands here and waits for an answer.</span></div></li>
        <li class="node t-violet"><i class="wire"></i>{key("Tasks")}<div class="node__body"><b><a href="tasks.html">Tasks</a></b><span>Work filed from a conversation remembers where it came from.</span></div></li>
        <li class="node t-pink"><i class="wire"></i>{key("Approvals")}<div class="node__body"><b><a href="{FILE["Approvals"]}">Approvals</a></b><span>An agent asks permission to do one specific thing.</span></div></li>
        <li class="node t-pink"><i class="wire"></i>{key("Changes")}<div class="node__body"><b><a href="{FILE["Changes"]}">Changes</a></b><span>Pull requests a thread mentions show up as cards.</span></div></li>
        <li class="node t-cyan"><i class="wire"></i>{key("Memory")}<div class="node__body"><b>{plink("Memory")}</b><span>What the agent remembers afterwards. The one thing loom treats as precious.</span></div></li>
        <li class="node t-cyan"><i class="wire"></i>{key("Machines and jobs")}<div class="node__body"><b><a href="{FILE["Machines and jobs"]}">Machines and jobs</a></b><span>One job at a time does the work, on a machine with a worker.</span></div></li>
      </ul>
    </div>
    <div class="map__base">
      <h3>Around and under every part</h3>
      <ul>
        <li class="node">{key("The desk")}<div class="node__body"><b>{plink("The desk")}</b><span>Where you see all of it: tiles, the agent rail, the ticker.</span></div></li>
        <li class="node">{key("People and projects")}<div class="node__body"><b>{plink("People and projects")}</b><span>Project, agent and member labels on each record decide who sees it.</span></div></li>
        <li class="node">{key("Signing in")}<div class="node__body"><b>{plink("Signing in")}</b><span>A person, an agent or a machine proves who it is at the door.</span></div></li>
        <li class="node">{key("Outside programs")}<div class="node__body"><b>{plink("Outside programs")}</b><span>One API with a token, for anything outside loom.</span></div></li>
        <li class="node">{key("Tools for agents")}<div class="node__body"><b>{plink("Tools for agents")}</b><span>What an agent can do through the door, part by part.</span></div></li>
        <li class="node">{key("Secrets")}<div class="node__body"><b>{plink("Secrets")}</b><span>Credentials an agent may be handed, and a record of each use.</span></div></li>
        <li class="node">{key("Models and accounts")}<div class="node__body"><b>{plink("Models and accounts")}</b><span>Which model a body runs on, and the account it draws from.</span></div></li>
        <li class="node">{key("How a tile gets its data")}<div class="node__body"><b>{plink("How a tile gets its data")}</b><span>One live connection feeds every tile on the desk.</span></div></li>
        <li class="node">{key("Measuring")}<div class="node__body"><b>{plink("Measuring")}</b><span>How long things take, counted when you turn it on.</span></div></li>
        <li class="node">{key("What we decided")}<div class="node__body"><b>{plink("What we decided")}</b><span>Every decision, with the page where it shows up.</span></div></li>
      </ul>
    </div>
  </div>
</section>

<div class="split">
  <section class="band" aria-labelledby="rules-h">
    <div class="band__head" style="grid-template-columns:1fr"><span class="tag">Ground rules</span><h2 id="rules-h">Eight rules hold everywhere</h2></div>
    <ol class="rules">
      <li class="t-pink"><span class="key" aria-hidden="true">1</span><b>Chat controls, screens show</b><span>You control loom by talking to your agents. Screens are for seeing. A settings change or a dangerous action asked for in chat gets an approval card inline, with before and after. Ordinary work needs no card.</span></li>
      <li class="t-cyan"><span class="key" aria-hidden="true">2</span><b>Installed means trusted</b><span>Loom's own parts never ask each other for permission. Loom checks permission only for callers from outside.</span></li>
      <li class="t-violet"><span class="key" aria-hidden="true">3</span><b>A small team that trusts each other</b><span>The project is the unit of sharing. No fine-grained permissions. Household owners see everything.</span></li>
      <li class="t-amber"><span class="key" aria-hidden="true">4</span><b>Real columns</b><span>Every fact is a named column, defined once with Drizzle. The database does the work. SQLite by default; the database is a configuration choice.</span></li>
      <li class="t-pink"><span class="key" aria-hidden="true">5</span><b>One query endpoint</b><span>A GraphQL endpoint generated from the same schema. A tile names the fields it wants, and changes arrive as subscriptions over one websocket.</span></li>
      <li class="t-cyan"><span class="key" aria-hidden="true">6</span><b>Only memories are precious</b><span>Agents' memories are the one kind of data loom treats as irreplaceable. Notes come second: looked after, but not irreplaceable.</span></li>
      <li class="t-violet"><span class="key" aria-hidden="true">7</span><b>One program, one data folder</b><span>Quick for someone else to install. One API for the command line, the web app and agents. A restart is an acceptable deploy.</span></li>
      <li class="t-amber"><span class="key" aria-hidden="true">8</span><b>Parts can be replaced</b><span>Each part is a module with a typed interface, so the task store or a bridge can be swapped for another.</span></li>
    </ol>
  </section>
  <section class="band" aria-labelledby="path-h">
    <div class="band__head" style="grid-template-columns:1fr"><span class="tag">The guided path</span><h2 id="path-h">Read them in this order</h2></div>
    <ol class="steps">{"".join(steps)}</ol>
  </section>
</div>
'''
    return page(0, "Loom, how it works", body)

# ───────────────────────── conversations
def conversations():
    comms = '''<div class="tile__body cm">
      <div class="cm__list">
        <div class="sp__top"><b>Threads</b><em>3</em></div>
        <div class="cm__row" data-on><span class="letter">A</span><div><b>Pond pump</b><span>Art · pond</span></div><u></u></div>
        <div class="cm__row"><span class="letter">A</span><div><b>Electrician dates</b><span>Art · pond</span></div></div>
        <div class="cm__row"><span class="letter">M</span><div><b>Weekly shop</b><span>Mark</span></div></div>
      </div>
      <div class="cm__thread">
        <div class="cm__head"><b>Pond pump</b><span>with Art</span><span class="chip">pond</span></div>
        <div class="cm__msgs">
          <div class="msg msg--me"><div class="msg__b">Can you find a pump that fits the old hose?</div><span class="msg__k">message</span></div>
          <div class="msg msg--card"><div class="msg__b">Looked up three pumps · done</div><span class="msg__k">card</span></div>
          <div class="msg"><div class="msg__b">Three fit. The middle one is in stock at $164. I filed <span class="chip">t-2190</span> to order it.</div><span class="msg__k">reply</span></div>
          <div class="msg msg--ask"><div class="msg__b"><b>Spend up to $180 on the pump I picked?</b><small>Yes: I order it today. No: I look for a cheaper one.</small><span class="yn"><span class="mbtn mbtn--on t-cyan">Allow</span><span class="mbtn">Deny</span></span></div><span class="msg__k">ask</span></div>
        </div>
        <div class="cm__compose"><span>Message Art</span><span class="mbtn mbtn--on">Send</span></div>
      </div>
      <div class="cm__work"><span class="lbl">Work</span><p>Order the pump<em>t-2190 · open · from tasks</em></p><p>Pick a replacement pond pump<em>t-2188 · open · from tasks</em></p></div>
    </div>'''

    groups = [
        ("The conversation", ["conversations", "conversation_people", "turns"]),
        ("The inbox", ["inbox"]),
        ("What comes out", ["digests", "digest_items"]),
        ("Threads in loom", ["threads", "messages", "thread_refs"]),
        ("Kept alongside", ["agent_status", "conversation_days", "findings", "deleted_threads"]),
    ]

    def acct(tint, src, text):
        return f'<li class="node t-{tint}"><span class="src">{src}</span><div class="node__body"><b>{text}</b></div><i class="wire"></i></li>'
    def item(n, tint, src, frm, to, words, st):
        return (f'<li class="in"><span class="n">{n}</span><span class="src t-{tint}">{src}</span><span class="who">{frm} <b>to</b> {to}</span>'
                f'<span class="txt">{words}</span><span class="st" data-s="{st}">{st}</span></li>')

    body = f'''
<section class="hero hero--app">
  <div class="hero__text t-pink">
    <p class="eyebrow">Page 1 of {N} · the hub</p>
    <h1>Conversations</h1>
    <p class="lead"><b>A conversation is one agent talking in one place.</b> Loom keeps one record for each, whatever the place, so a chat in loom, a Discord channel, a scheduled run and a handoff all look the same to every other part.</p>
    <ul class="facts">
      <li><b>One table</b><span>Every conversation is one row.</span></li>
      <li><b>One per place</b><span>An agent has one conversation per thread, channel or lane.</span></li>
      <li><b>One job at a time</b><span>At most one job works in a conversation.</span></li>
    </ul>
  </div>
  <figure class="hero__fig">
    <div class="shadowed" aria-hidden="true">{tile("pink", "comms", "Comms", comms)}</div>
    <figcaption class="cap">Comms, the app where you see a conversation most often, drawn with example content. The words down the right edge are the kinds of message loom stores.</figcaption>
  </figure>
</section>

<section class="band" aria-labelledby="where-h">
  <div class="band__head"><span class="tag">Where</span><h2 id="where-h">Five places a conversation happens</h2>
    <p>The word in colour is what loom writes in the conversation's <code>venue</code> column. Within a venue, the place is a thread, a channel, a lane name or, for a handoff, the parent job.</p></div>
  <div class="venues">
    <div class="venue t-pink"><span class="glyph">loom</span><b>A thread in loom</b><p>A private chat in Comms between one person and one agent.</p></div>
    <div class="venue t-amber"><span class="glyph">discord</span><b>Discord</b><p>A channel or a direct message. A bot signed in to the server speaks for the agent.</p></div>
    <div class="venue t-amber"><span class="glyph">slack</span><b>Slack</b><p>The same, in a Slack workspace.</p></div>
    <div class="venue t-violet"><span class="glyph">wake</span><b>A trigger</b><p>A trigger from Tempo drops an item in the agent's inbox, such as a lane that runs every night.</p></div>
    <div class="venue t-cyan"><span class="glyph">handoff</span><b>A subagent</b><p>A piece of work one agent hands to another. Its place is the parent job.</p></div>
  </div>
</section>

<section class="band" aria-labelledby="inbox-h">
  <div class="band__head"><span class="tag">In, and back out</span><h2 id="inbox-h">One inbox for everyone</h2>
    <p>Everything sent to anyone, person or agent, lands in one inbox that knows where each item came from. Think of a mail program: each source is an account, and there is still one combined inbox to read and search.</p></div>
  <div class="inbox">
    <div class="inbox__src">
      <h3 class="lbl">Sent to an agent</h3>
      <ul>
        {acct("pink", "thread", "A person's message in Comms")}
        {acct("amber", "discord", "A message on Discord")}
        {acct("amber", "slack", "A message on Slack")}
        {acct("violet", "trigger", "An item a trigger dropped")}
        {acct("cyan", "handoff", "A brief from another agent")}
        {acct("cyan", "answer", "A person's answer to a question")}
      </ul>
      <h3 class="lbl">Sent to a person</h3>
      <ul>
        {acct("pink", "thread", "An agent's question")}
        {acct("violet", "task", "A question on a task")}
        {acct("pink", "approval", "A request for permission")}
        {acct("amber", "secret-request", "A request for a secret")}
        {acct("cyan", "notice", "Something loom wants you to know")}
      </ul>
    </div>
    <div class="box">
      <div class="box__head"><b>The inbox</b><code>inbox</code><span class="box__find">Search everything</span></div>
      <ol>
        {item(1, "pink", "thread", "jonathan", "art", "Can you find a pump that fits the old hose?", "done")}
        {item(2, "violet", "trigger", "schedule", "art", "Start the night shift.", "done")}
        {item(3, "amber", "discord", "jonathan", "art", "Is the electrician booked for Friday?", "done")}
        {item(4, "cyan", "handoff", "art", "mark", "Compare three pump models and report back.", "taken")}
        {item(5, "pink", "thread", "art", "jonathan", "Spend up to $180 on the pump I picked?", "answered")}
        {item(6, "pink", "approval", "art", "jonathan", "Allow the merge of github:owner/repo#12?", "waiting")}
        {item(7, "cyan", "answer", "jonathan", "art", "Yes. Spend up to $180 on the pump.", "waiting")}
      </ol>
    </div>
    <div class="inbox__out">
      <h3 class="lbl">Who takes it</h3>
      <div class="node t-cyan"><i class="wire"></i>{key("Machines and jobs")}<div class="node__body"><b>An agent's body</b><span>The job working in a conversation takes the items addressed to its agent, in order, and confirms each one.</span></div></div>
      <div class="node t-cyan"><i class="wire"></i>{key("Inbox")}<div class="node__body"><b>{plink("Inbox")}, for a person</b><span>The Inbox app shows the items addressed to you that are waiting.</span></div></div>
      <ul class="inbox__notes">
        <li><b>In order</b><span>Each item keeps its place in its conversation.</span></li>
        <li><b>Never twice</b><span>Sending the same message, trigger or request again changes nothing.</span></li>
        <li><b>One search</b><span>Every source is in one table, so one search covers all of them.</span></li>
      </ul>
    </div>
  </div>
</section>

<section class="band" aria-labelledby="out-h">
  <div class="band__head"><span class="tag">Out</span><h2 id="out-h">What comes out of a conversation</h2>
    <p>Turns as it goes, a digest when a stretch of work ends, and a question in the inbox when the agent needs a person.</p></div>
  <div class="life">
    <div class="life__part">
      <div class="life__pic"><ol class="beads" aria-hidden="true">
        <li class="t-pink">message<small>person</small></li><li class="t-cyan" data-sq>action<small>agent</small></li><li class="t-cyan" data-sq>action<small>agent</small></li>
        <li class="t-cyan">reply<small>agent</small></li><li class="t-pink">message<small>person</small></li><li class="t-cyan">reply<small>agent</small></li></ol></div>
      <h3>Turns</h3>
      <p>Each thing said or done is a turn: a message, a reply, an action, a wake, a note or a refusal. Loom records who it came from, when, and how it went. A turn holds no words.</p>
    </div>
    <i class="wire t-amber"></i>
    <div class="life__part">
      <div class="life__pic"><div class="card t-amber" aria-hidden="true"><span class="lbl">Digest</span><b>Picked a pump that fits the old hose. Ready to order.</b>
        <ul><li><code>decision</code><span>The middle model, $164</span></li><li><code>task</code><span>t-2190 Order the pump</span></li><li><code>ask</code><span>Spend up to $180?</span></li></ul></div></div>
      <h3>A digest</h3>
      <p>When an agent finishes a stretch of work it writes a digest: a summary, what was decided, the tasks and projects it touched, and anything it needs from its owner.</p>
    </div>
    <i class="wire t-cyan"></i>
    <div class="life__part">
      <div class="life__pic"><div class="card t-cyan" aria-hidden="true"><span class="lbl">Inbox item · waiting</span><b>Spend up to $180 on the pump Art picked?</b>
        <span class="muted">If yes, Art orders it today. If no, Art looks for a cheaper one.</span><span class="yn"><span class="mbtn mbtn--on">Yes</span><span class="mbtn">No</span></span></div></div>
      <h3>A question</h3>
      <p>That need becomes a question in the inbox, addressed to a person, with what happens on each answer. The answer, who gave it and when are recorded on the same item, and loom adds a new item for the agent, with answer as its source, so the agent learns of it.</p>
    </div>
  </div>
</section>

<section class="band" aria-labelledby="con-h">
  <div class="band__head"><span class="tag">Connections</span><h2 id="con-h">How it connects to every other part</h2>
    <p>Each line names the column that makes the connection.</p></div>
  <ul class="ledger">
    <li>{key("Tasks", True)}<b><a href="tasks.html">Tasks</a></b><p>A task names the conversation it came from.<code>tasks.source_kind, source_id</code></p></li>
    <li>{key("Inbox", True)}<b>{plink("Inbox")}</b><p>Every inbox item names its conversation, and a digest points at the question it raised.<code>inbox.conversation · digests.inbox_item</code></p></li>
    <li>{key("Approvals", True)}<b>{plink("Approvals")}</b><p>An approval records the conversation it was asked in.<code>approvals.conversation</code></p></li>
    <li>{key("Tempo", True)}<b>{plink("Tempo")}</b><p>A trigger drops an item into the conversation's inbox, and a non-empty inbox starts the agent.<code>inbox.source = trigger</code></p></li>
    <li>{key("Changes", True)}<b>{plink("Changes")}</b><p>A thread keeps the pull requests it mentions and shows them as cards.<code>thread_refs.ref</code></p></li>
    <li>{key("Machines and jobs", True)}<b>{plink("Machines and jobs")}</b><p>A job works in one conversation, and a conversation points at the job working in it now.<code>jobs.conversation · conversations.job</code></p></li>
    <li>{key("Discord and Slack", True)}<b>{plink("Discord and Slack")}</b><p>Each incoming message goes into one conversation.<code>bridge_incoming.conversation</code></p></li>
    <li>{key("Secrets", True)}<b>{plink("Secrets")}</b><p>A request for a secret records the conversation it was asked in.<code>secret_requests.conversation</code></p></li>
    <li>{key("Memory", True)}<b>{plink("Memory")}</b><p>A session leaves a short note for the next one, and Activity builds each day from them.<code>in the agent's own files</code></p></li>
    <li>{key("People and projects", True)}<b>{plink("People and projects")}</b><p>A conversation belongs to one agent, and optionally to a project or privately to one member.<code>conversations.agent, project, member</code></p></li>
  </ul>
</section>

<div class="ref">
  <section class="ref__col" aria-labelledby="see-h">
    <h2 id="see-h">Who can see this</h2>
    <div class="labels"><span class="t-cyan">agent</span><span class="t-violet">project</span><span class="t-pink">member, when private</span></div>
    <ul class="see">
      <li><span class="key key--sm t-ink" aria-hidden="true">a</span><span><b>Three labels.</b> Each conversation carries its agent, its project if it has one, and a member when it is private to one person.</span></li>
      <li><span class="key key--sm t-ink" aria-hidden="true">b</span><span><b>Who sees it.</b> A household owner sees everything, including another member's private thread. Anyone else sees conversations in their projects and conversations of agents they own.</span></li>
      <li><span class="key key--sm t-ink" aria-hidden="true">c</span><span><b>Private.</b> A thread in loom is private to its member. Private to a member means that member plus household owners.</span></li>
      <li><span class="key key--sm t-ink" aria-hidden="true">d</span><span><b>Checked at the door.</b> Loom applies this to callers from outside: a person, an agent, a machine, someone's own program. Loom's own parts read without asking.</span></li>
      <li><span class="key key--sm t-ink" aria-hidden="true">e</span><span><b>Words.</b> Message words are kept for the household's keep time, 14 days at most, then removed. They are encrypted where they are stored.</span></li>
    </ul>
  </section>
  <section class="ref__col" aria-labelledby="data-h">
    <h2 id="data-h">Data model</h2>
    <p class="muted">Thirteen tables. Open one to see its columns, what each means and what it points to.</p>
    {data_model(groups, "pink")}
    <p class="note">The tables that track what an inbox item is about and who has read it are on the {plink("Inbox")} page.</p>
  </section>
</div>
{foot(1)}
'''
    return page(1, "Conversations · loom", body)

# ───────────────────────── tasks
def tasks():
    def f(label, n, on=False):
        return f'<div class="sp__f"{" data-on" if on else ""}><span>{label}</span><em>{n}</em></div>'
    mock = f'''<div class="tile__body sp">
      <div class="sp__nav">
        <div class="sp__search">Search tasks</div>
        {f("Ready", 4, True)}{f("In progress", 2)}{f("Needs Jonathan", 1)}{f("All open", 9)}{f("Recently closed", 3)}
        <span class="lbl">Projects</span>{f("loom", 3)}{f("pond", 6)}
        <span class="lbl">Epics</span>{f("Get the pond working again", 5)}
      </div>
      <div class="sp__list">
        <div class="sp__top"><b>Tasks</b><em>4</em><span class="mbtn">Create task</span></div>
        <div class="sp__chips"><span data-on>Ready 4</span><span>In progress 2</span><span>Needs Jonathan 1</span><span>All open 9</span></div>
        <div class="row" data-on><b>Pick a replacement pond pump</b><span>One pump chosen that fits the existing hose.</span><em>t-2188 · P1 · open</em></div>
        <div class="row"><b>Order the pump</b><span>The pump is on its way.</span><em>t-2190 · P1 · open</em></div>
        <div class="row"><b>Book the electrician for the outdoor socket</b><span>The socket by the pond is safe to use.</span><em>t-2175 · P2 · open</em></div>
        <div class="row"><b>Write the winter pond checklist</b><span>Nothing gets forgotten when it freezes.</span><em>t-2193 · P3 · open</em></div>
      </div>
      <div class="sp__read">
        <span class="meta">t-2188 · task</span>
        <h4>Pick a replacement pond pump</h4>
        <span class="meta">open · P1 · pond</span>
        <div class="sp__acts"><span class="mbtn">Claim</span><span class="mbtn">Close</span><span class="mbtn">Comment</span><span class="mbtn">Edit</span><span class="mbtn">Priority</span><span class="mbtn">Project</span></div>
        <dl class="kv">
          <dt>Goal</dt><dd>One pump chosen that fits the existing hose.</dd>
          <dt>Why</dt><dd>The old pump failed and the water is turning green.</dd>
          <dt>Done when</dt><dd>The choice and its price are in a comment.</dd>
          <dt>Parent</dt><dd>Get the pond working again <span class="chip">t-2101</span></dd>
          <dt>Blocked by</dt><dd>None</dd>
        </dl>
        <div class="cmt"><span class="lbl">Comments</span><p><b>art</b> <em>11/12/2026, 9:14:00 AM CT</em><br>Compared three models. The middle one fits the hose and is in stock.</p></div>
      </div>
    </div>'''

    def row(code, value, left="", right="", tint=""):
        cls = f' class="anat__row {tint}"' if tint else ' class="anat__row"'
        return (f'<div{cls}><div class="anat__side anat__l {tint}">{left}</div><div class="anat__f"><code>{code}</code><span>{value}</span></div>'
                f'<div class="anat__side anat__r {tint}">{right}</div></div>')
    def lnode(title, text, link=None):
        name = f'<a href="{link}">{title}</a>' if link else title
        return f'{key(title)}<div class="node__body"><b>{name}</b><span>{text}</span></div><i class="wire"></i>'
    def rnode(title, text, link=None):
        name = f'<a href="{link}">{title}</a>' if link else title
        return f'<i class="wire"></i>{key(title)}<div class="node__body"><b>{name}</b><span>{text}</span></div>'

    anat = "".join([
        '<div class="anat__row"><div class="anat__side anat__l"></div><div class="anat__f"><code>t-2190 · task</code><b>Order the pump</b></div><div class="anat__side anat__r"></div></div>',
        row("status, priority", "open · P1 <small>0 to 4, lower is more urgent</small>"),
        row("owner, project", "agent art · pond", left=lnode("People and projects", "Every task has an owner. Its project, or else its owner, decides who sees it.", FILE["People and projects"]), tint="t-amber"),
        row("source", "conversation cv-1a2b3c4d5e6f", right=rnode("Conversations", "A task names the conversation it came from.", "conversations.html"), tint="t-pink"),
        row("assignee", "member jonathan <small>who holds it right now</small>"),
        row("goal, why, done_when", "The pump is on its way. <small>the plain summary</small>"),
        row("ask, if_yes, if_no", "Spend up to $180 on the pump Art picked?", left=lnode("Inbox", "The question also appears in that person's Inbox.", FILE["Inbox"]), tint="t-cyan"),
        row("task_links", "child of t-2101 · blocks t-2195", right=rnode("Tasks", "Other tasks. One parent at most, any number of blockers."), tint="t-violet"),
        row("task_comments", "2 comments, oldest first"),
        row("change_tasks", "named by github:owner/repo#12", left=lnode("Changes", "A pull request that mentions the task is linked to it.", FILE["Changes"]), tint="t-pink"),
    ])

    tree = '''<svg class="tree" viewBox="0 0 300 186" role="img" aria-label="An epic with three child tasks. One child blocks another.">
      <path class="pc" d="M150 40 C150 74,50 74,50 108"/><path class="pc" d="M150 40 V108"/><path class="pc" d="M150 40 C150 74,250 74,250 108"/>
      <g class="n epic"><rect x="62" y="8" width="176" height="32"/><text x="150" y="23">Get the pond working</text><text class="s" x="150" y="35" style="fill:currentColor;opacity:.85">epic · never ready</text></g>
      <g class="n"><rect x="6" y="108" width="88" height="36"/><text x="50" y="124">Order pump</text><text class="s rd" x="50" y="137">ready</text></g>
      <g class="n blocked"><rect x="106" y="108" width="88" height="36"/><text x="150" y="124">Install pump</text><text class="s blt" x="150" y="137">blocked</text></g>
      <g class="n"><rect x="206" y="108" width="88" height="36"/><text x="250" y="124">Checklist</text><text class="s rd" x="250" y="137">ready</text></g>
      <path class="bl" d="M50 144 C50 172,150 172,150 151"/><path class="blh" d="M150 145 l-5 8 h10z"/>
      <text class="s blt" x="100" y="181">blocks</text>
    </svg>'''

    tchat = chat("Pond pump", c_me("Can you find a pump that fits the old hose?") + c_art('Three fit. I filed <span class="chip">t-2188</span> to pick one.')
                 + c_ref("Task", "Pick a replacement pond pump", "open") + c_work(("Pick a replacement pond pump", "open · t-2188 · Made here")))
    hero = hero_two(NUM["Tasks"], "violet", "an app", "Tasks", "<b>The household's work queue.</b> A task is one piece of work with a plain title, a goal and a reason.",
        ["Shows what is ready to pick up, most urgent first.", "Lets a person or an agent claim work, comment on it, close it, and hand it back or reopen it.",
         "Groups work under a parent and holds back what is blocked.", "Carries a question to a person when the work needs a decision."],
        tile("violet", "tasks", "Tasks", mock), tchat,
        "One task shown two ways, with example content. In a chat a task is a reference: its card shows the title and state and opens the tile, where it is claimed and closed. The thread also lists the work made in it.", "Tasks")
    body = f'''
{hero}

<section class="band" aria-labelledby="con-h">
  <div class="band__head"><span class="tag">Connections</span><h2 id="con-h">How a task connects to other parts</h2>
    <p>One task, with a thread from each field that reaches outside the Tasks app. The number on each part is its page on the path.</p></div>
  <div class="anat">{anat}</div>
</section>

<section class="band" aria-labelledby="how-h">
  <div class="band__head"><span class="tag">How it works</span><h2 id="how-h">Ready, blocked, comments and questions</h2>
    <p>Four behaviours cover what the app does.</p></div>
  <div class="how">
    <div class="how__p t-violet">
      <h3>Ready</h3>
      <div class="how__pic" aria-hidden="true">
        <ul class="gate"><li>It is open</li><li>It is not an epic</li><li>No open task blocks it</li></ul>
        <span class="stamp">READY</span>
        <div class="flow"><span>open</span><i class="wire"><em>claim</em></i><span>in progress</span><i class="wire"><em>close</em></i><span>closed</span></div>
      </div>
      <p>A task is ready when it is open, is not an epic and nothing blocks it. Claiming it moves it to in progress, and unclaiming puts it back. Closing it takes a reason, and the reason cancelled marks it cancelled. A closed task can be reopened.</p>
    </div>
    <div class="how__p t-amber">
      <h3>Parents and blockers</h3>
      <div class="how__pic">{tree}</div>
      <p>A task sits under one parent at most. An epic groups other tasks and is never ready itself. A blocked task waits until the task blocking it closes.</p>
    </div>
    <div class="how__p t-cyan">
      <h3>Comments</h3>
      <div class="how__pic" aria-hidden="true">
        <div class="cmt" style="border:0;padding:0"><p><b>art</b> <em>9:14 AM</em><br>Compared three models. The middle one fits the hose.</p></div>
        <div class="cmt"><p><b>jonathan</b> <em>9:40 AM</em><br>Go with that one.</p></div>
      </div>
      <p>People and agents leave comments as work moves. Loom keeps them in order, oldest first, each with who wrote it and when.</p>
    </div>
    <div class="how__p t-pink">
      <h3>A question for a person</h3>
      <div class="how__pic" aria-hidden="true">
        <div class="card t-cyan" style="flex:none"><span class="lbl">Question for Jonathan</span><b>Spend up to $180 on the pump Art picked?</b>
          <span class="muted">If yes, Art orders it today. If no, Art looks for a cheaper one.</span></div>
        <div class="node t-cyan"><i class="wire" style="flex:0 0 40px"></i>{key("Inbox", True)}<div class="node__body"><span>Also in Jonathan's Inbox</span></div></div>
      </div>
      <p>A task can carry one question, with what happens on yes and on no. The person answers yes or no, or in words. The question also appears in that person's Inbox.</p>
    </div>
  </div>
</section>

<div class="ref">
  <section class="ref__col" aria-labelledby="see-h">
    <h2 id="see-h">Who can see this</h2>
    <div class="labels"><span class="t-violet">project</span><span class="t-cyan">owner</span></div>
    <ul class="see">
      <li><span class="key key--sm t-ink" aria-hidden="true">a</span><span><b>Every task has an owner.</b> A member, an agent or the household. There is no task without one.</span></li>
      <li><span class="key key--sm t-ink" aria-hidden="true">b</span><span><b>Who sees it.</b> Its project's people when it has a project. Otherwise its owner, and for an agent's task, that agent's owners. Household owners always.</span></li>
      <li><span class="key key--sm t-ink" aria-hidden="true">c</span><span><b>Checked at the door.</b> Loom applies this to callers from outside: a person, an agent, a machine, someone's own program. Loom's own parts read tasks without asking.</span></li>
    </ul>
  </section>
  <section class="ref__col" aria-labelledby="data-h">
    <h2 id="data-h">Data model</h2>
    <p class="muted">Three tables. Open one to see its columns, what each means and what it points to.</p>
    {data_model([("", ["tasks", "task_links", "task_comments"])], "violet")}
    <p class="note">Status, priority, project, owner and assignee are columns, so the ready queue, a project's task list and a person's assignments are each one query.</p>
  </section>
</div>
{foot(NUM["Tasks"])}
'''
    return page(NUM["Tasks"], "Tasks · loom", body)

JS = '''// Theme switch (data-theme on <html>, remembered per browser) and opening a table when a link points at it.
(function(){
  var root=document.documentElement;
  try{var saved=localStorage.getItem('loom-docs-theme');if(saved==='light'||saved==='dark')root.setAttribute('data-theme',saved);}catch(e){}
  function now(){return root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}
  function openTarget(){var el=location.hash.length>1&&document.getElementById(location.hash.slice(1));if(el&&el.tagName==='DETAILS'){el.open=true;el.scrollIntoView({block:'nearest'});}}
  document.addEventListener('DOMContentLoaded',function(){
    var b=document.getElementById('theme');
    function label(){if(b)b.textContent=now()==='dark'?'Light':'Dark';}
    label();
    if(b)b.addEventListener('click',function(){var next=now()==='dark'?'light':'dark';root.setAttribute('data-theme',next);try{localStorage.setItem('loom-docs-theme',next);}catch(e){}label();});
    openTarget();
  });
  addEventListener('hashchange',openTarget);
})();
'''

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    import pages2
    for name, text in [("index.html", index()), ("conversations.html", conversations()), ("tasks.html", tasks()), ("site.js", JS)] + pages2.pages():
        with open(os.path.join(OUT, name), "w") as fh:
            fh.write(text)
        print("wrote", name, len(text))

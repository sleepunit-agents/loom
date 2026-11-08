#!/usr/bin/env python3
"""
Generate assets/demo.cast — an asciinema v2 recording of the loom
install → wake → remember → recall demo.

Run from the repo root:
    python3 scripts/gen-demo.py

The output file is suitable for:
  asciinema play assets/demo.cast
  asciinema upload assets/demo.cast   (then embed the returned URL)
"""

import json

COLS = 100
ROWS = 28
TITLE = "loom: install → wake → remember → recall"
TIMESTAMP = 1745433600  # 2026-04-23 12:00:00 UTC

# ANSI helpers
RESET   = "\x1b[0m"
BOLD    = "\x1b[1m"
DIM     = "\x1b[2m"
GREEN   = "\x1b[32m"
BGREEN  = "\x1b[1;32m"
BLUE    = "\x1b[34m"
BBLUE   = "\x1b[1;34m"
CYAN    = "\x1b[36m"
BCYAN   = "\x1b[1;36m"
YELLOW  = "\x1b[33m"
BYELLOW = "\x1b[1;33m"
MAGENTA = "\x1b[35m"
WHITE   = "\x1b[37m"
BWHITE  = "\x1b[1;37m"
RED     = "\x1b[31m"

PROMPT = f"{BGREEN}~{RESET} {BBLUE}${RESET} "

events = []
t = 0.0


def emit(text, delay=0.0):
    global t
    t += delay
    events.append([round(t, 3), "o", text])


def newline(extra_delay=0.0):
    emit("\r\n", extra_delay)


def pause(seconds):
    global t
    t += seconds


def type_cmd(cmd, char_delay=0.07, space_extra=0.05):
    """Simulate typing a command char by char with natural pauses at spaces."""
    for i, ch in enumerate(cmd):
        emit(ch, char_delay)
        if ch == " " and i > 0:
            pause(space_extra)


def show_prompt(delay=0.4):
    emit(PROMPT, delay)


def run_cmd(cmd, char_delay=0.07, pre_run_pause=0.4):
    """Type a command, press Enter."""
    type_cmd(cmd, char_delay)
    pause(pre_run_pause)
    emit("\r\n")


def divider(char="─", width=None, color=DIM, delay=0.0):
    w = width or (COLS - 4)
    emit(f"{color}{char * w}{RESET}", delay)
    newline()


def line(text="", delay=0.05):
    emit(text, delay)
    newline()


# ─── HEADER ──────────────────────────────────────────────────────────────────

header = {
    "version": 2,
    "width": COLS,
    "height": ROWS,
    "timestamp": TIMESTAMP,
    "title": TITLE,
}

# ─── DEMO ────────────────────────────────────────────────────────────────────

# Clear + title pause
emit("\x1b[2J\x1b[H", 0.5)
pause(0.5)

line(f"{DIM}# loom — persistent identity + memory for AI agents{RESET}", 0.0)
line(f"{DIM}# demo: install → wake → remember → recall{RESET}", 0.08)
newline(0.8)

# ── Step 1: Install ──────────────────────────────────────────────────────────

show_prompt(0.6)
run_cmd("npx loomai install --harness claude-code", char_delay=0.07)
pause(1.0)

# npm "need to install" boilerplate
line(f"{DIM}Need to install the following packages:{RESET}", 0.1)
line(f"{DIM}  loomai@0.4.0-alpha.7{RESET}", 0.06)
emit(f"{DIM}Ok to proceed? (y) {RESET}")
pause(0.8)
emit("y")
newline()
newline(0.5)

# Install output
line(f"{GREEN}✔{RESET} Wrote {BWHITE}~/.claude/skills/loom-setup.md{RESET}", 0.2)
newline(0.1)
line(f"{BOLD}Next:{RESET} open Claude Code. {CYAN}/loom-setup{RESET}.", 0.1)
line(f"{DIM}After the skill finishes, restart Claude Code (close and reopen).{RESET}", 0.08)
newline()

pause(2.0)

# ── Step 2: Inside Claude Code / loom-setup ──────────────────────────────────

newline(0.3)
divider("─", COLS - 2, DIM, delay=0.0)
line(f"{DIM}  Claude Code  ·  {BOLD}/loom-setup{RESET}", 0.05)
divider("─", COLS - 2, DIM, delay=0.0)
newline(0.5)

pause(0.8)
emit(f"{DIM}Checking environment...{RESET}", 0.0)
pause(1.2)
emit(f" {YELLOW}loom MCP not yet wired up (expected on first run){RESET}")
newline(0.4)
newline(0.3)

line(f"{BOLD}Let's set up your agent.{RESET}", 0.1)
newline(0.6)

# Interview — user types answers slowly (simulating real input)
emit(f"{BWHITE}Agent name:{RESET} ", 0.2)
pause(1.5)
type_cmd("alex", char_delay=0.12)
newline()

pause(0.4)
emit(f"{BWHITE}Purpose (one line):{RESET} ", 0.2)
pause(1.8)
type_cmd("Personal assistant and coding partner", char_delay=0.07)
newline()

pause(0.4)
emit(f"{BWHITE}Voice:{RESET} ", 0.2)
pause(1.4)
type_cmd("Direct, precise, a bit dry", char_delay=0.09)
newline()

pause(0.4)
emit(f"{BWHITE}Clients (e.g. claude-code):{RESET} ", 0.2)
pause(1.2)
type_cmd("claude-code", char_delay=0.09)
newline()
newline(0.6)

# Bootstrap results
pause(0.7)
line(f"{GREEN}✔{RESET} Identity initialized for {BOLD}alex{RESET}", 0.0)
line(f"{GREEN}✔{RESET} {DIM}IDENTITY.md, preferences.md, self-model.md → ~/.config/loom/alex/{RESET}", 0.15)
line(f"{GREEN}✔{RESET} {DIM}MCP config written to ~/.mcp.json{RESET}", 0.15)
line(f"{GREEN}✔{RESET} {DIM}~/.claude/CLAUDE.md updated with identity pointer{RESET}", 0.15)
newline(0.4)

line(f"{BYELLOW}Restart Claude Code now to activate loom.{RESET}", 0.1)
newline()

pause(3.5)

# ── Step 3: New Session — Wake ────────────────────────────────────────────────

newline(0.3)
divider("─", COLS - 2, DIM, delay=0.0)
line(f"{DIM}  Claude Code  ·  new session{RESET}", 0.05)
divider("─", COLS - 2, DIM, delay=0.0)
newline(0.5)

pause(0.7)
line(f"{DIM}[mcp__loom__identity → loading alex's identity]{RESET}", 0.0)
newline(0.5)

# Wake output — rendered slowly so viewers can read it
WAKE_LINES = [
    ("# Identity",                                  BOLD,   0.06),
    ("",                                            "",     0.05),
    ("# alex",                                      BOLD,   0.08),
    ("",                                            "",     0.08),
    ("Personal assistant and coding partner",        "",     0.08),
    ("",                                            "",     0.08),
    ("## Voice",                                    BOLD,   0.08),
    ("",                                            "",     0.08),
    ("Direct, precise, a bit dry",                  "",     0.08),
    ("",                                            "",     0.14),
    ("---",                                         DIM,    0.08),
    ("",                                            "",     0.08),
    ("# Preferences",                               BOLD,   0.08),
    ("",                                            "",     0.08),
    ("# alex — Preferences",                        BOLD,   0.08),
    ("",                                            "",     0.08),
    ("*No initial preferences set.*",               DIM,    0.08),
    ("",                                            "",     0.14),
    ("---",                                         DIM,    0.08),
    ("",                                            "",     0.08),
    ("# Self-Model",                                BOLD,   0.08),
    ("",                                            "",     0.08),
    ("## Strengths",                                BOLD,   0.08),
    ("*(Add your strengths as you discover them)*", DIM,    0.08),
]

for text, color, d in WAKE_LINES:
    if color:
        emit(f"{color}{text}{RESET}", d)
    else:
        emit(text, d)
    newline()

pause(3.0)

# ── Step 4: Remember ──────────────────────────────────────────────────────────

newline(0.3)
divider("─", COLS - 2, DIM, delay=0.0)
newline(0.3)

show_prompt()
run_cmd(
    'echo "Prefers async pair programming on weekday evenings"'
    ' | loom remember "working style" --category user',
    char_delay=0.056,
    pre_run_pause=0.4,
)
pause(0.8)

line(
    f"{GREEN}Remembered:{RESET} {DIM}user/working-style-a4f2c1{RESET}"
    f" — {BOLD}working style{RESET}",
    0.0,
)
newline(0.4)

# ── Step 5: Recall ────────────────────────────────────────────────────────────

show_prompt(0.3)
run_cmd('loom recall "pair programming"', char_delay=0.07, pre_run_pause=0.4)
pause(0.9)

line(f"Found {BOLD}1{RESET} matching memory:", 0.0)
newline(0.3)

line(f"{BOLD}## working style{RESET}", 0.0)
line(f"{DIM}user · 2026-04-23{RESET}", 0.1)
newline(0.1)
line("Prefers async pair programming on weekday evenings", 0.1)
newline(0.5)

show_prompt(0.4)
pause(3.5)

# ─── OUTPUT ──────────────────────────────────────────────────────────────────

output_path = "assets/demo.cast"

with open(output_path, "w") as f:
    f.write(json.dumps(header) + "\n")
    for ev in events:
        f.write(json.dumps(ev) + "\n")

total = round(t, 1)
print(f"Generated {output_path}  ({len(events)} events, {total}s)")

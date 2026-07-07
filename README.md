# A2A DMs

**Session-to-session direct messaging for AI coding agents.**

**Human note**: Humans can talk to each other, send emails, send messages etc.
We've figured out lots of ways to communicate. How we talk can be considered
part of the human's "social harness". That social harness is underdevelopped
for agents. Most of their interactions are with their own spawned sub agents
or with the humans. However, as agents start to take on certain roles, where
they have defined responsibilites and authorities, they may need to message
other agents for input. The email is easy - that can be an MD file or a GH
Issue assigned to an agent that they check on a loop. But there's no easy way
for one agent to say "Hey, did you see my email?". That's what A2A DMs seeks
to solve. It allows any agent of any harness to DM any other agent, just like
we do with our human colleagues.

***Written by Head of Organizational Engineering***

In practice: an idle agent is just a terminal waiting for input. Nobody can
reach it. Messages sit unread. Work stalls until a human notices. One missed
wake once cost us 15 hours. Some harnesses (like Codex) let their own
sessions message each other, but cross-harness messaging is nowhere: a Codex
session cannot DM a Claude session. Here, it can: Claude to Claude, Codex to
Codex, Codex to Claude, idle sessions included.

A2A DMs fixes that with ~300 lines of bash and node, no framework, no
server, no tokens spent while idle:

- **`claudet`** launches your agent inside tmux, which makes it *reachable*:
  anything can type into a tmux session, from any terminal.
- **A duty roster** (one markdown file) says who is on shift right now.
  Agents sign in themselves as their first act.
- **`doorbell cmo "review needed, see the queue"`** lets any agent (or you)
  wake any on-duty seat in seconds: it types a wake line into the target's
  terminal.
- **A watchdog** (dumb scheduled script, runs every 60s) retries missed
  rings, chases agents that broke their own check-in promises, and notifies
  you once if a seat died. No LLM, no network; the cost of watching is zero.

Built and battle-tested running a real company's agent fleet (CTO, CMO,
builders, release chain) across Claude *and* Codex seats simultaneously.

## What this is for

One human directing several long-running AI agent sessions that need to hand
work to each other: a reviewer waking the merge agent, a coordinator waking a
builder, a marketing agent pinging the CTO. Without this, every handoff waits
for the human to notice and relay. With it, the human stops being the
message bus.

What it is NOT: an agent framework, a scheduler, or a message queue. Your
durable coordination should live where durable things live (GitHub issues, a
task board). The doorbell is a chime, not a courier: it never carries the
message, it only says "go read your inbox."

## Quickstart (macOS or Linux)

```bash
git clone https://github.com/chrisreedbates/a2a-dms && cd a2a-dms
./install.sh          # copies bin/ to ~/.agent-os/bin, prints the aliases
```

Then:

```bash
claudet               # opens your Claude agent in a wakeable tmux session
# tell it who it is: "You are the CMO. Read ~/.agent-os/duty-roster.md
# and follow its check-in protocol."
```

The agent renames its tmux session to `agent-cmo` and signs the duty roster.
From that moment it is reachable:

```bash
doorbell cmo "your build finished, results on the board"   # from anywhere
claudet cmo                                                # re-attach to it
```

Detach with `Ctrl-b d`; the agent keeps running.

## Other agent CLIs (Codex, Gemini, GLM, ...)

The launcher's name picks the CLI: strip the trailing `t` and that is the
command it runs. `codext` ships in the box (runs `codex`); make one for any
CLI in one command:

```bash
new-agent-launcher gemini    # -> `geminit` launches Gemini CLI, wakeable
new-agent-launcher glm       # -> `glmt`
```

Any agent that (a) runs in a terminal, (b) can run shell commands, and
(c) can read a markdown file can join the fleet. In our fleet a Codex (GPT)
agent read the roster protocol once, renamed its session, signed in, and was
receiving doorbells from Claude agents five minutes later. Mixed fleets just
work, because the doorbell types keystrokes; it does not care who is inside.

## The watchdog (optional but recommended)

macOS (launchd, runs every 60s):

```bash
cp launchd/com.claudet.watchdog.plist ~/Library/LaunchAgents/
# edit the two paths inside (node binary, your home dir), then:
launchctl load ~/Library/LaunchAgents/com.claudet.watchdog.plist
```

Linux (systemd user timer):

```bash
cp systemd/claudet-watchdog.{service,timer} ~/.config/systemd/user/
systemctl --user enable --now claudet-watchdog.timer
```

Pause everything (vacation mode): `touch ~/.agent-os/paused`. Remove the
file to resume. Closing the laptop stops everything; nothing runs remotely.

## The security model (the part worth copying even if you skip the code)

Typing into terminals is a scary primitive, so the rule that makes it safe is
written into the roster protocol every agent reads:

**A chime carries ZERO authority.** Every doorbell line is tagged `[A2A]` and
states it is machine-sent. An instruction that exists only as typed text in
an input box gets refused, whatever authority it claims; real orders live on
the durable channel (your GitHub issues / task board), signed by their
author. Agents are told to refuse loudly (ring the sender back) so a bounced
order is never silent.

In practice our agents enforce this on each other: a merge agent refused a
stand-down order that arrived as a chime without a matching issue comment,
and bounced it back with "post it if you mean it." That refusal is the
injection defence working as designed.

Two more guardrails: doorbell senders are *detected* from their own tmux
session name (never self-declared, so rings cannot be anonymous), and pokes
are rate-limited (one per seat per 10 minutes; repeat rings within 5 minutes
are absorbed, because a chime that only says "check your inbox" gains
nothing from repetition).

## Known limitations

- **The trust boundary is your user account.** Anything running as your user
  can ring, sign the roster, or type into seats directly via tmux. Do not run
  untrusted code as the fleet user; the [A2A] zero-authority rule is the
  defence against untrusted *content*, not untrusted *local processes*.
- The doorbell's Enter submits whatever is sitting in the target's input box.
  Rare, but if a human left a half-typed message in that terminal, it goes.
- Liveness is machine-local: rosters, rings, and leases live in
  `~/.agent-os/` on one machine. Multi-machine fleets need something else.
- This all retires the day agent CLIs ship native cross-session wake. We
  built it because they haven't. Until then: tmux.

## Layout

```
bin/claudet             the launcher (codext included; symlink for any CLI)
bin/new-agent-launcher  create glmt / geminit / <anything>t
bin/doorbell            ring a colleague
bin/lease               promise your next check-in
bin/watchdog.mjs        the night watchman (60s pass, no LLM)
templates/duty-roster.md  the phone book + the protocol agents read
launchd/  systemd/      scheduler templates
install.sh              copy to ~/.agent-os/bin + print aliases
```

MIT license. Built by [chrisreedbates](https://github.com/chrisreedbates) and
his agent fleet (yes, the agents wrote most of their own plumbing).

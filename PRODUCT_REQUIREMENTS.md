# Continuum — Product Requirements Document

**Prepared as:** end-user functional specification
**Audience:** anyone building or evaluating Continuum against what the end user actually needs
**Status legend used throughout:**
- ✅ **Implemented** — built and verified working
- 🟡 **Partial** — some of the requirement works today, some doesn't
- ⬜ **Planned** — designed, not yet built

This document describes how Continuum *should* behave for the person actually
using it — not how the code is organized internally. For architecture and
implementation detail, see `MULTI_WORKSPACE_DESIGN.md` and `ROADMAP.md`.

---

## 1. Vision

> A developer should never have to re-explain what they were doing, re-find
> code they already found, or lose a decision they already made — regardless
> of which AI tool they're using, which project they're in, or how long it's
> been since they last opened it.

Continuum is a **personal, local** memory layer. It is not a team tool, not a
cloud service, and not tied to one AI vendor. Everything it remembers lives on
the user's own disk, inside the project it's about.

---

## 2. Who this is for

**Primary persona: a solo developer working across several related codebases.**

Concretely — someone who:
- Works on a feature that spans multiple layers (e.g. a UI repo, an API repo, a database/schema repo)
- Uses an AI coding assistant daily and is frustrated by it forgetting context between sessions
- Sometimes works on one of those repos alone, sometimes together with the others, sometimes switches to an unrelated project entirely
- Wants to trust that a system understands their code and their history without having to babysit it

This document is written entirely from this person's point of view. Every
requirement below answers: *"What should happen when I do X?"*

---

## 3. Core user journeys

### Journey A — First-time setup

**As a user, when I decide to use Continuum on a project, I should be able to
turn it on with one command and never think about configuration again.**

| Requirement | Status |
|---|---|
| I run one command inside my project and everything is configured — no manual file paths, no editing JSON by hand | ✅ |
| The system figures out my project's root on its own, whether that's a git repo, an npm package, a .NET solution, or just a folder I've chosen | ✅ |
| Running the setup command again later doesn't break or duplicate anything | ✅ |
| I can ask the system to tell me whether setup actually worked, without guessing | ✅ (`continuum status`) |
| Setup works the same way regardless of which AI tool I'm using (Claude Code, Cursor, Copilot, etc.) | 🟡 — Claude Code is fully automatic; other tools require me to hand-configure the connection myself |

---

### Journey B — Working normally, day to day

**As a user, I should be able to code normally and have my work remembered
without doing anything extra.**

| Requirement | Status |
|---|---|
| Every file I edit is automatically noted as part of my current work — I never manually mark "I touched this file" | ✅ |
| If a command or tool I ran failed, that failure is remembered too, so I don't have to re-explain what went wrong | ✅ |
| I can still explicitly tell the system "here's what I'm working on and why," for cases where I want to be deliberate about it | ✅ (`save_task`) |
| I can search my codebase by name and get real results — including when I only remember part of a name, or the wrong casing | ✅ |
| I can ask "what does this file depend on, and what depends on it" and get a real, current answer | ✅ (single-project) |
| If I accidentally let something get indexed that shouldn't have been (a secret, a generated file), I can remove it and there's a record of that removal | ✅ (`forget`) |

---

### Journey C — Recovering after a break

**As a user, when I come back — after a compaction, after closing my editor,
after a week away — I should pick up exactly where I left off.**

| Requirement | Status |
|---|---|
| When my AI assistant's context window fills up and compacts, I don't have to re-explain my goal, my decisions, or which files I was working on | ✅ (`PreCompact` hook) |
| When I close my editor and reopen the same project shortly after, my session continues rather than starting over | ✅ (within a configurable resume window) |
| When I start a brand-new AI session on a project I've worked on before, it should already know the important things — not just the last five minutes, but the accumulated story | ✅ (`context.md` injected on session start) |
| That accumulated memory should be something I can actually read myself, in plain language, not locked inside a database I can't open | ✅ (`.continuum/context.md`) |
| I should be able to correct or add to that memory by hand, and have my edits respected rather than silently overwritten | ✅ (`@manual` sections) |
| If I'm working on two different efforts in the same repo (e.g. a feature branch and a quick hotfix on main), my memory of one shouldn't bleed into the other | ⬜ — today, all work in the same repo shares one memory regardless of branch |

---

### Journey D — Not paying to re-learn what it already knows

**As a user, every time my AI assistant needs to understand my code or my
history, it should cost as little as possible — it shouldn't have to re-read
whole files or have context re-explained to it when a compact answer would do.**

This is the actual point of the whole tool, not a side benefit — the reason
Continuum exists at all is that re-reading files and re-explaining context
*costs real tokens, real time, and real money*, every single time it happens.

| Requirement | Status |
|---|---|
| When the AI needs to know what's in a file, it should get a compact summary — names, kinds, line numbers — instead of the file's full contents, whenever that's enough to answer the question | ✅ — search and symbol tools return structured summaries, not full file bodies |
| When the AI resumes a session, it shouldn't need to re-read files it already worked on just to remember what it was doing | ✅ — session and memory recovery carry that information directly, without touching the file system |
| The AI should be able to check whether it already looked at a file before deciding to read it again | 🟡 — the tool to check exists; nothing forces the AI to actually use it before reading, so it's a courtesy, not a guarantee |
| I should be able to see real numbers on how many tokens my session's memory tool calls have cost | ✅ — session reporting shows actual measured tokens, not an estimate (an earlier, made-up version of this number was found and replaced with a real one) |
| I should be able to see real numbers on how many tokens were *saved* by having Continuum, compared to not having it | ⬜ — no such comparison exists yet; nothing measures "with vs. without," so there is currently no proof behind any savings claim, only a reasonable-sounding structural argument |
| The memory system itself shouldn't become an expensive thing to load — injecting accumulated history shouldn't quietly grow into a large token cost over a long-lived project | 🟡 — the injected memory is deliberately capped and old detail is trimmed, but nothing actively measures whether that cap is actually keeping the real cost small over months of use |

**The one gap that matters most here:** there is no benchmark. Every efficiency
claim about Continuum today is a reasonable argument, not a measured fact. A
believable savings number requires comparing the same task done twice — once
with only ordinary file-reading tools, once with Continuum's tools — and
counting the actual token difference. Until that exists, "this saves tokens"
should be said as a design intent, not a proven result.

---

### Journey E — Working across multiple related repos

**As a user whose feature spans several repositories, I should be able to
treat them as one connected effort when I want to, without losing each repo's
own separate identity when I don't.**

| Requirement | Status |
|---|---|
| I can group several repos together (e.g. under one parent folder) and search/remember across all of them as a single effort | ✅ — works today via one shared index for everything under a common root |
| If I add a new repo to that group later, the system notices and starts including it — without me restarting anything | ⬜ |
| If I open one of those repos by itself another time, its memory should still be the *same* memory, not a disconnected second copy | ⬜ — currently, opening a repo alone after grouping it (or vice versa) creates a separate history |
| When a search result comes from a multi-repo group, I should be able to tell which repo it actually came from | 🟡 — the file path implies it, but it isn't called out explicitly |
| Working across several repos shouldn't use meaningfully more memory or slow down my machine compared to working in just one | 🟡 — true today because it's one shared index; needs re-verification once repos are tracked separately (see below) |

---

### Journey F — Trusting the system

**As a user, I should never have to wonder whether Continuum is actually
working, or quietly doing the wrong thing.**

| Requirement | Status |
|---|---|
| I can check, at any time, whether the system is running, healthy, and pointed at the right project | ✅ (`continuum status`) |
| If a file gets deleted, the system should stop remembering things about it rather than surfacing stale results forever | ✅ |
| If my database ever becomes corrupted, the system should tell me clearly and recover gracefully rather than fail silently or crash | ✅ |
| If something in the setup isn't wired correctly (e.g. a hook is missing), I should be told plainly, not have to discover it by noticing something didn't happen | ✅ (`continuum status` reports hook wiring) |
| The system shouldn't leave orphaned processes running in the background indefinitely as I open and close projects over time | ⬜ — confirmed issue: multiple leftover processes can accumulate across editor restarts with no cleanup |
| I should be able to trust that closing one project and opening another doesn't leak information between them | ✅ — each project's memory is a physically separate file; there is no shared store to leak from |

---

## 4. Non-functional expectations

| Expectation | Status |
|---|---|
| **Everything stays on my machine.** No project's code or history is ever sent to an external server. | ✅ |
| **Nothing requires an account, API key, or subscription** to use the core memory and search features. | ✅ |
| **Setup takes one command and one editor restart** — not a checklist. | ✅ |
| **The system should degrade gracefully**, not crash, if something unexpected happens (corrupted file, missing hook script, unreachable external database). | ✅ |
| **Opening several projects at once shouldn't cause noticeably higher memory or CPU use** than opening them one at a time over the same period. | 🟡 — true for the common case today; unverified at larger scale (many repos open at once) |
| **A build from source should complete reliably** on an ordinary developer machine without manual tuning. | 🟡 — the build has intermittently required a larger-than-default memory allocation to complete |

---

## 5. Explicitly out of scope

Stated plainly so it isn't quietly expected later:

- **This is not a team tool.** Memory is not shared between users, synced to a server, or committed to a shared repository. If two people work on the same project, they each have their own separate memory.
- **This does not replace version control.** It remembers decisions and context, not code history — that's what git is for.
- **This does not require or depend on any specific AI vendor.** The automatic, no-effort capture (hooks) currently depends on Claude Code's specific hook system; the core search and memory tools work with any MCP-compatible client.

---

## 6. What "done" looks like for this document

This PRD should be considered satisfied when every row above reads ✅. At the
time of writing, the biggest gaps are:

1. **Branch-aware memory** (Journey C) — smallest fix, highest day-to-day value for anyone who switches between features often.
2. **A real token-savings benchmark** (Journey D) — costs nothing to build relative to its importance: without it, the tool's core promise is an argument, not a proven fact.
3. **Live multi-repo detection and per-repo identity without fragmentation** (Journey E) — the largest piece of remaining work, and the one that matters most for anyone whose real work spans more than one repository.
4. **Process lifecycle hygiene** (Journey F) — smaller, but a real trust issue once noticed.
5. **Setup parity across AI tools** (Journey A) — matters for anyone not using Claude Code as their primary client.

Everything else described in this document is already true today.

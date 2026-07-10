# Multi-Workspace Architecture — Design Discussion

> Status: **discussion draft, not committed.** Purpose: think through every real
> usage shape before writing code, so we don't build the roots-based mechanism
> from last turn on top of a storage model that doesn't actually fit. Once
> reviewed, the agreed pieces move into `ROADMAP.md` and this file is deleted —
> it is not meant to become a second permanent planning doc.

---

## The core tension, stated plainly

Two things are both true and in conflict:

1. **A project's memory should be a stable, permanent thing.** Decisions about
   the API shouldn't vanish or duplicate depending on what other folders
   happened to be open in the IDE that day.
2. **A developer's *session* is fluid.** Today it's UI+API+DB together for one
   feature. Tomorrow it's just the API repo alone fixing a bug. Next week it's
   UI+API+a-different-service for a different feature.

If memory is scoped to "whatever's in the workspace right now" (the model we
discussed for `WATCH_PATHS`/multi-root), then the **same repo's memory
fragments** every time the grouping around it changes. Open API alone today →
one `.continuum/knowledge.db` under API. Open API+UI tomorrow → a *different*
combined database, unaware of yesterday's API-only session. The project's
identity keeps getting redefined by its current neighbors.

**The fix: decouple "what is a project" from "what's in my workspace right now."**

---

## The principle: per-repo memory is the atomic, permanent unit

A repo's memory belongs to *that repo* — identified by its own root marker
(`.git`, etc.) — and never changes based on what else is open alongside it.

```
~/projects/WebAPI/.continuum/knowledge.db        ← always WebAPI's memory, period
~/projects/WebAPP/.continuum/knowledge.db        ← always WebAPP's memory, period
~/projects/Databaseapp/.continuum/knowledge.db   ← always Databaseapp's memory, period
```

Whether you open WebAPI alone, or WebAPI+WebAPP together, or all three, or
WebAPI alongside some unrelated fourth project — **WebAPI's database is always
the same file, in the same place, with the same history.** Nothing about its
own identity depends on the shape of today's workspace.

**What changes based on the workspace is not storage — it's which databases
are currently "in view."** The workspace (single-root, multi-root, added/removed
folders) determines *which* per-repo databases the running server has open and
fans queries out to. It's a live session concern, not a storage concern.

This single decision resolves most of the hard cases below — but it isn't the
whole story. There are actually **two separate things living inside one
`.continuum/knowledge.db`** that need different identities, not one:

- **The code/symbol index** — genuinely permanent per repo, branch-agnostic.
  Checking out a different branch just changes file contents; the incremental
  parser's hash-based reparse naturally keeps the index reflecting whatever's
  currently on disk. No fragmentation risk here, nothing to change.
- **Session/task memory** (`sessions`, `tasks`, `context.md`'s Active
  Work/Decisions) — this is *not* just per-repo, it's per **unit of work**,
  and a git branch is the natural, already-available signal for that. See
  Case 9 below — this was missing from the original draft and changes the
  schema, not just the query layer.

---

## Case-by-case walkthrough

### Case 1: Single repo, single window — the baseline
Already correct today (post `continuum init`). One root, one DB, no change needed.

### Case 2: Same repo, two windows open simultaneously
Already analyzed and tested — both processes converge on the same `.continuum/knowledge.db`
and the same session row by timestamp coincidence. Under the per-repo model this
stays exactly right: there's only ever one canonical DB for that repo, so two
windows sharing it is correct, not an accident. (The earlier finding about
duplicate `chokidar` watchers wasting CPU still stands and is worth fixing
separately — see Open Questions.)

### Case 3: Multi-root workspace — three repos, one feature (your actual case)
This is the one the old shared-`WATCH_PATHS` model got structurally wrong (one
DB owns three unrelated identities) and the naive "one DB per workspace"
alternative also gets wrong (fragments each repo's history by session).

**Correct shape:** the server, on learning (via MCP `roots/list`, per last
turn's discussion) that WebAPI + WebAPP + Databaseapp are all active right
now, opens **three separate SQLite connections** — one per repo, each to its
own permanent `.continuum/knowledge.db` — inside **one server process**. It
does not create a fourth, combined database.

- `search_symbols("UserService")` fans out across all three open connections,
  tags each result with which repo it came from, merges and returns one list.
- `get_session` similarly aggregates: "here's what's active in WebAPI, here's
  what's active in WebAPP, here's what's active in Databaseapp" — three
  sections, not one merged blob.
- File watching: one `chokidar` instance *can* watch all three root paths at
  once (it already supports an array of paths); the server just needs to map
  each changed file back to which repo's root it falls under, and write
  symbols to *that* repo's DB specifically, never a shared one.

### Case 4: The same repo, opened alone yesterday, as part of a group today
Under the per-repo model, this is a non-issue. WebAPI's database is the same
file regardless. Yesterday's solo session and today's group session both read
and write the same `WebAPI/.continuum/knowledge.db` — continuity preserved,
zero fragmentation, zero duplication.

### Case 5: A folder added mid-session (new repo joins the workspace)
This is exactly what the MCP `notifications/roots/list_changed` mechanism
from last turn is for. When it fires: detect the new root, check whether
`<newRoot>/.continuum/knowledge.db` already exists (resume its history) or
needs creating (fresh repo, first time seen), open a connection to it, add its
path to the live `chokidar` watcher, and it's now "in view" for search/session
aggregation — without restarting anything.

### Case 6: A folder removed mid-session (window closes a workspace folder)
Symmetric to Case 5: on the corresponding roots-changed notification, stop
watching that path and close (not delete) that repo's DB connection. Its
`.continuum/knowledge.db` file is untouched on disk — it's simply no longer
"in view" until it's reopened later, alone or in some other grouping.

### Case 7: Nested/overlapping roots (a monorepo, or a workspace folder that's a subdirectory of another watched root)
Real risk if not handled: if `~/projects/Monorepo` is one root and
`~/projects/Monorepo/packages/api` is *also* independently registered as a
root (e.g. a multi-root workspace listing both the monorepo and one of its own
subpackages), the same files get watched and indexed twice — once under each
root's DB — wasting work and creating two disagreeing "owners" for the same
symbols.

**Needed:** before opening a new root's connection, check whether it's a
subpath of an already-open root (or vice versa) and skip opening a redundant
one — the outer root already covers it. This needs an explicit containment
check in whatever component manages the set of currently-open per-repo DBs.

### Case 8: Cross-cutting decisions that don't belong to one repo
"We're doing JWT refresh rotation across the whole stack" isn't a WebAPI fact
or a WebAPP fact — it's about how they fit together. Forcing `save_task` to
pick exactly one owning repo loses this.

**Proposed handling:** `save_task` gains an implicit or explicit scope:
- If the AI names one repo, or the decision is clearly about one file, it goes
  into that repo's own `tasks` table only (the common case).
- If it's explicitly cross-cutting, the same task entry is written into
  *every currently-open* repo's `tasks` table (small, deliberate duplication —
  cheap, since tasks are tiny compared to symbol indexes, and each repo's
  history should show "we made this decision while working across the stack,"
  whichever repo you're looking at it from later).
- No new "workspace-level" database is introduced for this. Duplication into
  existing per-repo storage is simpler than inventing a third storage tier
  keyed by an unstable "current set of roots" identity — that identity is
  exactly the fragmentation problem this whole design avoids.

### Case 9: Same repo, different branch = different feature (raised in review, changes the schema)

Raised directly against an earlier draft of this document, which only
considered *folder* identity. The gap: two different features worked on the
same repo, in the same folder, at different times — e.g. `feature/jwt-refresh`
yesterday, a quick `main`-branch hotfix today, back to `feature/jwt-refresh`
tomorrow. Today's design (and the shipped code, unchanged) has **no concept of
branch at all** in `sessions`. All three of those efforts would share one
undifferentiated task history in the same `.continuum/knowledge.db` — meaning
a compaction-recovery on the feature branch could surface hotfix decisions
that have nothing to do with it. That's real noise working directly against
the "don't make me re-explain myself" goal this whole tool exists for.

**The fix is not a second database.** The code/symbol index should stay
exactly as it is — one shared, branch-agnostic index per repo, since it's
already self-correcting via hash-based reparsing (Case 9 doesn't touch this
half at all). The fix is narrower and cheaper than it first sounds:

- **Add a `branch` column to the `sessions` table**, populated from `git
  rev-parse --abbrev-ref HEAD` in the project root at session-init time.
  Non-git projects or detached HEAD fall back to a constant (e.g. `default`)
  — today's behavior, unchanged, for anyone not using branches this way.
- **`tasks` and `touched_files` need no schema change** — both are already
  foreign-keyed to `session_id`, so once a session is branch-scoped, its tasks
  and touches inherit that scoping for free.
- **Session resume becomes branch-aware**: the `SESSION_RESUME_HOURS` query
  (`SELECT id FROM sessions WHERE updated_at > ? ORDER BY updated_at DESC LIMIT
  1`) gains `AND branch = ?`. Checking out a different branch now naturally
  starts a fresh, correctly-scoped session — or resumes an old one, if that
  branch was worked within the resume window — instead of blindly continuing
  whatever branch happened to be touched most recently.
- **`context.md` and `get_recent_sessions`** both become branch-aware for
  free once the underlying session query is: Active Work/Decisions reflect the
  current branch's own history, and past-session listings can show which
  branch each one belonged to.

This is a schema change (one nullable column, one migration, one query
predicate), not an architectural one — it slots into the existing per-repo
database rather than requiring anything from the roots/fan-out mechanism in
Cases 3–8. It should ship independently and can land before any of the
multi-root work, since it's valuable even for someone who only ever works in
one repo at a time but switches branches often.

---

## Memory and OOM — what's actually at risk, checked against real numbers

Grounding this in your real production DB (138k symbols, 6.1k files, 63MB)
rather than guessing:

**Not actually a new risk, just relabeled:**
Total file/symbol volume watched doesn't change whether it's one process
watching 3 roots via one `WATCH_PATHS` list (today's accidental setup) or one
process managing 3 separate per-repo connections (the proposed model). Same
files, same total symbol count, same `chokidar` watch load either way. The
per-repo model doesn't add memory pressure over what's already running today
— it removes the *identity* problem without changing the *volume* problem.

**Real, checkable risks:**

1. **N open SQLite connections instead of 1.** Each `better-sqlite3` connection
   has its own page cache (`cache_size = -16000` → 16MB per connection today).
   Three repos open simultaneously → ~48MB of page cache, not 16MB. Fine at
   3-4 repos; worth capping or making `cache_size` scale down per-connection
   if someone opens 10+ repos in one workspace (uncommon, but not impossible
   with a large multi-root workspace).

2. **WAL files can grow unbounded without checkpointing.** `better-sqlite3` in
   WAL mode auto-checkpoints at SQLite's default threshold (1000 pages), which
   is usually fine — but this hasn't been explicitly verified under sustained
   multi-repo write load (symbol re-indexing across 3 repos simultaneously
   during a `git pull` in each). Worth an explicit periodic
   `PRAGMA wal_checkpoint(PASSIVE)` on an interval, cheap insurance.

3. **`pendingParseQueue` is an unbounded in-memory `Set`.** Right now
   `BULK_TOUCH_THRESHOLD` protects `touched_files` logging from a giant `git
   checkout`, but nothing caps the *parse* queue itself. A simultaneous large
   operation across 3 repos at once (e.g. a monorepo-wide branch switch) could
   enqueue a much larger batch than any single-repo scenario tested so far.
   Should cap queue size and log-and-skip past a threshold, same spirit as the
   existing bulk-touch guard.

4. **Disk accumulation of orphaned `.continuum/` directories.** Not a memory
   risk, but a real hygiene one: over months of opening-and-abandoning
   projects, `.continuum/knowledge.db` files pile up in old project folders
   that may themselves get deleted, moved, or archived. Since each is
   self-contained inside its own project folder this mostly self-resolves
   (deleting the project deletes its `.continuum/` with it) — but a `continuum
   status --all` or `continuum gc` that lists every `.continuum/` this
   machine's Continuum installs have ever touched (tracked via a small
   registry file) would give visibility, matching the "you cannot trust what
   you cannot see" principle from earlier.

**Not a runtime risk at all (separate, already-known issue):** the `tsc`
build-time OOM found earlier is a TypeScript-compiler memory issue during
`npm run build`, unrelated to the running server's memory behavior. Don't
conflate the two — that one needs its own fix (bump the build script's heap
further or split compilation), independent of anything in this document.

---

## What this means for the `roots`-based plan from last turn

Everything proposed last turn (query `listRoots()`, subscribe to
`list_changed`, dynamically add watch paths) stays correct and necessary — it's
the *discovery* mechanism. What this document adds is the *storage* model it
should drive: **roots tell the server which per-repo databases to have open
right now; they never determine how many databases exist or what's inside
them.** Discovery and storage were conflated in the original plan ("one DB per
workspace shape"); this splits them apretty apart, which is what actually
avoids the fragmentation problem.

---

## Open questions to settle before implementation

1. **Connection lifecycle:** keep all N per-repo connections open for the life
   of the server process, or close ones that go idle (root removed, or simply
   untouched for N minutes) to bound total memory when many repos churn
   through a long-running session? Leaning toward: keep open while the root
   is "in view" per the live roots list, close promptly when it's removed —
   simple, matches Case 6 exactly, no idle-timeout heuristic needed.

2. **Result labeling for the AI:** when `smart_search` fans out across 3 repos,
   how should results be presented so the AI (and you) can tell which repo a
   symbol came from without it being noisy for the common single-repo case?
   Proposal: always include a `repo` field in results; when only one repo is
   open, it's just always the same value and easy to ignore.

3. **The containment check for Case 7** (nested roots) needs a concrete rule:
   is "root A is a parent directory of root B" always resolved by preferring
   the outer root, or should some monorepo setups actually want the inner
   root treated independently (e.g. `packages/api` has its own `package.json`
   and is conceptually a separate deployable unit)? This probably needs to be
   a judgment call exposed as config, not a hardcoded rule, since monorepo
   conventions vary a lot.

4. **Non-Claude-Code clients:** Cursor, Copilot, or any MCP client that doesn't
   implement `roots` at all falls back to the existing static env-var
   resolution (`WATCH_PATHS`/`PROJECT_ROOT`/single-root auto-detect) — single
   database, no fan-out, exactly today's behavior. This should be an explicit,
   tested fallback path, not just "probably still works."

---

## Recommended phased build order (once this design is agreed)

0. **Branch-scoped sessions (Case 9)** — independent of everything else here,
   valuable on its own, no reason to wait. One column, one migration, one
   query predicate change. Ships before or in parallel with the multi-root
   work below; neither depends on the other.
1. **Per-repo connection manager** — a small component that owns "which repos
   are currently in view," opens/closes their DB connections, and exposes
   fan-out helpers (`forEachOpenRepo`, `searchAcross`). This is the load-bearing
   piece everything else sits on.
2. **Roots discovery wired to the connection manager** — `listRoots()` on
   connect, `list_changed` subscription, containment check for nested roots
   (Case 7), each feeding the connection manager's open/close calls.
3. **`FileWatcher` gains dynamic add/remove of watch paths** — already
   identified as straightforward since `chokidar` supports it; the remaining
   work is the file→owning-repo mapping so writes land in the right DB.
4. **Fan-out versions of `search_symbols`/`smart_search`/`get_session`** — the
   user (and AI)-facing payoff; everything before this is plumbing.
5. **Cross-cutting `save_task` duplication** (Case 8) — smallest piece, last,
   since it's additive to whatever the tool's normal single-repo behavior is.
6. **Hardening pass**: WAL checkpoint interval, parse-queue cap, per-connection
   cache-size scaling, `continuum status --all`/registry for orphan visibility.

Each phase is independently testable and shippable — this doesn't need to land
as one large change.

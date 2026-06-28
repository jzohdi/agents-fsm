# Agent Orchestrator — Implementation Plan

## 1. What we are building

A program you point at a Git repository that runs a **fleet of specialized AI agents** through a **configurable, ordered workflow** to take a GitHub issue from triage all the way to a reviewed, merge-ready pull request.

The system has three defining properties, all decided in our earlier discussion:

1. **Specialized agents.** Each agent owns exactly one stage of the work (triage, planning, interface design, implementation, review, etc.). No agent tries to do everything.
2. **An explicit, ordered workflow.** The order of stages is enforced by a finite state machine (FSM) that you can configure. The FSM also defines the legal *back-edges* — the points where work can revert to an earlier stage before resuming forward in the same canonical order.
3. **Event-driven, fresh-context handoffs.** Agents do not share one long-running conversation. Each stage runs as a fresh agent invocation, triggered by an event from the previous stage. This keeps each agent's context small and focused, and gives clean reversion semantics.

The control plane is a **headless orchestrator daemon** that you own and run. A **local web dashboard**, served by the daemon, is the primary interface for configuring the FSM, starting/stopping runs, and watching live progress and telemetry.

### Explicitly out of scope for the MVP

- Remote access (connecting from your phone). The architecture leaves room for it — the dashboard is a web client over an HTTP/WebSocket API — but we will not build auth, tunneling, or hardening for remote use in the MVP.
- Multi-user support, role-based access, teams.
- Running multiple repositories at once. The MVP handles one repo at a time. The foundation is kept multi-repo-ready at no extra MVP cost (runs carry a repo reference; the FSM and state model are already run-scoped; `events` support atomic claiming), and the upgrade is planned in Milestone 8.
- Auto-merging approved PRs. `done` means merge-ready; a human clicks merge. (Auto-merge is a trivial later add-on once trust is established.)

---

## 2. The workflow (the FSM)

This is the canonical pipeline. Each numbered item is a **state**; each agent owns one state.

| # | State | Agent responsibility |
|---|-------|----------------------|
| 0 | `triage` | Read a GitHub issue. Decide: proceed as-is, request more detail, or split into smaller issues. Acts as a PM/lead-engineer sprint check, weighing product goals and architecture. **Also declares the issue's dependencies and ordering** by writing a machine-readable block into the issue body — the deterministic input the Scheduler reads (see [§3.5](#35-encoding-state-in-issues-and-prs)). |
| 1 | `plan` | Produce the implementation plan and architecture/infra approach. |
| 1b | `plan_review` | Sign off on the plan, or request changes (sends back to `plan`). |
| 2 | `interface_design` | Design the type system, spec, and interfaces. |
| 2b | `tdd` | Open a PR for the feature with a suite of **failing** tests that the implementation will later make pass. |
| 3 | `frontend` | Implement frontend code (done first, because frontend needs dictate backend needs). Skipped if not needed. |
| 4 | `backend` | Implement backend code. Skipped if not needed. |
| 5 | `code_review` | Review the PR. Approve, or request changes (sends back to `backend`/`frontend`). |
| — | `done` | PR approved and merge-ready. The MVP does **not** auto-merge — a human performs the merge. |
| — | `needs_human` | Escalation state when an agent is stuck or a guard trips. |

### Scope of the FSM: one run per issue

This FSM governs a **single issue**, start to finish — one run per issue. It deliberately says nothing about *which* issue to start or in *what order* relative to others; that is a separate, deterministic concern owned by the **Scheduler** ([Layer 3](#33-the-layers)), which reads ordering declarations from the issue itself ([§3.5](#35-encoding-state-in-issues-and-prs)). Keeping cross-issue ordering out of the FSM is what keeps the engine pure: a single run never has to reason about other runs.

### Triage outcomes

`triage` lists three outcomes, but the FSM only needs one forward edge. The outcomes map to transitions we already have:

- **Proceed** → `plan`.
- **Needs more detail** → `needs_human` (with a reason). A human edits the issue, then resumes.
- **Should be split** → `needs_human` (with the proposed sub-issues in the reason). Auto-creating child runs is out of scope for the MVP; the operator creates the new issues and starts new runs.

This keeps triage's only forward edge `triage → plan` and routes the other two cases through the escalation state — no extra states required.

### Skipping `frontend` / `backend`

Skipping is **data, not a special case in the engine.** The `plan` stage emits `needs_frontend` / `needs_backend` flags as part of its output. The FSM reads those flags from state when choosing the next forward state: if `needs_frontend` is false, `tdd → backend`; if `needs_backend` is false, the last implementation stage goes straight to `code_review`. The engine stays pure — it reads the flags, it does not infer scope. (At least one must be true, or the work should not have left `plan`.)

### Forward path

```
triage → plan → plan_review → interface_design → tdd → frontend → backend → code_review → done
```

### Back-edges (revert, then resume forward)

- `plan_review → plan` — reviewer requests plan changes.
- `code_review → backend` (and `→ frontend`) — reviewer requests code changes. The implementation and review agents loop here until review approves.
- `frontend → interface_design` and `backend → interface_design` — an implementer discovers the interfaces are inadequate, so work reverts to interface design, which then proceeds forward through `tdd` again.

The rule from our discussion holds: **a back-edge moves work to an earlier state, but the workflow always resumes forward in the same canonical order.** The FSM never invents new orderings.

**Stage actions are idempotent.** Because back-edges re-run earlier stages, every stage action must be safe to run more than once for the same run. In particular, `tdd` **opens the PR only if the run has no PR yet; otherwise it updates the existing PR** (new branch commits, refreshed tests). A stage checks the run's recorded state before acting; it never blindly creates a second PR, branch, or duplicate artifact. See [§3.3 The layers](#33-the-layers) (Layer 4).

### Guards (loop protection)

Back-and-forth loops are the main failure mode, so each looping edge carries a guard:

- **Round limits.** `code_review ⇄ backend/frontend` and `plan_review ⇄ plan` track a round counter. After *N* rounds (configurable, default 3) the workflow transitions to `needs_human` instead of looping again.
- **Reversion reason required.** Every back-edge carries a structured `reason` payload so the target state knows *why* it is being re-run and does not simply repeat its prior output.
- **Run budget.** A per-run ceiling on total tokens (and/or wall-clock and agent invocations), configurable, that escalates to `needs_human` when exceeded. Round limits cap individual loops; the budget is the backstop against slow drift across *all* stages. KISS: a single token counter on the run, checked before each agent dispatch.

### Visual

```
        ┌─────────┐
        │ triage  │──────────────► needs_human
        └────┬────┘
             ▼
        ┌─────────┐      request changes
        │  plan   │◄──────────────┐
        └────┬────┘               │
             ▼                    │
      ┌─────────────┐             │
      │ plan_review │─────────────┘
      └──────┬──────┘
             ▼ approve
    ┌──────────────────┐◄──────────────┐
    │ interface_design │               │ "interfaces inadequate"
    └────────┬─────────┘               │
             ▼                         │
         ┌───────┐                     │
         │  tdd  │ (opens PR)          │
         └───┬───┘                     │
             ▼                         │
       ┌──────────┐                    │
       │ frontend │────────────────────┤
       └────┬─────┘                    │
            ▼                          │
       ┌─────────┐                     │
       │ backend │─────────────────────┘
       └────┬────┘◄────────┐
            ▼              │ request changes
     ┌─────────────┐       │
     │ code_review │───────┘
     └──────┬──────┘
            ▼ approve
        ┌──────┐
        │ done │
        └──────┘
```

For readability the diagram shows the `code_review → backend` loop only; `code_review` requests changes to whichever implementation stage(s) are in scope (`backend` and/or `frontend`). Likewise, the only `needs_human` edge drawn is from `triage`, but **`plan_review`, `code_review`, and the run-budget guard all escalate to `needs_human`** when their limits trip (see Guards). Treat the prose, not the diagram, as the source of truth for these edges.

---

## 3. Architecture

### 3.1 Guiding principles

- **Engine before UI, engine independent of UI.** The orchestrator is a headless service with a clean API. Every interface (web dashboard now, TUI/CLI/phone later) is a thin client over that API. No orchestration logic lives in the UI.
- **State lives outside the agents.** Agents are stateless workers. All durable state — current FSM state, history, decisions, PR number, round counters — lives in the store. An agent reads the slice it needs, does its job, writes results back, emits an event.
- **Artifacts are the shared memory, not transcripts.** Agents communicate through durable artifacts (the plan document, the interface spec, the PR diff, review comments), not by passing chat history. This is what keeps context bounded and makes reversion clean: reverting to a stage just means re-reading its (now-flagged) artifacts.
  - **Where artifacts live.** The early artifacts (plan, interface spec) are produced *before* the PR exists, so they need a home from the start. The orchestrator creates the run's working branch when `plan` begins and commits these as markdown files on it (e.g. `.agent/plan.md`, `.agent/interface.md`). When `tdd` opens the PR against that branch, the artifacts are already part of it — one consistent location ("in the repo") for every artifact, no special pre-PR storage. The store keeps only references (branch, path, commit SHA), never the content.
- **Issues and PRs are durable, declarative state — with one clear owner.** Cross-run *inputs* that humans and the PM agent should be able to read and edit — an issue's dependencies, priority, and ordering — live in the **issue** as a machine-readable block; the **PR** carries the issue↔run linkage and a mirror of the run's state. SQLite stays the source of truth for *runtime control-plane* state (current FSM position, counters, the event queue). The rule that prevents two masters: **declarative scheduling inputs are owned by the issue; runtime state is owned by SQLite; everything else is a derived view.** See [§3.5](#35-encoding-state-in-issues-and-prs).
- **No stacked PRs: dependent work never starts against unmerged work.** A deliberate simplification. When issue B depends on issue A, B's run is not admitted until A's PR is *merged into the base branch*; B then branches off the up-to-date base. We never base one open PR on another open PR. This keeps git history linear, rebases trivial, and makes "dependency satisfied" a single hard signal (A is merged) instead of a fragile chain of in-flight branches. The accepted cost: because the MVP does not auto-merge, dependent work waits for a human to merge the dependency — on purpose, not by oversight.
- **KISS. Don't over-engineer.** SQLite, not a distributed database. A single daemon process, not microservices. An in-process event loop, not an external message broker. We can graduate any of these later precisely because the boundaries are clean.

### 3.2 System diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Orchestrator Daemon                     │
│                                                            │
│   ┌────────────┐   ┌──────────────┐   ┌────────────────┐   │
│   │ HTTP + WS  │   │  FSM Engine  │   │   Telemetry    │   │
│   │   API      │◄─►│ (transitions │◄─►│   + Logging    │   │
│   │            │   │  + guards)   │   │                │   │
│   └─────┬──────┘   └──────┬───────┘   └───────┬────────┘   │
│         │                 │                   │            │
│         │          ┌──────▼───────┐           │            │
│         │          │ Event Loop / │           │            │
│         │          │  Scheduler   │           │            │
│         │          └──────┬───────┘           │            │
│         │                 │                   │            │
│         │          ┌──────▼───────┐           │            │
│         │          │ Agent Runner │           │            │
│         │          │ (spawns      │           │            │
│         │          │  fresh agent │           │            │
│         │          │  per stage)  │           │            │
│         │          └──────┬───────┘           │            │
│         │                 │                   │            │
│   ┌─────▼─────────────────▼───────────────────▼────────┐   │
│   │              State Store (SQLite)                  │   │
│   │   runs · transitions · events · telemetry · logs   │   │
│   └────────────────────────────────────────────────────┘   │
└─────────┬──────────────────────────┬───────────────────────┘
          │ serves                   │ acts on
          ▼                          ▼
  ┌────────────────┐         ┌────────────────────┐
  │ Local Web      │         │ Git repo + GitHub  │
  │ Dashboard      │         │ (issues, PRs,      │
  │ (browser)      │         │  branches, diffs)  │
  └────────────────┘         └────────────────────┘
                                      ▲
                             ┌────────┴─────────┐
                             │ Anthropic API    │
                             │ (the agents)     │
                             └──────────────────┘
```

### 3.3 The layers

The codebase is organized into clear layers, each depending only on the ones below it.

**Layer 1 — State Store.**
SQLite, accessed through a thin repository module. It is the single source of truth for control-plane state. Core tables:

- `runs` — one row per task/issue being processed: issue ref, **repo ref** (always the single MVP repo for now, but stored per-run so multi-repo is an additive extension rather than a retrofit — see Milestone 8), current state, status (`running`/`paused`/`blocked`/`done`/`needs_human`; `blocked` = waiting on a dependency, see Layer 3), the **`fsm_config_version`** the run is pinned to (see Layer 2), PR number/branch once they exist, cumulative token/cost totals (for the run-budget guard), timestamps. Scheduling inputs (dependencies, priority, order key) are *read from the issue* (§3.5), not owned here; they may be cached on the run for queryability, but the issue wins on conflict.
- `transitions` — append-only log of every state change: from-state, to-state, trigger event, reason payload, the **round counters** at the time. This *is* your audit trail, and it is also the source the engine reads counters from — they are derived from this log, not stored as mutable fields, so there is one source of truth.
- `events` — the event queue/log that drives handoffs. Each row carries a status (`pending`/`processing`/`done`) and a unique id so processing can be made idempotent (see Layer 3).
- `agent_runs` — one row per agent invocation: which stage, inputs given, outputs produced, token usage, duration, success/failure.
- `artifacts` — references (not content) to durable artifacts: run id, kind (`plan`/`interface`/`pr`/`review`), and a locator (branch + path + commit SHA, or PR/issue/comment id).
- `telemetry` / `logs` — structured records the dashboard subscribes to.

Artifacts (plans, specs, diffs, review comments) live in the repo or as PR/issue content, *not* in SQLite. The store only references them, via the `artifacts` table.

**Layer 2 — FSM Engine.**
A pure, well-tested module that knows nothing about agents, HTTP, or the database. It answers one question: *given the current state, the completed stage's result, and the guard counters, what is the next state?* It is handed a config object (states, transitions, back-edges, guard limits) — it does not read files or the DB itself; that keeps it pure and side-effect-free, which is what makes the whole system testable and trustworthy.

**Config storage and versioning.** The FSM config is a file on disk (the version-controllable source of truth). The dashboard edits it *through the API* (Layer 6), which writes the file — the dashboard never touches the DB. Each saved version is content-hashed, and **every run records the `fsm_config_version` it started under and uses that version for its whole lifetime.** Editing the config therefore never changes the rules for an in-flight run; new runs pick up the new version. This closes the otherwise-nasty gap where editing the FSM mid-run could reference states a running run has never heard of.

**Layer 3 — Event Loop / Scheduler.**
An in-process loop with an in-memory job queue. When a stage completes, it writes an event; the loop picks it up, asks the FSM Engine for the next state, persists the transition, and — gated by the Scheduler (below) — enqueues an agent job. For the MVP this is a simple in-memory queue backed by the `events` table for durability across restarts. (No Redis, no SQS — that is a later upgrade if you ever need parallelism across many repos.)

**Delivery is at-least-once, so handlers are idempotent.** A daemon can crash after an agent acts but before its event is marked `done`; on restart that event is re-picked-up. We do not try to make delivery exactly-once (that is the over-engineered path). Instead: (1) applying a transition is keyed on the event id, so re-applying it is a no-op; (2) agent stage actions check recorded run state before acting (Layer 4), so a re-run updates rather than duplicates. This is the property that makes restart-recovery (Milestone 7) actually safe, and it must be designed in from Layer 3 — not bolted on at the end.

**MVP execution is serial.** At most one agent stage runs at a time. Multiple runs may exist in different states, but the loop dispatches them one stage at a time rather than concurrently — this sidesteps git working-tree races and makes the whole system trivial to reason about. A paused or `needs_human` run holds no executor, so it never blocks others. Parallelism (per-run git worktrees, a real job queue) is a clean later upgrade the boundaries already allow; it is deliberately not in the MVP. See Milestone 8 for the multi-repo / parallel-execution plan.

**The Scheduler decides *which* run advances; the FSM decides *how* a run advances.** Before dispatching any stage, the loop consults a pure, deterministic **Scheduler**: `isDispatchable(run)`. A run is dispatchable when its dependencies are satisfied — i.e. every issue it `depends_on` is closed with its PR merged into the base branch (an externally verifiable signal read from GitHub, §3.5). This is the **no-stacked-PRs rule (§3.1)** made operational: a dependent run is never admitted against unmerged work. Ineligible runs park in `blocked` and are re-evaluated when a dependency actually clears — i.e. when its PR is **merged** (detected via the GitHub adapter, polled in the MVP-shaped design, webhook-driven later), not merely when the dependency's run reaches `done`. The distinction matters: `done` means *merge-ready*, and since the MVP does not auto-merge, a dependency clears only when a human merges it — so dependent runs deliberately wait for that human merge. This is where ordering is **enforced at pickup time**, exactly as required — not by trusting an agent to wait, but by the loop refusing to dispatch. Among dispatchable runs the Scheduler picks in a **total, deterministic order**: `priority` (desc), then `order_key` (asc), then issue number (asc) — same inputs, same schedule, every time, which is what makes it testable. Dependency graphs are checked for **cycles**; a cycle escalates every run in it to `needs_human` rather than deadlocking forever. Like the FSM engine, the Scheduler is pure: inputs are the set of runs, their declared dependencies, and which issues are closed; output is the ordered list of dispatchable runs. In the MVP (one issue, serial) this gate is a trivial pass-through; the full Scheduler arrives with multi-issue async ([Milestone 9](#milestone-9--multi-issue-async--dependency-ordering-post-mvp)), slotting into this same gate point — which is why the gate and the `blocked` status are defined now.

**Layer 4 — Agent Runner.**
Spawns a **fresh agent invocation** per stage. Responsibilities:
- Build the agent's input from durable artifacts + the minimal state slice (never the prior transcripts).
- Inject the correct step-specific system prompt (one per stage).
- Before acting, check the run's recorded state so the action is idempotent (e.g. `tdd` updates an existing PR instead of opening a second one — see [§2 Stage actions are idempotent](#back-edges-revert-then-resume-forward)).
- Call the Anthropic API (via the Layer 5 adapter).
- Validate and persist the agent's structured output against a strict schema, then emit the completion event.

**A stage is one agent *session*, not one API call.** Within a stage the agent takes as many tool-use turns as it needs — reading files, editing code, running tests, iterating — against the run's local working tree. "Fresh context" is a guarantee *across* stages (no stage inherits another's transcript), not a limit *within* one. Implementation stages (`frontend`/`backend`) and `tdd` write code via file-editing tools and commit to the run's branch; review stages read the diff and post comments. When the stage ends, its turn-by-turn transcript is discarded — only the artifacts (committed code, comments) and the structured envelope persist. This is how agents actually do the work while cross-stage context stays bounded by construction. The Anthropic adapter (Layer 5) owns the tool-use loop and the per-stage tool allow-list (e.g. review stages get read-only tools).

**The agent output contract.** Every agent returns the *same* envelope, validated before it is trusted:
- `requested_transition` — one of the transitions the FSM allows *from this state* (e.g. `approve`, `request_changes`, `revert_to_interface_design`, `escalate`). The engine still enforces legality; the agent only requests.
- `reason` — structured payload (required on any back-edge or escalation) explaining *what must change*, so the target stage does not repeat itself.
- `artifacts` — references to anything the agent produced or updated (branch/path/SHA, PR/comment ids), to be recorded in the `artifacts` table.
- `flags` — stage-specific outputs the engine reads, e.g. `plan` returns `needs_frontend` / `needs_backend`.

**On invalid or missing output**, the runner does not guess. It retries the call a bounded number of times (Layer 5 owns retry/backoff); if the output still fails schema validation, the run escalates to `needs_human` with the raw output attached. A malformed agent response must never be silently coerced into a transition.

**Layer 5 — Integrations.**
- **Git/GitHub adapter** — read issues, create branches, open/update PRs, post review comments, read diffs. It also owns the run's **local working tree**: the daemon keeps a local clone of the target repo and checks out the run's branch, which is where agents edit files and run tests; commits are pushed and PRs managed via GitHub. Wrapped behind one interface so the agents never touch git or GitHub directly.
- **Anthropic adapter** — one place that owns model calls, retries, and token accounting.
- **Built for fakes.** Each adapter is defined by an interface, and each ships with an in-memory fake. The fakes are what Milestones 1–2 run against — the whole pipeline is testable end-to-end with zero network calls and zero cost, and real-API integration tests sit behind an explicit flag.
- **Secrets.** The GitHub token and Anthropic API key are read from the environment / a local config file (e.g. `.env`), never committed and never stored in SQLite. This is the only configuration that is a secret; the FSM config (Layer 2) is not.

**Layer 6 — API + Telemetry surface.**
- **HTTP API** for commands: start a run, stop/pause/resume, revert to a stage, edit FSM config, list runs, fetch history.
- **`stop` vs `pause`.** `pause` halts dispatch and is resumable; `stop` ends a run (terminal, not resumable). Both leave all state and artifacts intact for inspection — `stop` is not delete.
- **Resuming from `needs_human`.** Escalation is not a dead end. The operator inspects the run, fixes the cause (edits the issue, the plan, the code), then issues `resume` (continue from the escalated state) or `revert <state>` (go back further). Resuming **resets the round counter** for the loop that tripped, so the run gets a fresh budget of rounds rather than immediately re-escalating. Pause/resume and revert are the same commands used for normal control.
- **WebSocket (or SSE) stream** for live updates: state transitions, agent start/finish, token usage, logs. The dashboard subscribes here so the UI reflects progress as it happens.

**Layer 7 — Local Web Dashboard.**
A browser app served by the daemon on localhost. It is a pure client of Layer 6. Screens:
- **Run view** — the live FSM graph with the current node highlighted, plus the transition history.
- **Artifacts** — links to the plan, interface spec, PR, and review comments for the run (the dashboard renders the reference and links out to GitHub; it does not store artifacts). Without this, an operator cannot tell *why* a run escalated, and `needs_human` resolution is guesswork.
- **FSM editor** — view and edit states, transitions, back-edges, and guard limits.
- **Telemetry** — token usage, durations per stage, round counts, costs.
- **Logs** — live structured log stream.
- **Controls** — start/stop/pause/resume/revert buttons.

### 3.4 How the architecture achieves each goal

| Goal | How it is achieved |
|------|--------------------|
| Fleet of specialized agents | One step-specific system prompt + one FSM state per agent (Layer 4). Adding/removing an agent is a config + prompt change, not a rewrite. |
| Strict ordered workflow with back-edges | The FSM Engine (Layer 2) is the single authority on legal transitions. Back-edges and "always resume forward" are encoded there, not scattered through the code. |
| Cross-issue ordering / dependencies | A deterministic Scheduler (Layer 3) reads declarations from the issue (§3.5) and gates dispatch, so ordering is enforced when work is picked up. The FSM stays per-run and pure — it never reasons about other issues. |
| Event-driven, fresh context per stage | The Event Loop (Layer 3) triggers each stage; the Agent Runner (Layer 4) starts a fresh invocation built from artifacts, never accumulated transcripts. Context stays small by construction. |
| Avoid runaway context / loops | No long-running conversation exists to grow. Round-limit guards cap the `4⇄5` and `1⇄1b` loops, and a per-run budget catches slow drift across all stages; both escalate to `needs_human`. |
| Revert then proceed forward | Back-edges carry a structured reason; the FSM resumes the canonical forward order afterward. |
| Telemetry, insights, logging | Everything passes through the daemon boundary (Layers 1 + 6), where it is recorded and streamed — impossible to achieve with CI-scattered triggers. |
| Configurable FSM + dashboard | FSM is config-driven (Layer 2); the dashboard (Layer 7) reads/writes that config and renders the live graph. |
| Start/stop control | First-class API commands (Layer 6) backed by the run status in the store. |
| Future remote/phone access | The dashboard is already a web client over HTTP/WS; remote access becomes an auth + networking add-on, not a redesign. |

### 3.5 Encoding state in issues and PRs

Some state belongs in GitHub rather than SQLite, because it must be **human-readable, human-editable, durable beyond the daemon's database, and externally verifiable.** We use it for exactly two things — and no more, to avoid a sprawl of competing state.

**1. Scheduling declarations — in the issue body.** The PM/`triage` agent (or a human) writes one machine-readable block, wrapped in a sentinel HTML comment so it is invisible in the rendered issue and safe to rewrite idempotently:

```
<!-- agent-orchestrator:v1
depends_on: [42, 57]           # issue numbers that must be merged first
priority: 10                   # higher runs first
order_key: "2026Q3-auth-03"    # lexicographic tiebreaker
-->
```

The Scheduler parses this **deterministically** — structured fields, never prose. Every field is optional; an absent block means "no dependencies, default priority." Because the declaration lives in the issue, it survives a database wipe and a human can correct an ordering mistake by editing the issue, with no code change and no DB surgery.

**2. Run linkage and a status mirror — in the PR.** The PR body carries `Closes #<issue>` and the run id, so the issue ↔ PR ↔ run mapping is recoverable from GitHub alone. The orchestrator also mirrors the run's current FSM state as a label (e.g. `af:code_review`) for at-a-glance visibility and as a disaster-recovery breadcrumb.

**Determinism for the FSM.** Where a transition depends on external facts, those facts are read from structured GitHub fields, not inferred: dependency satisfaction keys off *PR-merged / issue-closed* (a hard signal), and the issue↔run mapping off `Closes #N`. The agents may use judgment to *write* these fields; the engine and Scheduler only ever *read* them — so the control flow stays reproducible.

**Source-of-truth rule (no two masters).** Declarative scheduling inputs are owned by the **issue**; runtime control-plane state (current FSM position, counters, event queue) is owned by **SQLite**. The PR label and any cached copy of the issue block are derived views — on conflict, the owner wins. This is the rule that lets us use GitHub for durability and transparency without ever being unsure which copy is authoritative.

---

## 4. Recommended technology

Chosen for simplicity and for keeping the engine and dashboard cleanly separated. These are recommendations, not hard requirements.

- **Language/runtime:** TypeScript on Node.js. One language across the daemon and the dashboard reduces friction, and the Anthropic SDK is first-class.
- **State store:** SQLite (via `better-sqlite3` or Prisma). Zero-ops, durable, queryable, perfect for one-user/one-repo.
- **API:** a small HTTP framework (Fastify/Express) plus a WebSocket library for the live stream.
- **Dashboard:** React served as static assets by the daemon. A graph library (e.g. React Flow) for the live FSM view and the editor.
- **Git/GitHub:** the GitHub REST/GraphQL API via Octokit; local git operations via simple git commands or a wrapper.
- **Agents:** the Anthropic API, one system prompt per stage.

If you would rather use Python for the daemon, the layering is identical; only the libraries change.

---

## 5. Work breakdown

Ordered so that each milestone produces something runnable and testable. The riskiest, most novel parts (the FSM engine and fresh-context dispatch) come first; the dashboard comes after the engine is proven.

### Milestone 0 — Foundations
- Repository scaffold, TypeScript config, linting, test runner.
- SQLite schema and the repository module (Layer 1), including the `artifacts` table and the `runs` fields for `fsm_config_version`, PR/branch, and token/cost totals.
- Config file format for the FSM (states, transitions, back-edges, guard limits), with content-hash versioning so runs can pin a version.

### Milestone 1 — FSM engine (the core)
- Pure FSM module: given config + current state + result + counters, compute next state, enforce back-edges and "resume forward."
- Guard logic: round counters (derived from the transitions log), run-budget ceiling, escalation to `needs_human`.
- **The most important test suite in the project.** Make it table-driven: a list of `(state, result, counters) → expected next state` cases that covers the forward path, every back-edge, the `needs_frontend`/`needs_backend` skip branches, and every guard boundary (at the limit, one under, one over). Add property-based tests for the two invariants that must never break: a transition is always either forward in canonical order or a declared back-edge, and reaching a round limit always lands in `needs_human`.

### Milestone 2 — Event loop + agent runner (headless, no real agents yet)
- In-process event loop backed by the `events` table, with at-least-once processing and event-id-keyed (idempotent) transition application.
- Agent Runner with a **stubbed** agent (returns canned results) so the full pipeline can run end-to-end without API calls.
- Persist transitions, events, and agent runs.
- A CLI to start a run and watch it progress through the FSM with stub agents. **At this milestone the whole orchestration mechanism is validated.**
- **Tests:** a golden-path integration test that drives a run start→`done` on stubs and asserts the exact transition sequence; back-edge scenarios driven by stub results (e.g. a stub `code_review` that requests changes until the round limit, asserting escalation). **Crash-recovery test belongs here, not Milestone 7:** kill the loop mid-run, restart, and assert no duplicate transition/PR/charge — this is the test that proves the Layer 3 idempotency design, so it must exist as soon as the loop does.

### Milestone 3 — Integrations
- GitHub adapter: read issue, create branch, open/update PR, post comments, read diff, manage the run's local working tree — behind an interface, with an in-memory fake.
- Anthropic adapter: model calls, the tool-use loop with a per-stage tool allow-list, retries, token accounting — behind an interface, with a scripted fake.
- **Tests:** contract tests that run the *same* suite against the fake and (behind a flag) the real API, so the fake cannot silently drift from real behavior.

### Milestone 4 — Real agents
- Write the step-specific system prompts, one per stage (triage and code-review have the most interesting logic).
- Implement the structured output contract from [§3.3 The layers](#33-the-layers) (Layer 4 — requested transition + reason + artifact refs + flags) as a single schema shared by all stages.
- Wire real agents into the Agent Runner, replacing the stubs.
- **Tests:** schema-validation tests for the output envelope, including the malformed-output path (bounded retry, then escalate to `needs_human` — never coerce). Run the real pipeline against a test repository and a sample issue.

### Milestone 5 — API + telemetry surface
- HTTP commands: start, stop, pause, resume, revert, list/fetch runs, get/update FSM config.
- WebSocket/SSE live stream of transitions, agent activity, token usage, and logs.

### Milestone 6 — Local web dashboard
- Run view with the live FSM graph and transition history.
- Telemetry and log views.
- Control buttons (start/stop/pause/resume/revert).
- FSM editor (states, transitions, back-edges, guard limits).

### Milestone 7 — Polish
- Harden restart correctness across *all* layers (the core idempotency property and its test already exist from Milestone 2; here, extend coverage to partial agent actions and adapter failures).
- Error handling and `needs_human` UX (inspect → fix → resume/revert, with counter reset).
- Documentation: how to point it at a repo, configure the FSM, set secrets, and run it.

### Milestone 8 — Multi-repo support (post-MVP)

Out of scope for the MVP, but planned here so the MVP foundation stays clean (the `runs` repo reference, the run-scoped state model, and the pure FSM are the only things that must be right up front — they already are). The key realization: **the hard part is concurrency, not the repo count.** The work splits into two independent phases, and you can ship Phase A without Phase B.

**Phase A — repo as a first-class dimension (small, additive, low risk).**
- A `repos` table (clone path, GitHub remote, token reference) and a foreign key from the `runs` repo reference that already exists.
- A `repo` argument on the `start a run` command; filter runs, telemetry, and the live stream by repo.
- A repo selector / multi-repo overview in the dashboard.
- Execution can stay **serial**: the loop simply pulls events from runs in any repo. This alone delivers multi-repo with zero new concurrency risk — a good first stopping point.

**Phase B — parallel execution (moderate, the real work).**
- Replace the serial loop with a bounded worker pool.
- Claim events atomically (`UPDATE events SET status='processing' WHERE id=? AND status='pending'`) so two workers never grab the same one. The at-least-once + idempotent-handler design (Layer 3) already holds under concurrency — the usually-hard part is mostly pre-solved.
- **Per-run git worktrees** so two runs on the *same* repo don't share a working tree. (Different repos are already isolated, so cross-repo parallelism is *easier* than same-repo parallelism — build the worktree machinery once and you get both.)
- A **global concurrency cap**, rate-limit handling in the Anthropic adapter, and an optional global cost ceiling on top of the per-run budget — N parallel agents mean N× spend and N× rate pressure.
- Optional: per-repo FSM config and per-repo secrets, if repos span different orgs.

**Tests:** extend the Milestone 2 crash-recovery test to the concurrent loop (kill mid-flight with several runs in progress, assert no duplicate or lost events); add a contention test asserting two workers never process the same event. Neither phase touches the FSM engine, so its test suite is unaffected.

### Milestone 9 — Multi-issue async + dependency ordering (post-MVP)

Run several issues from one repo at once, respecting declared dependencies. This **reuses Milestone 8 Phase B's concurrency machinery** (worker pool, per-run git worktrees, atomic event claim, global caps) — that work is shared, not rebuilt. What is genuinely *new* here is the deterministic ordering layer:

- **Scheduler module** (pure, deterministic): build the dependency graph from issue markers, compute the dispatchable set (deps merged), pick a total order (`priority`, `order_key`, issue number), detect cycles → `needs_human`. The most test-worthy new component, on par with the FSM engine.
- **Dispatch gate + `blocked` status** in the event loop: consult the Scheduler before dispatching, park ineligible runs, wake them when a dependency's PR is **merged** (detected via the GitHub adapter — polled now, webhook later), not merely when a run reaches `done`.
- **Issue marker parse/write** (§3.5) plus a `triage` prompt update so the PM declares `depends_on` / `priority` / `order_key`.
- **PR linkage + state-label mirror** (§3.5); dependency satisfaction keyed off PR-merged / issue-closed.
- **Base-branch discipline — no stacked PRs (§3.1):** a dependent run is admitted only after its dependencies are *merged* to the base branch; it then branches off up-to-date code. Dependent work never starts against an unmerged branch — a firm invariant, not just a convenience. (Consequence: since the MVP does not auto-merge, dependent runs wait for a human to merge the dependency.)
- **Tests:** table-driven Scheduler tests (linear chains, diamond deps, cycles, ordering determinism); a gate test (a `blocked` run does not dispatch, then wakes when its dependency's PR is merged); reuse the Phase B contention and crash-recovery tests with dependent runs in flight.

Neither the FSM engine nor its tests change — ordering lives entirely in the Scheduler.

---

## 6. Key risks and how the design handles them

- **Infinite review loops.** Mitigated by round-limit guards that escalate to `needs_human`.
- **Reversion without progress** (an agent re-runs a stage and produces the same output). Mitigated by requiring a structured `reason` on every back-edge so the target stage knows what to change.
- **Slow cost/time drift** that no single loop limit catches. Mitigated by a per-run budget guard (tokens/time/invocations) that escalates to `needs_human`.
- **Duplicate side-effects on restart** (a second PR, a double charge). Mitigated by at-least-once events with idempotent, id-keyed handlers and stages that check recorded state before acting — designed in at Layer 3, tested from Milestone 2.
- **Config edits breaking in-flight runs.** Mitigated by pinning each run to the `fsm_config_version` it started under; edits only affect new runs.
- **Malformed agent output coerced into a bad transition.** Mitigated by strict schema validation: bounded retry, then escalate with the raw output — never guess.
- **Dependency cycles / deadlock** (issue A waits on B waits on A). Mitigated by deterministic cycle detection in the Scheduler that escalates the whole cycle to `needs_human` instead of parking forever.
- **Wrong or stale scheduling order.** Because dependencies live in the issue and are read deterministically, a bad order is fixed by editing the issue — no code change, no DB surgery — and the Scheduler re-evaluates on the next cycle.
- **Two sources of truth (GitHub vs SQLite).** Mitigated by the explicit ownership rule (§3.5): declarative inputs owned by the issue, runtime state owned by SQLite, everything else a derived view.
- **Starvation** (a low-priority run never selected). Mitigated by the deterministic total order whose final tiebreaker is issue number (oldest first); time-based aging can fold into `order_key` if it ever bites.
- **Context creep.** Structurally impossible to accumulate, because no conversation persists across stages; agents are rebuilt from artifacts each time.
- **UI/engine entanglement.** Prevented by making the daemon fully headless with the dashboard as a pure API client — this is also what unlocks future phone/remote access cheaply.
- **Over-engineering.** Held back deliberately: SQLite over a database server, in-process queue over a broker, one repo over many. Each is a clean, isolated upgrade if a real need appears.

---

## 7. Summary

We are building a headless, ownable orchestrator daemon that drives a fleet of single-purpose AI agents through a configurable finite state machine, using event-driven fresh-context handoffs to keep agents focused and avoid runaway context. State and artifacts live outside the agents, which makes reversion clean and the whole system observable. A local web dashboard, served by the daemon, provides FSM configuration, live progress, telemetry, and start/stop control — and, because it is already a web client over a clean API, leaves the door open to remote/phone access later without a redesign.

The build order puts the novel, high-risk core first (FSM engine, then event-driven dispatch validated with stub agents), then layers on integrations, real agents, the API surface, and finally the dashboard — so that at every milestone there is something working to test, and the most important logic is proven before anything is built on top of it.


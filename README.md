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

`triage` is a router *and* an issue editor: before deciding, it may rewrite the issue into a well-scoped spec (the orchestrator applies the edit via the GitHub adapter — `updateIssue`). It then chooses one route, which the runner maps onto the FSM and the GitHub side effects:

- **Proceed** → `plan`. Posts a human-visible sign-off comment on the issue; the FSM transition is the machine sign-off later stages key off.
- **Clarify** → the runner posts the agent's questions as an **issue comment** (carrying an invisible `<!-- agent-fleet:bot -->` marker), records a `triage_question` marker (issue + comment id), and parks the run in the **`awaiting_input`** status (a self-edge in the log; *not* `needs_human`). A **Reply Poller** (`src/loop/reply-poller.ts`) polls the issue thread; when a human replies — any later comment the fleet didn't post itself — it re-arms the run (→ `running` + an advance event) so `triage` re-runs, now reading the reply. The fleet's own comments are told apart **by their marker, not author login**: the daemon comments via the operator's own `gh` account, so the "bot" and the human share a GitHub login and an author check would reject the real reply. Polling, not webhooks, matching the rest of the MVP's polled-signal design; the CLI drives it via `--poll-timeout` / `--poll-interval`, and the dashboard has an on-demand **"Check now"** (`POST /runs/:id/check-reply`) for when you don't want to wait for the next tick.
- **Split** → the runner opens the smaller issues (`createIssue`) and links them in a comment on the original. With a chosen `handoff` index, **this run is retargeted to that child** (`setRunIssueRef`) and continues to `plan`; the siblings are left for the operator. Without `handoff`, the run escalates to `needs_human` with the created sub-issues in the reason.

So triage's only forward edge stays `triage → plan`; clarify parks in `awaiting_input` (auto-resumed on a reply), and a split without handoff routes through `needs_human` — no extra FSM states required.

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
- **Internal review rounds.** Within a stage, the self-review→fix loop ([Layer 4](#33-the-layers)) is capped (configurable, default 5 — some back-and-forth is *normal convergence*, so the cap exists to stop thrash, not to forbid iteration); if blocking issues remain after the cap, the stage escalates to `needs_human`. Each round carries the previous round's findings (`reviewRound`), so the reviewer verifies fixes instead of re-reviewing cold. Like the outer round limits, this stops an agent thrashing on its own output, and the run budget above bounds the combined cost of all internal passes.

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
  - **Where artifacts live.** The early artifacts (plan, interface spec) are produced *before* the PR exists, so they need a home from the start. The orchestrator creates the run's working branch when `plan` begins and commits these as markdown files on it (e.g. `.agent/plan.md`, `.agent/interface.md`). When `tdd` opens the PR against that branch, the artifacts are already part of it — one consistent location ("in the repo") for every artifact, no special pre-PR storage. The store keeps only references (branch, path, commit SHA), never the content. Because the branch exists from `plan` but the PR number only from `tdd`, the run's `branch` and `pr_number` are persisted **independently** — the branch is recorded when it is created, the PR number when the PR is opened.
    - **Branch-local scratch, stripped before merge (agents-fsm#21).** The `.agent/plan.md` / `.agent/interface.md` artifacts are the orchestrator's own scratch, not user code, so they never need to land in `main`. They stay readable on the branch for the whole run (later stages read them from fresh worktrees to hand off), but on the terminal `code_review` **approval** the runner strips the `.agent/` directory from the branch tip in one daemon-authored commit (`GitHub.stripAgentArtifacts`) before the run finishes. Because `main` therefore never carries `.agent/**`, removing it is a one-sided delete: neither the between-stage base sync nor the GitHub PR merge can 3-way-conflict on those fixed paths, so back-to-back runs no longer produce self-inflicted `.agent/` merge conflicts. The strip is idempotent (safe to re-fire on a PR-feedback re-approval) and its unconditional push recovers a removal committed locally but stranded by a crash before push.
- **Issues and PRs are durable, declarative state — with one clear owner.** Cross-run *inputs* that humans and the PM agent should be able to read and edit — an issue's dependencies, priority, and ordering — live in the **issue** as a machine-readable block; the **PR** carries the issue↔run linkage and a mirror of the run's state. SQLite stays the source of truth for *runtime control-plane* state (current FSM position, counters, the event queue). The rule that prevents two masters: **declarative scheduling inputs are owned by the issue; runtime state is owned by SQLite; everything else is a derived view.** See [§3.5](#35-encoding-state-in-issues-and-prs).
- **No stacked PRs: dependent work never starts against unmerged work.** A deliberate simplification. When issue B depends on issue A, B's run is not admitted until A's PR is *merged into the base branch*; B then branches off the up-to-date base. We never base one open PR on another open PR. This keeps git history linear, rebases trivial, and makes "dependency satisfied" a single hard signal (A is merged) instead of a fragile chain of in-flight branches. The accepted cost: because the MVP does not auto-merge, dependent work waits for a human to merge the dependency — on purpose, not by oversight.
- **Quality early: every stage self-reviews before handoff.** A stage is not a single pass. Each agent produces its initial output, then runs a bounded internal sequence — self-review for correctness, then cleanup/simplify — before handing off, the way a careful engineer drafts, rereads, and tidies before opening a PR. Catching a defect inside the stage that produced it is far cheaper than catching it in a later review state and paying a full back-edge round-trip. See [Layer 4](#33-the-layers).
- **Own the orchestration; delegate the within-stage agentics.** What is genuinely ours and novel is the *cross-stage* control plane — the FSM, the Scheduler, the event loop, the state store. The *within-stage* agentic loop (taking tool-use turns, editing files, running tests, managing the agent's own context as it works) is a solved problem that a coding **harness** already does better than we would want to rebuild. So we do **not** hand-roll a tool-use loop against the raw model API. Each stage is handed to a harness behind a single seam — the **Stage Executor** (Layer 5). The MVP wraps the **Claude Code CLI run headlessly as a subprocess**; a post-MVP executor wraps the **Claude Agent SDK** (Milestone 10). Both implement the same one-method interface, so swapping harnesses never touches the engine, loop, runner, or store. This is the boundary that keeps "let the harness do the agent work" from leaking into the rest of the system.
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
                             │ Agent harness    │
                             │ (Claude Code →   │
                             │  Anthropic API)  │
                             └──────────────────┘
```

### 3.3 The layers

The codebase is organized into clear layers, each depending only on the ones below it.

**Layer 1 — State Store.**
SQLite, accessed through a thin repository module. It is the single source of truth for control-plane state. Core tables:

- `runs` — one row per task/issue being processed: issue ref, **repo ref** (always the single MVP repo for now, but stored per-run so multi-repo is an additive extension rather than a retrofit — see Milestone 8), current state, status (`running`/`paused`/`blocked`/`awaiting_input`/`done`/`needs_human`; `blocked` = waiting on a dependency, `awaiting_input` = parked on a triage question until a human replies on the issue — see Layer 3 and Triage outcomes), the **`fsm_config_version`** the run is pinned to (see Layer 2), PR number/branch once they exist, cumulative token/cost totals (for the run-budget guard), timestamps. Scheduling inputs (dependencies, priority, order key) are *read from the issue* (§3.5), not owned here; they may be cached on the run for queryability, but the issue wins on conflict.
- `transitions` — append-only log of every state change: from-state, to-state, trigger event, reason payload, the **round counters** at the time, and the **`event_id`** of the event that caused it (nullable — manual transitions and counter resets have none). This *is* your audit trail, and it is also the source the engine reads counters from — they are derived from this log, not stored as mutable fields, so there is one source of truth. The `event_id` link is what makes transition application idempotent: a `UNIQUE(event_id)` index means re-processing the same event can never write a second transition (see Layer 3).
- `events` — the event queue/log that drives handoffs. Each row carries a status (`pending`/`processing`/`done`) and a unique id so processing can be made idempotent (see Layer 3). The atomic claim **gates on the run's status** — only events of a `running` run are picked up — so dispatch is refused at pickup time for `paused`/`blocked`/`needs_human`/`done` runs (the MVP form of the Layer 3 dispatch gate). On daemon startup, any event left in `processing` by a crash is **reclaimed** (reset to `pending`) so it is re-picked-up — without this sweep the at-least-once promise below is silently violated, because the claim only ever selects `pending` rows.
- `agent_runs` — one row per agent invocation: which stage, **which phase (`produce`/`self_review`/`simplify`) and which model**, inputs given, outputs produced, token usage, duration, success/failure. A single stage produces several `agent_runs` rows (one per phase/loop iteration) — which is exactly what lets telemetry show whether a stage's self-review is earning its cost.
- `artifacts` — references (not content) to durable artifacts: run id, kind (`plan`/`interface`/`pr`/`review`), and a locator (branch + path + commit SHA, or PR/issue/comment id).
- `telemetry` / `logs` — structured records the dashboard subscribes to. The **live agent-activity stream** lands in `logs`: a *streaming* Stage Executor (the Claude Code subprocess) parses the harness's `stream-json` as it arrives and summarizes each step (assistant text, tool use, …) into an `AgentActivity`; the Agent Runner persists one `logs` row per activity and pushes it to an in-process sink (the seam the M5 WebSocket stream and the CLI's live trace subscribe to). This is what makes a run's "what is the agent doing right now" visible per issue, rather than opaque until the stage ends. It is a *summary*, not the transcript — cross-stage context still flows only through artifacts.

Artifacts (plans, specs, diffs, review comments) live in the repo or as PR/issue content, *not* in SQLite. The store only references them, via the `artifacts` table.

**Layer 2 — FSM Engine.**
A pure, well-tested module that knows nothing about agents, HTTP, or the database. It answers one question: *given the current state, the completed stage's result, and the guard counters, what is the next state?* It is handed a config object (states, transitions, back-edges, guard limits) — it does not read files or the DB itself; that keeps it pure and side-effect-free, which is what makes the whole system testable and trustworthy.

**Config storage and versioning.** The FSM config is a file on disk (the version-controllable source of truth). The dashboard edits it *through the API* (Layer 6), which writes the file — the dashboard never touches the DB. Each saved version is content-hashed, and **every run records the `fsm_config_version` it started under and uses that version for its whole lifetime.** Editing the config therefore never changes the rules for an in-flight run; new runs pick up the new version. This closes the otherwise-nasty gap where editing the FSM mid-run could reference states a running run has never heard of.

**Layer 3 — Event Loop / Scheduler.**
An in-process loop with an in-memory job queue. When a stage completes, it writes an event; the loop picks it up, asks the FSM Engine for the next state, persists the transition, and — gated by the Scheduler (below) — enqueues an agent job. For the MVP this is a simple in-memory queue backed by the `events` table for durability across restarts. (No Redis, no SQS — that is a later upgrade if you ever need parallelism across many repos.)

**Delivery is at-least-once, so handlers are idempotent.** A daemon can crash after an agent acts but before its event is marked `done`; on restart the stale `processing` event is reclaimed to `pending` and re-picked-up (see Layer 1 `events`). We do not try to make delivery exactly-once (that is the over-engineered path). Instead: (1) applying a transition is keyed on the event id — the transition row carries the `event_id` under a `UNIQUE` index, so a replayed event cannot write a second transition, and the loop checks for an existing transition for that event before acting; (2) agent stage actions check recorded run state before acting (Layer 4), so a re-run updates rather than duplicates. This is the property that makes restart-recovery (Milestone 7) actually safe, and it must be designed in from Layer 3 — not bolted on at the end.

**MVP execution is serial.** At most one agent stage runs at a time. Multiple runs may exist in different states, but the loop dispatches them one stage at a time rather than concurrently — this sidesteps git working-tree races and makes the whole system trivial to reason about. A paused or `needs_human` run holds no executor, so it never blocks others. Parallelism (per-run git worktrees, a real job queue) is a clean later upgrade the boundaries already allow; it is deliberately not in the MVP. See Milestone 8 for the multi-repo / parallel-execution plan. *(Since delivered: Milestone 8 Phase B replaced the serial drain with exactly that bounded worker pool — parallel across runs, serial within a run — so the paragraph above describes the MVP's starting point, not the current default.)*

**The Scheduler decides *which* run advances; the FSM decides *how* a run advances.** Before dispatching any stage, the loop consults a pure, deterministic **Scheduler**: `isDispatchable(run)`. A run is dispatchable when its dependencies are satisfied — i.e. every issue it `depends_on` is closed with its PR merged into the base branch (an externally verifiable signal read from GitHub, §3.5). This is the **no-stacked-PRs rule (§3.1)** made operational: a dependent run is never admitted against unmerged work. Ineligible runs park in `blocked` and are re-evaluated when a dependency actually clears — i.e. when its PR is **merged** (detected via the GitHub adapter, polled in the MVP-shaped design, webhook-driven later), not merely when the dependency's run reaches `done`. The distinction matters: `done` means *merge-ready*, and since the MVP does not auto-merge, a dependency clears only when a human merges it — so dependent runs deliberately wait for that human merge. This is where ordering is **enforced at pickup time**, exactly as required — not by trusting an agent to wait, but by the loop refusing to dispatch. Among dispatchable runs the Scheduler picks in a **total, deterministic order**: `priority` (desc), then `order_key` (asc), then issue number (asc) — same inputs, same schedule, every time, which is what makes it testable. Dependency graphs are checked for **cycles**; a cycle escalates every run in it to `needs_human` rather than deadlocking forever. Like the FSM engine, the Scheduler is pure: inputs are the set of runs, their declared dependencies, and which issues are closed; output is the ordered list of dispatchable runs. In the MVP (one issue, serial) the dependency-ordering Scheduler is a trivial pass-through, but the **dispatch gate still exists at pickup time**: `claimNextEvent` only claims events whose run is `running`, so a `paused`, `blocked`, `needs_human`, or `done` run holds no executor and its events wait until it is `running` again. The full Scheduler arrives with multi-issue async ([Milestone 9](#milestone-9--multi-issue-async--dependency-ordering-post-mvp)), slotting into this same gate point — which is why the gate and the `blocked` status are defined now.

**Layer 4 — Agent Runner.**
Spawns a **fresh agent invocation** per stage. Responsibilities:
- Build the agent's input from durable artifacts + the minimal state slice (never the prior transcripts).
- Inject the correct step-specific system prompt (one per stage).
- Before acting, check the run's recorded state so the action is idempotent (e.g. `tdd` updates an existing PR instead of opening a second one — see [§2 Stage actions are idempotent](#back-edges-revert-then-resume-forward)).
- Hand the phase's work session to the **Stage Executor** (Layer 5) — system prompt + structured input + logical model in, structured result + token usage out. The executor runs it in a harness; the runner does not drive a tool-use loop itself.
- Validate and persist the agent's structured output against a strict schema, then emit the completion event.

**A stage is an agent *work session* — not one API call, and (as the next paragraph details) not necessarily one model invocation either.** Within a stage the agent takes as many tool-use turns as it needs — reading files, editing code, running tests, iterating — against the run's local working tree. "Fresh context" is a guarantee *across* stages (no stage inherits another's transcript), not a limit *within* one. Implementation stages (`frontend`/`backend`) and `tdd` write code via file-editing tools and commit to the run's branch; review stages read the diff and post comments. When the stage ends, its turn-by-turn transcript is discarded — only the artifacts (committed code, comments) and the structured envelope persist. This is how agents actually do the work while cross-stage context stays bounded by construction. **We do not build the tool-use loop.** The Stage Executor (Layer 5) hands the whole work session to a harness — the MVP wraps the **Claude Code CLI as a subprocess**, a post-MVP executor wraps the **Claude Agent SDK** ([Milestone 10](#milestone-10--claude-agent-sdk-stage-executor-post-mvp)) — that owns the tool-use loop, the file edits, and the agent's within-stage context. The orchestrator passes the harness the system prompt, the structured input, the model, the run's working tree, and the **per-stage tool allow-list** (e.g. review stages get read-only tools); it gets back the structured envelope + usage. Owning the loop is the harness's job, not ours.

**Each stage runs an internal sequence — produce, self-review, simplify — not a single pass.** Modeled on how a careful engineer works: draft, reread critically, tidy up, *then* hand off. Every stage executes an ordered list of **phases**:

1. **produce** — the initial output, exactly as a single-pass agent would do today.
2. **self-review (correctness)** — a **fresh-context** critique: a clean invocation that re-reads only the produced artifact + the relevant spec/tests, with no memory of how it was written, and reports what must change. Fresh context is deliberate — an author rereading its own transcript stays blind to its own assumptions; a clean reader does not. It is the cross-stage "fresh context" principle applied *within* a stage.
3. **cleanup / simplify (quality)** — a pass that takes the review's findings as input, applies the fixes, then simplifies *without changing behavior* (dedupe, clarify, remove dead code). This is constrained, mechanical work where the rubric, spec, and failing tests do the steering.

Phases 2–3 form a **bounded loop**: review → fix → re-review, up to a cap (configurable, default 5). If the self-review judges the work acceptable, the stage hands off; if the cap is hit while the review still reports blocking issues, the run escalates to `needs_human` with the review notes — reusing the same guard-and-escalate pattern as the outer FSM. Each round is given its **round context** (`reviewRound`: round *n* of *cap*, plus the previous round's findings), so the reviewer starts by verifying the prior findings were resolved — and is told not to move the goalposts — instead of re-reviewing cold every round. Internal passes count against the run budget ([§2 Guards](#guards-loop-protection)), so they can never run away.

**This is configured, not hardcoded — including the model per phase.** Each state declares its phase **recipe** and a **model per phase** in the per-stage agent config (loaded from the same config file as the FSM, but consumed by the Agent Runner — the FSM engine never sees it and stays pure). Sensible defaults: producing stages (`plan`, `interface_design`, `tdd`, `frontend`, `backend`) use `[produce, self_review, simplify]` with the **frontier model for all three** — the `simplify` pass is also the *fix* phase, and history showed a cheaper fixer reliably fails to resolve frontier-grade findings, so the loop never converges and trips the cap (an escalation that costs far more than the saved tokens); a stage whose fixes are mechanical can set `models.simplify: "cheap"` to restore the economy. Pure review stages (`plan_review`, `code_review`) use `[produce]` only — they *are* the independent review, so a self-review of a review earns little. Self-review **complements** the outer review states, it does not replace them. The cleanup pass must never break the `tdd` failing-tests contract or violate the interface spec — both are re-checked after it.

**The agent output contract.** Every agent returns the *same* envelope, validated before it is trusted:
- `requested_transition` — one of the transitions the FSM allows *from this state* (e.g. `approve`, `request_changes`, `revert_to_interface_design`, `escalate`). The engine still enforces legality; the agent only requests.
- `reason` — structured payload (required on any back-edge or escalation) explaining *what must change*, so the target stage does not repeat itself.
- `artifacts` — references to anything the agent produced or updated (branch/path/SHA, PR/comment ids), to be recorded in the `artifacts` table.
- `flags` — stage-specific outputs the engine reads, e.g. `plan` returns `needs_frontend` / `needs_backend`.

**On invalid or missing output**, the runner does not guess. It retries the call a bounded number of times (Layer 5 owns retry/backoff); if the output still fails schema validation, the run escalates to `needs_human` with the raw output attached. A malformed agent response must never be silently coerced into a transition.

**Layer 5 — Integrations.**
- **Git/GitHub adapter** — read issues, create branches, open/update PRs, post review comments, read diffs. It also owns the run's **local working tree**: the daemon keeps a local clone of the target repo and checks out the run's branch, which is where agents edit files and run tests; commits are pushed and PRs managed via GitHub. Wrapped behind one interface so the agents never touch git or GitHub directly.
- **Stage Executor (the agent harness)** — the single seam through which a stage's work session runs. Its one method takes a system prompt + structured input + logical model and returns a structured result + token usage; *how* the agentic work happens (the tool-use loop, file edits, within-stage context, retries) lives entirely inside the harness behind it. Two concrete executors, chosen by the swap rule above: the **MVP executor wraps the Claude Code CLI as a headless subprocess** (spawn it in the run's working tree with the stage's system prompt, model, and tool allow-list; read back its structured final output and token usage); a **post-MVP executor wraps the Claude Agent SDK** in-process ([Milestone 10](#milestone-10--claude-agent-sdk-stage-executor-post-mvp)). Token accounting is read from whatever the harness reports. We deliberately do **not** own a tool-use loop here — that is the whole point of delegating to a harness. The per-stage tool allow-list is part of the agent recipe (Layer 4, §3.3) and is passed through to the harness.
- **Built for fakes.** Each adapter is defined by an interface, and each ships with an in-memory fake. The fakes are what Milestones 1–2 run against — the whole pipeline is testable end-to-end with zero network calls and zero cost, and real-harness/real-API integration tests sit behind an explicit flag. The same contract suite runs against the fake and the real executor, so the stub cannot silently drift from harness behavior.
- **Secrets.** The GitHub token and the Anthropic API key (which the harness reads from its environment) are taken from the environment / a local config file (e.g. `.env`), never committed and never stored in SQLite. This is the only configuration that is a secret; the FSM config (Layer 2) is not.

**Layer 6 — API + Telemetry surface.**
- **HTTP API** for commands: start a run, stop/pause/resume, revert to a stage, edit FSM config, list runs, fetch history.
- **`stop` vs `pause`.** `pause` halts dispatch mid-run; `stop` ends a run (a terminal status the dispatch gate never admits). Both leave all state and artifacts intact for inspection — `stop` is not delete — and both are **reversible**: `resume` re-opens a `stopped` run and continues it from the stage it was stopped at (a loop-owned self-transition with a fresh budget), the operator's "pick it back up." (A `done` run, by contrast, completed — re-entry there is `revert <state>` or PR-feedback re-open, not `resume`.)
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
| Quality early (catch defects where they originate) | Each stage runs an internal produce → self-review → simplify sequence (Layer 4) before handoff, fixing problems in the stage that made them instead of triggering an expensive back-edge later. |
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

- **Language/runtime:** TypeScript on Node.js. One language across the daemon and the dashboard reduces friction, and both the Claude Code CLI and the Claude Agent SDK are first-class here.
- **State store:** SQLite (via `better-sqlite3` or Prisma). Zero-ops, durable, queryable, perfect for one-user/one-repo.
- **API:** a small HTTP framework (Fastify/Express) plus a WebSocket library for the live stream.
- **Dashboard:** React served as static assets by the daemon. A graph library (e.g. React Flow) for the live FSM view and the editor.
- **Git/GitHub:** the GitHub REST/GraphQL API via Octokit; local git operations via simple git commands or a wrapper.
- **Agents:** a coding **harness** per stage, one system prompt per stage. The MVP runs the **Claude Code CLI headlessly as a subprocess** (e.g. `claude -p` with `--output-format stream-json`, `--model`, and a per-stage `--allowedTools` allow-list); a post-MVP executor swaps in the **Claude Agent SDK** in-process (Milestone 10). We deliberately do not hand-roll the tool-use loop — the harness owns the within-stage agentics (tool calls, file edits, context management), while the orchestrator owns the cross-stage FSM, Scheduler, event loop, and store. The two are joined only by the one-method **Stage Executor** seam (Layer 5), so the harness is swappable without touching the engine.

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
- In-process event loop backed by the `events` table, with at-least-once processing and event-id-keyed (idempotent) transition application. On startup, reclaim stale `processing` events back to `pending` so a mid-flight crash does not strand an event.
- Agent Runner with a **stubbed** agent (returns canned results) so the full pipeline can run end-to-end without API calls.
- Runner executes a configurable per-stage **phase recipe** (produce → self-review → simplify) with the bounded internal loop; stubs emit canned per-phase outputs so the mechanism is exercised before any real prompts exist.
- Persist transitions, events, and agent runs (one row per phase/iteration).
- A CLI to start a run and watch it progress through the FSM with stub agents. **At this milestone the whole orchestration mechanism is validated.**
- **Tests:** a golden-path integration test that drives a run start→`done` on stubs and asserts the exact transition sequence; back-edge scenarios driven by stub results (e.g. a stub `code_review` that requests changes until the round limit, asserting escalation). **Crash-recovery test belongs here, not Milestone 7:** kill the loop mid-run, restart, and assert no duplicate transition/PR/charge — this is the test that proves the Layer 3 idempotency design, so it must exist as soon as the loop does.

### Milestone 3 — Integrations
- GitHub adapter: read issue, create branch, open/update PR, post comments, read diff, manage the run's local working tree — behind an interface, with an in-memory fake.
- **Stage Executor — Claude Code subprocess adapter:** the first real `StageExecutor`, wrapping the headless Claude Code CLI as the per-stage harness. Spawn it in the run's working tree with the stage's system prompt, logical model (mapped to a concrete `--model`), and per-stage `--allowedTools` allow-list; read back its structured final output and token usage. It slots in behind the existing `StageExecutor` interface — the in-memory stub stays unchanged — and it builds **no** tool-use loop of its own, because the harness owns that. (The Anthropic *API key* is just an env var the harness consumes; we never call the model API directly.)
- **Tests:** contract tests that run the *same* suite against the stub executor and (behind a flag) the real Claude Code subprocess, so the stub cannot silently drift from harness behavior.

### Milestone 4 — Real agents
- Write the step-specific system prompts, one per stage (triage and code-review have the most interesting logic).
- Write the per-phase prompts: the **self-review rubric** (correctness checklist per stage) and the **cleanup/simplify** instructions, and set the per-phase model defaults (frontier to produce/critique, cheaper to simplify).
- Implement the structured output contract from [§3.3 The layers](#33-the-layers) (Layer 4 — requested transition + reason + artifact refs + flags) as a single schema shared by all stages.
- Wire real agents into the Agent Runner, replacing the stubs.
- **Tests:** schema-validation tests for the output envelope, including the malformed-output path (bounded retry, then escalate to `needs_human` — never coerce). Internal-sequence tests: a stage whose self-review finds and fixes a seeded defect; the bounded loop hitting its cap → escalate to `needs_human`; a cleanup pass that must leave the `tdd` failing-tests contract and interface spec intact. Run the real pipeline against a test repository and a sample issue.

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
- A **global concurrency cap**, rate-limit handling in the Stage Executor / harness, and an optional global cost ceiling on top of the per-run budget — N parallel agents mean N× spend and N× rate pressure.
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

### Milestone 10 — Claude Agent SDK stage executor (post-MVP)

Swap the per-stage harness from a CLI subprocess to the **Claude Agent SDK**, in-process. This is the second concrete `StageExecutor` and the payoff of the Layer 5 seam built in Milestone 3: the MVP proved the whole product end-to-end against the Claude Code subprocess executor; this milestone upgrades *how* a stage runs without touching anything above it. Deliberately scheduled late — only after a working product exists — so the swap is an optimization, not a prerequisite.

- **`AgentSdkExecutor` implementing the same `StageExecutor` interface.** It runs the agentic work in-process via the SDK instead of shelling out. Nothing in the engine, Scheduler, event loop, Agent Runner, or store changes — by construction, since they only ever see the one-method interface.
- **Why it's worth doing:** no subprocess to spawn and parse per phase; **first-class token-usage objects** (cleaner feed into `agent_runs` and the run-budget guard than scraping CLI output); native MCP, subagents, and finer permission/tool-policy control; lower per-invocation overhead, which matters once Milestone 8 Phase B runs agents in parallel.
- **Config maps over cleanly:** the per-stage tool allow-list and logical model names already live in the agent recipe (Layer 4); the new executor maps them to the SDK's options instead of CLI flags.
- **Tests:** run the **same Milestone 3 contract suite** against the SDK executor (behind the real-harness flag), proving it is behavior-compatible with both the stub and the subprocess executor. The fake stays the everyday test double, so the rest of the suite is untouched.

Choosing between the two executors is configuration, not a rewrite — a deployment can keep the subprocess executor or opt into the SDK one. Neither the FSM engine nor its tests change.

### Milestone 11 — Repo auto-pickup / continuous mode (**core shipped** — see §9.10)

Point the orchestrator at a **whole repository** (not a single issue) and have it work the backlog on its own: pick up an open issue, drive it to a merge-ready PR, **wait for a human to merge that PR, then automatically start the next issue** — repeating until the backlog is empty. This is the "set it and let it run" mode the dashboard's new-run box hints at.

**Shipped:** the opt-in per-repo `watch` flag (`repos.watch`, migration 10; toggled from the home-ledger **Watch** button or `POST /repos/watch`), the **Issue Intake Poller** (`src/loop/issue-intake-poller.ts` around the pure `src/loop/issue-intake.ts`) that admits the next eligible issue **sequentially (in-flight cap 1)** each poll tick, and the **safety guards** (owner-filed / unassigned / non-`[WIP]`, with an `agent help wanted` override label) that stop an untrusted issue from becoming an injection or cost vector — operating guide §9.10. Auto-picked issues go through the same `POST /runs` admission (dedup, cost ceiling, enrollment) as manual runs. *Still open:* a configurable cap > 1 (parallel pickup) and a label/milestone filter to pull from a subset of the backlog.

It is mostly **composition of pieces already planned**, which is why it is cheap to add once they exist:
- **Issue ingestion** for a repo: list open issues via the GitHub adapter (`gh issue list` / `gh search`, the same surface `suggestIssues` already uses) and create a run per issue — gated by a configurable in-flight cap (default **1**, i.e. strictly sequential).
- **Auto-advance on merge** reuses the **Milestone 9 merged-PR signal** (`PullRequest.state === 'merged'`, polled now / webhook later): a repo "slot" frees when the current run's PR is merged (or the issue is closed), and the next issue from the ordered backlog is admitted. The **Scheduler** (Milestone 9) already computes a deterministic order and a dispatchable set; continuous mode is that gate driving issue *admission*, not just stage dispatch.
- **Repo as a first-class dimension** from **Milestone 8 Phase A** (the `repos` table + a repo argument): continuous mode is configured per repo (which label/milestone to pull from, the in-flight cap, the base branch).
- **A repo control surface**: `POST /repos` to enroll a repo in continuous mode and `DELETE`/pause it; the dashboard gets a repo view showing the backlog, the active run, and merged/blocked counts.

**Sequencing & safety:** serial by default (in-flight cap 1) means it needs **no concurrency machinery** — it can ship on the serial loop ahead of Milestone 8 Phase B, with parallel pickup (cap > 1) folding in later once worktrees exist. It never auto-merges (a human still reviews and merges every PR — the same no-stacked-PRs discipline as §3.1), so "continuous" means *continuous pickup*, not unattended shipping. A run that escalates to `needs_human` holds its slot until resolved, so a broken issue pauses the queue rather than silently skipping ahead.

**Tests:** an ingestion test (a repo's open issues become ordered runs, capped); an auto-advance test (a merged PR frees the slot and admits exactly the next issue, in order); a gate test (an escalated run blocks pickup until resolved). The Scheduler and FSM engine are unchanged — this is admission control built on their existing outputs.

---

## 6. Key risks and how the design handles them

- **Infinite review loops.** Mitigated by round-limit guards that escalate to `needs_human`.
- **Reversion without progress** (an agent re-runs a stage and produces the same output). Mitigated by requiring a structured `reason` on every back-edge so the target stage knows what to change.
- **Slow cost/time drift** that no single loop limit catches. Mitigated by a per-run budget guard (tokens/time/invocations) that escalates to `needs_human`.
- **Duplicate side-effects on restart** (a second PR, a double charge). Mitigated by at-least-once events with idempotent, id-keyed handlers and stages that check recorded state before acting — designed in at Layer 3, tested from Milestone 2. The non-idempotent calls — posting comments (review stages, triage) and creating sub-issues (a triage split) — are covered by a **transactional outbox** (Milestone 7, `src/agent/side-effects.ts` + the `side_effects` ledger): a crash in the window after the GitHub call but before the transition commits is replayed from the ledger (the completed call is reused, never repeated), and the irreducible mid-call window escalates `partial_side_effect` for a human to verify rather than silently duplicating. The transition itself never duplicates (it is event-keyed).
- **Config edits breaking in-flight runs.** Mitigated by pinning each run to the `fsm_config_version` it started under; edits only affect new runs.
- **Malformed agent output coerced into a bad transition.** Mitigated by strict schema validation: bounded retry, then escalate with the raw output — never guess.
- **Dependency cycles / deadlock** (issue A waits on B waits on A). Mitigated by deterministic cycle detection in the Scheduler that escalates the whole cycle to `needs_human` instead of parking forever.
- **Wrong or stale scheduling order.** Because dependencies live in the issue and are read deterministically, a bad order is fixed by editing the issue — no code change, no DB surgery — and the Scheduler re-evaluates on the next cycle.
- **Two sources of truth (GitHub vs SQLite).** Mitigated by the explicit ownership rule (§3.5): declarative inputs owned by the issue, runtime state owned by SQLite, everything else a derived view.
- **Starvation** (a low-priority run never selected). Mitigated by the deterministic total order whose final tiebreaker is issue number (oldest first); time-based aging can fold into `order_key` if it ever bites.
- **Self-review adds cost or thrashes.** Mitigated by the bounded internal loop (capped rounds), the per-run budget that bounds all passes together, and a cheaper model for the mechanical cleanup pass. Per-phase telemetry tells you which stages' self-review actually changes output; if one never does, drop that phase from the stage's recipe (data-driven KISS).
- **Cleanup silently breaks behavior.** The simplify pass may not change behavior — mitigated by re-checking the `tdd` failing-tests contract and the interface spec after it; a cleanup that breaks them is rejected.
- **Context creep.** Structurally impossible to accumulate, because no conversation persists across stages; agents are rebuilt from artifacts each time.
- **UI/engine entanglement.** Prevented by making the daemon fully headless with the dashboard as a pure API client — this is also what unlocks future phone/remote access cheaply.
- **Harness lock-in / coupling.** Delegating the within-stage agentic loop to a harness could leak harness-specific assumptions through the codebase. Mitigated by confining all of it behind the single one-method **Stage Executor** seam (Layer 5): the MVP wraps the Claude Code subprocess, a post-MVP executor wraps the Claude Agent SDK (Milestone 10), and the engine, Scheduler, loop, runner, and store never depend on which. Swapping or adding a harness is a new class, not a refactor.
- **Reinventing the agent loop.** Hand-rolling a tool-use loop, file-edit tooling, and within-stage context management against the raw model API would be a large surface to build and maintain badly. Avoided by design: that work is the harness's job, and we own only the cross-stage control plane.
- **Over-engineering.** Held back deliberately: SQLite over a database server, in-process queue over a broker, one repo over many. Each is a clean, isolated upgrade if a real need appears.

---

## 7. Summary

We are building a headless, ownable orchestrator daemon that drives a fleet of single-purpose AI agents through a configurable finite state machine, using event-driven fresh-context handoffs to keep agents focused and avoid runaway context. State and artifacts live outside the agents, which makes reversion clean and the whole system observable. A local web dashboard, served by the daemon, provides FSM configuration, live progress, telemetry, and start/stop control — and, because it is already a web client over a clean API, leaves the door open to remote/phone access later without a redesign.

The build order puts the novel, high-risk core first (FSM engine, then event-driven dispatch validated with stub agents), then layers on integrations, real agents, the API surface, and finally the dashboard — so that at every milestone there is something working to test, and the most important logic is proven before anything is built on top of it.

---

## 8. Implementation status

**Done: Milestone 0 (Foundations), Milestone 1 (FSM engine), Milestone 2 (event loop + agent runner on stubs), Milestone 3 (integrations — Git/GitHub adapter + Claude Code subprocess executor), Milestone 4 (real agents), Milestone 5 (API + telemetry surface), Milestone 6 (local web dashboard), Milestone 7 (polish — transactional outbox, `needs_human` UX, operating guide), Milestone 8 (multi-repo + parallel execution — worker pool, concurrent crash-recovery, rate-limit retry, global cost ceiling), Milestone 9 (multi-issue async + dependency ordering — the Scheduler, issue markers, the dependency dispatch gate), Milestone 11 (continuous mode — core shipped, §9.10), Milestone 12 (per-repo source binding). Plus cross-cutting features shipped on top of the milestones: multi-harness support (Claude Code + Cursor), PR-feedback re-entry, graceful shutdown, merge-conflict handling, and the per-run operator↔agent chat side channel. Not started: Milestone 10 (Claude Agent SDK stage executor). Remaining planned work is tracked as [GitHub issues](https://github.com/jzohdi/agents-fsm/issues) (see the "Remaining work" list at the end of this section).**

- **Layer 1 — State Store** (`src/store/`): SQLite schema, `db.ts` connection/migration, and a typed `Repository`. Round counters are derived from the `transitions` log (`computeCounters`), never stored as mutable fields. `commitTransition` is transactional; the event queue supports atomic, status-gated claim.
- **Layer 2 — FSM Engine** (`src/fsm/`): pure `decideNext` (forward resolution with skip flags, `toOneOf` targets, guard escalation), `budgetExceeded`, and config loading with zod + semantic validation and content-hash versioning. The default pipeline (§2) ships as `src/fsm/default-config.json`.
- **Layer 3 — Event Loop** (`src/loop/event-loop.ts`): an in-process loop over the `events` table. Claims an event, runs the stage via the Agent Runner, asks the engine for the next state, and atomically commits the transition + follow-up event. At-least-once delivery with idempotent, event-id-keyed processing; `recover()` reclaims stranded `processing` events on startup. Owns the run-budget and illegal-transition guards (both escalate to `needs_human`). Originally serial; Milestone 8 Phase B added a bounded worker pool (`drain(concurrency)`) that runs stages **parallel across runs, serial within a run**. The pool exposes a `wake()` the Orchestrator's `kick()` calls whenever work is enqueued mid-drain, so a run admitted while a long stage is in flight (an auto-picked issue, a resume, a fresh start) fills a free concurrency slot **immediately** instead of starving until an in-flight stage finishes.
- **Layer 4 — Agent Runner** (`src/agent/runner.ts`): executes the per-stage phase recipe (produce → bounded self-review → simplify), records one `agent_runs` row per phase, accumulates usage, and escalates on the internal-review cap or malformed output (never coerces). Skip flags from `plan` are persisted on the run so later FORWARD decisions honor them.
- **Layer 5 — Stage Executor seam** (`src/agent/executor.ts`): `StageExecutor` is the single swappable seam to the agent harness — "one work session in, structured JSON + usage out," with logical model names the executor maps to concrete models. Milestone 2 ships an in-memory `StubExecutor`; Milestone 3 adds the MVP **Claude Code subprocess** executor (`src/agent/subprocess-executor.ts`) as a drop-in implementation, and a **Claude Agent SDK** executor is a second one (Milestone 10). The harness owns the tool-use loop; the FSM engine and loop never depend on any of this.
- **Layer 5 — Git/GitHub adapter** (`src/integration/`): the `GitHub` interface (`github.ts`) — read issue, prepare working tree (create branch), commit/push, read diff, open/update PR, post comment — with an in-memory `FakeGitHub` (`github-fake.ts`, the everyday test double) and a real `GitHubCli` (`github-cli.ts`) using local `git` for the working tree and `gh` for the API. The local-git half needs no network and is covered by offline temp-repo tests; the API half is exercised behind the `RUN_REAL_GITHUB` flag.
- **Demo CLI** (`src/cli.ts`, `npm run start -- <issueRef> [--db <path>]`): starts a run and streams its transitions to `done` on stubs — the whole orchestration mechanism, validated with zero network calls.
- **Tests** (164, all passing): the M0/M1/M2 suites plus the Milestone 3 additions — the **Stage Executor contract suite** (`executor-contract.ts`) run against the stub, the subprocess executor over a fake harness, and (behind `RUN_REAL_HARNESS`) the real Claude Code CLI; an **end-to-end integration test** driving the Event Loop with the real subprocess executor (fake harness) to `done`; subprocess-executor unit tests (argv, model mapping, stream-json parsing, known-token-field + dollar-cost summation, error paths); a failed-invocation telemetry test; `FakeGitHub` behavior tests; and `GitHubCli` tests (issue-ref parsing, `gh` API methods via injected exec, error mapping, and local-git working-tree/commit/diff against a real temp repo with a bare remote, including the **crash-recovery** case where a lost working tree is re-cloned and the pushed branch restored without losing commits).

**Refinements made during the M0/M1 audit** (so the foundation carries Milestone 2's weight without a retrofit):

- **`event_id` on `transitions` + `UNIQUE` index** — makes transition application idempotent at the DB level, the foundation for the loop's at-least-once handling. `Repository.getTransitionByEventId` is the lookup the loop uses before acting.
- **`Repository.recoverProcessingEvents()`** — reclaims events stranded in `processing` by a crash. The M2 event loop calls this on startup so the at-least-once promise holds.
- **Decoupled `branch`/`pr_number` persistence** — `setRunBranch` (branch created at `plan`) is separate from `setRunPr` (PR number set at `tdd`), matching the artifact lifecycle in §3.1.
- **Status-gated event claim** — `claimNextEvent` joins `runs` and only claims events of a `running` run, so dispatch is refused at pickup time for `paused`/`blocked`/`needs_human`/`done` runs. This is the MVP dispatch gate the M2 loop needs for escalation and pause to actually halt work; the Milestone 9 Scheduler slots into the same point. A single atomic statement, so it stays safe under the concurrent claim of Milestone 8 Phase B.
- **`Repository.listRuns(status?)`** — enumerate runs (optionally by status) for the CLI/dashboard and operational queries; the loop itself stays event-driven.

**Added in Milestone 2:**

- **Agent recipe in the config file** — the per-stage **phase recipe + model-per-phase** (§3.3 Layer 4) lives under an optional `agents` key in the *same* config file. `loadConfig` splits it out and hands the engine only the FSM rules (it never sees `agents`), while the version hash covers both so a run still pins them together. Stages absent from `agents` use the producing default `[produce, self_review, simplify]`; pure review stages (`plan_review`, `code_review`) are set to `[produce]`.
- **`runs.flags`** — persisted skip flags, merged from each envelope. This is what makes `plan`'s `needs_frontend`/`needs_backend` decision survive to the `tdd → frontend/backend` FORWARD choice instead of being lost after the stage that set it.
- **Harness-swappable agents** — all agent work goes through the `StageExecutor` seam (Layer 5). The MVP Claude Code subprocess executor (Milestone 3) and the post-MVP Agent SDK executor (Milestone 10) are each a new class implementing one method; nothing in the engine, loop, or runner changes. The orchestrator never owns a tool-use loop — the harness does.

**Hardening from the Milestone 2 audit** (so Milestone 3 builds on a resilient loop):

- **Loop survives a thrown executor.** A `StageExecutor` that throws after exhausting its own retries escalates *that* run to `needs_human` (`executor_error`) instead of crashing the whole drain. Retry/backoff stays the executor's job (Milestone 3); the loop just refuses to die.
- **Back-edge reason is enforced.** The loop refuses a back-edge whose envelope carries no `reason` (escalates `missing_reason`), making the §6 "reversion without progress" mitigation real rather than advisory — a reasonless revert would only make the target stage repeat itself.
- **Phase recipes are constrained to runnable shapes.** The runner always runs `produce` first and treats `self_review`/`simplify` as ordered toggles, so config validation now rejects any `phases` that isn't a prefix of `[produce, self_review, simplify]` (e.g. `[produce, simplify]`, `[self_review]`) — the config can no longer express a recipe the runner would silently misinterpret.
- **Config-version pinning is now fail-safe.** Each run records the `fsm_config_version` it started under, but the loop carries a single config. If a run's pinned version differs from the loop's (config edited + daemon restarted), the loop escalates that run (`config_version_mismatch`) instead of silently applying possibly-changed rules. Loading a run's *pinned* version (so it continues under its original rules) needs the versioned config store and lands with the FSM editor in Milestone 5/6; until then, fail safe.
- **Telemetry can't wedge the loop.** A throwing `onTransition` subscriber is caught and ignored — best-effort notification, so the future WebSocket stream (Milestone 5) can never stall the drain.

**Added in Milestone 3:**

- **Git/GitHub adapter behind one interface** — `GitHub` (`src/integration/github.ts`) is the single Layer 5 seam for issues, the run's local working tree, PRs, and comments; agents never touch git or GitHub directly. It splits cleanly by where the side effect lands: GitHub-API methods (network) and local-git methods (no network). `FakeGitHub` is the in-memory double the whole pipeline runs against ("Built for fakes"); `GitHubCli` is the real adapter (`git` + `gh`).
- **`prepareWorkingTree` is the "create branch" primitive** — preparing the run's working tree creates the branch off `base` when new and is **idempotent** (a re-prepare on a back-edge keeps existing commits instead of resetting), matching §2 "stage actions are idempotent." `readDiff` is branch-relative (`base...branch`) so it needs no network and is a property of the code, not the PR record.
- **Claude Code subprocess Stage Executor** (`src/agent/subprocess-executor.ts`) — the first real `StageExecutor`. It spawns `claude -p --output-format stream-json` in the run's working tree with the resolved `--model`, the per-stage `--allowedTools`, and the stage system prompt via `--append-system-prompt`, then parses the terminal `result` event for the structured output + token usage. It owns **no** tool-use loop (the harness does) and never calls the model API directly (the key is just an env var the harness reads). The process spawn is injectable, so argv/parsing/error handling are tested offline.
- **The `StageExecutor` contract suite** (`src/agent/executor-contract.ts`) — one set of assertions ("structured JSON output + finite, non-negative usage out") run against the stub, the subprocess executor over a *fake* harness (offline), and (behind `RUN_REAL_HARNESS`) the real Claude Code CLI. Running the identical contract against all of them is what stops the stub from silently drifting from real harness behavior.
- **Per-stage tool allow-list in the agent recipe** — `StageAgentConfig.allowedTools` (validated, surfaced by `recipeFor`) gives the allow-list a config home; the Agent Runner forwards it, plus an optional `resolveWorkingDir(run)`, into the executor request. `AgentRunRequest` gained optional `workingDir`/`allowedTools` (additive — the stub ignores them). The working-tree *lifecycle* (the loop preparing a tree per run) lands with real-agent integration in Milestone 4; the seam is in place so that is a wiring change, not a runner change.
- **Dollar cost flows through the executor seam** — the real harness reports `total_cost_usd`, so `AgentUsage` carries an optional `cost` the Agent Runner sums onto the run's `cost_used` (previously a dead column). Tokens still drive the budget guard; cost is recorded for telemetry and a future cost ceiling. The stub can supply a canned `cost` for tests.
- **Working-tree preparation is crash-safe, not just back-edge-safe** — `GitHubCli.prepareWorkingTree` checks out an existing *local* branch when present, else restores the branch from the *remote* if it was already pushed (a fresh clone after the working tree was lost), and only creates off `base` for a genuinely new branch — so it never resets a branch to base and discards pushed commits. `readDiff` diffs against `origin/<base>` so it is correct even when `base` is not the clone's default branch.
- **Failed phase invocations are now telemetry, not silence** — when the executor throws (a real harness failure after its own retries), the Agent Runner records a `success: false` `agent_runs` row (stage/phase/model/duration/error) before propagating to the loop's `executor_error` escalation. The schema's `success/failure` field is finally meaningful, and an operator can see *which* phase failed. Token usage is summed from an explicit set of known Anthropic token fields rather than "every numeric field," so a future non-token numeric field can never silently inflate the count.
- **The real executor is proven through the full pipeline** — an offline integration test (`src/integration/loop-subprocess.test.ts`) drives the Event Loop with the actual `SubprocessStageExecutor` over a fake harness and asserts a run reaches `done` with the exact transition sequence and usage/cost flowing through every layer. This de-risks the Milestone 4 wiring of the real CLI into the loop.

**Deliberate semantics, recorded so they are not mistaken for bugs:**

- Round guards escalate **at or over** the limit (`count >= limit`): N back-edges are allowed, then the next attempt escalates (verified by the integration test).
- The run **budget** escalates only when a ceiling is **strictly exceeded** (`usage > max`) — a ceiling is a hard cap, not a target; the round guard's `>=` is about counting completed rounds.
- The engine does **not** enforce "at least one of `needs_frontend`/`needs_backend` is true." That policy belongs to the `plan` agent (§2); the engine stays pure and reads the flags as given.
- The run-budget guard is checked **before each stage dispatch**, not before each internal phase; the per-stage `reviewCap` bounds within-stage cost, and the budget is the backstop across stages (README §2). A crash *before* a stage's transition commits will re-run (and re-charge) that stage on recovery — the accepted at-least-once cost; the idempotency guarantee covers the *post-commit* window, which is what the crash-recovery test pins.

**Milestone 4 — real agents** (design + decisions in [plans/milestone-4.md](plans/milestone-4.md)). Split into **M4a** (orchestration plumbing, done) and **M4b** (real prompts + the real run — done). Real runs against live repos have since driven the hardening documented below; the flag-gated live e2e stays opt-out by default because it spends tokens (see the note after M4b), so it is an opt-in check rather than outstanding work.

**Done in Milestone 4a** (plumbing, on `FakeGitHub` + `StubExecutor`, no network/cost — 187 tests passing):

- **The Agent Runner now owns the working-tree lifecycle** (`src/agent/runner.ts`): it reads the issue, prepares the run's working tree (creating the branch at `plan`), runs the phase recipe in that tree, then commits/pushes and — at `tdd` — opens the PR. The `GitHub` adapter is injected; the Event Loop is unchanged. Per-stage behavior is declared, not hardcoded: a `StageIo` descriptor (`triage` / `produce` / `review`, plus `opensPr`) in the agent recipe drives it.
- **Idempotent PR open (find-or-create)** — `findOpenPrForBranch` on the adapter lets `tdd` adopt an already-open PR (guarded by `pr_number` *and* a branch lookup), closing the crash/resume window between opening the PR and persisting its number. Verified no duplicate PR on a `tdd` back-edge or after a simulated crash.
- **Bounded malformed-output retry** — the runner re-invokes a phase a bounded number of times on schema-invalid output before escalating `malformed_output` (never coerce); a retry that yields valid output recovers.
- **Structured git-failure escalation + resume** — git/GitHub failures become a labeled `git_error` escalation (not a crash); `EventLoop.resumeRun(runId)` moves a parked `needs_human` run back to the stage it escalated from, resets the round counters, and re-dispatches it (idempotent, so no duplicate side effects). Exposed via a CLI `resume` subcommand.
- **Per-stage tool allow-lists and dollar cost** carried through config and the executor seam; review comments flow through a new optional `comments` envelope field (the runner posts them — agents never touch GitHub directly).
- **Tests** (+18 over M3): the runner working-tree/PR/comment lifecycle and git-error escalation (`runner-lifecycle.test.ts`), `findOpenPrForBranch` (fake + injected-exec real adapter), `io`-descriptor validation, malformed-retry-then-escalate (and retry-recovers), and the loop-level `resume` path.

**Done in Milestone 4b** (real prompts + real-run wiring — 218 tests passing, +1 flag-gated real run skipped by default):

- **Per-stage and per-phase prompts as version-controlled files** (`src/agent/prompts/`): a shared `base.md` (how an agent receives work, that it never touches git/`gh` directly, and the "final message is exactly the JSON" rule), `stages/<stage>.md` (the role + allowed transitions for each of the eight FSM stages), `phases/{self_review,simplify}.md` (the correctness rubric and the fix-then-simplify pass, both carrying the §3.7 *agent-runs-the-tests* instructions), and two output contracts — `envelope-contract.md` (produce/simplify) and `verdict-contract.md` (self-review). `triage` and `code_review` carry the most logic (route proceed/needs-more/split; approve/request-changes-to-frontend-or-backend with PR comments).
- **The real `SystemPromptFn` loader** (`src/agent/prompts.ts`, `createSystemPromptFn`): loads the files once at startup (fail-fast on a missing stage prompt) and composes per (stage, phase) — base + stage role + phase instructions + the matching contract (verdict for `self_review`, envelope otherwise). Prompts are **code, not config**: deliberately *not* in the FSM config hash (plans/milestone-4.md §3.4), appended via `--append-system-prompt` so the agent keeps the harness's tool-use competence.
- **Real-run assembly** (`src/real-run.ts`, `buildRealRunner`): one place that wires `SubprocessStageExecutor` + `GitHubCli` + the real prompts, shared by the CLI and the gated e2e so the wiring can't drift. It owns the §6 cost-control override (`forceCheapModels`, pin every phase to the cheap model for a low-cost first run) and guards against a missing repo.
- **CLI real mode** (`src/cli.ts`, the default): builds the real runner with `--repo`/`--base`/`--work`/`--cheap` config, plus repo-source/auth/model options — `--local-repo` (clone each run's working tree from a local checkout, offline, still pushing to GitHub), `--clone-url` (SSH/HTTPS remote override), `--permission-mode` (so the headless harness can edit/run tests unattended), and `--model` (the concrete model for produce/self-review, e.g. `sonnet` — cheaper than the opus default but capable of the strict JSON contract that the cheap haiku model is not). Runs are now real by default; pass `--mock` for the stub/fake harness (no money, no network).
- **Tests** (+31 over M4a): prompt-composition tests including the guard that *every* stage with an agent recipe has a role prompt (`prompts.test.ts`); the cheap-model override + empty-repo guard (`real-run.test.ts`); CLI arg parsing with the mode default — runs are real unless `--mock` is passed (`cli-args.test.ts`); a seeded-defect internal-sequence test asserting the simplify-corrected envelope — not produce's — is handed off (`runner.test.ts`); and an **offline real-prompt e2e** (`real-prompts-e2e.test.ts`) that drives the whole loop with the real prompts + real subprocess executor over a fake harness, asserting a well-formed composed prompt *and the issue plumbed into the input* on every invocation and a run to `done`. The cap→escalate path was already covered. Real-run hardening surfaced by the first live shakeout is pinned too: `openDb` creates a missing parent dir (`db.test.ts`), the subprocess spawn closes stdin so `claude -p` never blocks waiting on it (`subprocess-executor.test.ts`), `--local-repo` clones the working tree from a local checkout while still pushing to GitHub (`github-cli.test.ts`), an **unauthenticated harness is classified as a `FatalExecutorError`** so the loop aborts the whole drain (not just one run) and the CLI prints login-and-test instructions instead of a stack trace (`subprocess-executor.test.ts` + `event-loop.test.ts`), `.agent-work/` (per-run target-repo clones) is excluded from this project's `eslint`/`vitest` so a real run never pollutes the dev tooling, and the harness output parser **extracts a JSON envelope wrapped in a prose preamble/epilogue** (the near-universal LLM habit of writing a sentence before the JSON) via balanced-brace scanning — recovery, not coercion, since the strict envelope/verdict schema still validates the extracted object (`subprocess-executor.test.ts`). The `--model` flag lets the operator pick the produce/review model (e.g. `sonnet`) since the cheap default (haiku) is too weak to follow the JSON contract. And **`code_review` inspects the diff itself** (§3.6, revised): rather than injecting the computed diff into the prompt (a regenerated `package-lock.json` of ~6k lines blew the context window), the runner gives the reviewer the base branch and grants it read-only git tools (`Bash(git diff:*)`, …) so it diffs with `--stat` first and drills in — the harness manages its own context (`runner-lifecycle.test.ts`). Finally, **run branch names carry a random suffix** (`agent/run-<id>-<hex>`) so a fresh run never adopts a prior run's leftover remote branch + PR when ids are reused (a wiped db restarting at 1 had let a stale implementation land on a new run's branch — the `tdd` agent correctly caught it and escalated); commit messages, PR title, and a descriptive PR body were improved; and the CLI now prints the escalation reason + a resume hint on a `needs_human` finish instead of leaving it only in the DB (`runner-lifecycle.test.ts`). The subprocess executor also enforces a **per-invocation wall-clock timeout** (default 20 min, `--timeout <min>`): a real run had a single `tdd` invocation iterate on a slow browser test suite for 23 minutes unbounded, so on expiry the child is killed (SIGTERM→SIGKILL) and the phase escalates (recoverable) rather than running forever (`subprocess-executor.test.ts`). Agents are also told to keep the working tree clean — no committed test screenshots / lockfile churn — since the orchestrator commits it verbatim.

**Milestone 4b live e2e (opt-in, not blocking).** The token-spending, PR-creating end-to-end run is wired and runnable two ways — the CLI (real by default), and a flag-gated vitest (`real-e2e.test.ts`, `RUN_REAL_E2E=1`, skipped by default because it spends money and needs live `gh`/API auth), so it is not part of `npm test`. Real runs against live repos have since occurred (they surfaced the hardening captured in the M4b notes above), so this harness is an available opt-in check rather than remaining work. See [plans/milestone-4.md](plans/milestone-4.md) §6.

**Added in Milestone 5 — API + telemetry surface** (design in [plans/milestone-5.md](plans/milestone-5.md)): the headless control plane's public surface, so the M6 dashboard can be a pure client of it. 299 tests passing (+27 over M4).

- **Service layer — `Orchestrator`** (`src/api/orchestrator.ts`): the transport-free seam that owns the run-control commands (start / pause / resume / stop / revert), the read queries (list / fetch-detail runs, get/update FSM config), and the in-process **drain pump** that advances runs after a command without blocking the HTTP response (a real stage takes minutes). Every method takes/returns domain objects and throws a status-carrying `ApiError`, so the whole control surface is unit-tested against the stub executor + fake GitHub — the HTTP layer is a thin shell on top.
- **Event Loop control methods** (`src/loop/event-loop.ts`): `pauseRun`, `resumePausedRun`, `stopRun`, `revertRun` join `startRun` / `resumeRun` / `resumeAwaitingInput`. A `pause`/`stop` that lands **while a stage is running** is honored at commit time (the in-flight stage finishes — pause halts *dispatch*, never the agent — then the run parks instead of being forced back to `running`). `revertRun` records a reset transition to an earlier state and **discards any stale follow-up event** (`repo.discardPendingEvents`) so the revert is driven by exactly one fresh advance event; it **refuses (`409`) while a stage is mid-flight** (`repo.hasProcessingEvent`) so it can never race the committing stage (still correct under the Milestone 8 worker pool — a run with a stage in flight has a `processing` event).
- **New terminal `stopped` run status** (README §3.3 Layer 6 — `stop` ends a run, not resumable; state and artifacts stay for inspection). The dispatch gate already excludes it (only `running` runs are claimed).
- **Live stream** — a typed `StreamEvent = transition | activity | status` over an in-process **`Broadcaster`** (`src/api/stream.ts`). The loop's `onTransition` and the runner's `onActivity` (the seams M2/M4 exposed) plus the Orchestrator's status changes publish to it; `transition`/`status` carry the full updated `Run` so token/cost totals ride along (the "token usage" stream item). Best-effort: a throwing subscriber never wedges the publisher.
- **HTTP + SSE server** (`src/api/server.ts`): Node's built-in `http` — no web framework (KISS). Routes as of M5: `POST /runs`, `GET /runs[?status]`, `GET /runs/:id` (run + transitions + agent runs + artifacts + logs), `POST /runs/:id/{pause,resume,stop,revert}`, `GET|PUT /config`, `GET /stream[?runId]`, `GET /health` — later milestones added more; the authoritative current list is the header comment of `src/api/server.ts`. The stream is **SSE** (server→client only, so simpler than WebSocket — no dependency, browser `EventSource` auto-reconnects; README §3.3 Layer 6 allows either). Errors map to `400`/`404`/`409`/`500` JSON.
- **`get`/`update` FSM config through the API.** `updateConfig` validates via the existing `parseConfigFile` (invalid → `400`, file never overwritten), writes the file (`saveConfig`), recomputes the version, and hot-swaps the loop + runner for **new** runs. It refuses (`409`) while any run is non-terminal, so an in-flight run is never re-pointed at changed rules (README §3.1) without the deferred per-run versioned config store (M6). Without a `--config` path the config is read-only (the bundled default is never overwritten).
- **`serve` daemon** (`src/serve.ts`, `npm start -- serve [--port 4319] [--config <path>] [--db <path>] [--mock …]`): builds the orchestrator (real by default; `--mock` opts into the no-cost stub/fake) + server, recovers crash-stranded events on startup, runs the Reply Poller **and the PR Feedback Poller** in the background, and shuts down cleanly on SIGINT/SIGTERM — force-closing long-lived SSE connections (`closeAllConnections`) so Ctrl-C doesn't hang. It **binds to loopback (`127.0.0.1`)** since the MVP API is unauthenticated and meant for a localhost dashboard (README §1 / Layer 7); remote access stays a deliberate post-MVP add-on. `buildRunner` is now shared (`src/build-runner.ts`) so the one-shot CLI and the daemon wire the runner identically.
- **Tests** (+27): `Broadcaster` fan-out/isolation; the `Orchestrator` command + pump + config flows (incl. a pause/stop that lands mid-stage, a revert that discards the stale event, the active-run config-edit guard, and invalid-config rejection); the HTTP server over a real ephemeral port via `fetch` (routing, status codes, and a live SSE read); the new loop control methods directly; and `repo.discardPendingEvents`.

**Added in Milestone 6 — local web dashboard** (design in [plans/milestone-6.md](plans/milestone-6.md)): a browser dashboard served by the daemon on localhost, a **pure client** of the Layer 6 API (README §3.1) — built with **Svelte 5 + Vite**. 323 tests passing (+15 over M5). Verified live in a browser (the built bundle and the HMR dev server: runs render, the FSM graph highlights the current state, controls + the FSM editor work, SSE is live with no console errors).

- **Stack: Svelte 5 + Vite, client-rendered SPA** (`dashboard/`, no SvelteKit — the daemon is the server). The README recommends React + React Flow; Svelte is the lightest framework choice (compiles to ~57 kB / 22 kB gzip, no virtual-DOM runtime) and its fine-grained reactivity over the SSE stream replaces brittle manual DOM re-rendering. *(M6 first shipped as a dependency-free vanilla SPA; rebuilt on Svelte on the operator's call as the dashboard gains interactivity — the one cost, a build step, is deliberate.)*
- **Static asset serving** (`src/api/static.ts`): the daemon serves the built bundle (`dashboard/dist/`, `DEFAULT_PUBLIC_DIR`) — `/` → `index.html` — with a content-type map and a **path-traversal guard** (`resolveStaticPath`, pure + unit-tested). API routes keep precedence; a `GET` matching no route falls through to static. `serve` binds to loopback (localhost-only) and warns if the dashboard isn't built.
- **Pure view-model logic** (`dashboard/src/lib/render.ts`, typed): the **FSM graph as inline SVG** (laid out from `forwardOrder`, back-edges as labeled arcs, current node highlighted — no graph library), the runs-table model, and per-stage **telemetry aggregation**. No DOM/Svelte, so it is unit-tested by `dashboard/src/lib/render.test.ts`, **run by the root vitest suite** — first-class in the toolchain (an upgrade on the vanilla cut, where the logic sat outside it).
- **The Svelte app** (`dashboard/src/`): a reactive `store.svelte.ts` (`$state`) fed by `EventSource('/stream')`, and `App` + `RunsList` / `RunDetail` / `FsmGraph` / `Editor` components — a **run view** (live graph + transition history), **telemetry**, a **live activity log**, **artifact** links, **control buttons** (start/pause/resume/stop/revert with an inline revert form), and an **FSM editor** (validated JSON over `GET`/`PUT /config`, surfacing `400`/`409`). Svelte auto-escapes interpolated text; the only hand-built markup is the (escaped) SVG.
- **Build & dev**: `npm run build:dashboard` → `dashboard/dist/` (gitignored); the daemon serves it. `npm run dev:dashboard` runs Vite with **HMR**, proxying the API + SSE to a running daemon (`npm start -- serve`) for hot-reload development. `npm run check:dashboard` type-checks the Svelte app with `svelte-check`; `dashboard/` is outside the root `tsc`/`eslint` scope (its own toolchain). `.claude/launch.json` runs the daemon for the preview tool; pass `--config <path>` to `serve` to make the FSM editor writable (read-only otherwise, so the bundled default is never overwritten).

**Added in Milestone 7 — polish** (design in [plans/milestone-7.md](plans/milestone-7.md)): restart-correctness hardening, `needs_human` UX, and the operating guide (§9). 353 tests passing (+19 over M6).

- **Transactional outbox** (`src/agent/side-effects.ts` + the `side_effects` ledger, schema migration 2): the non-idempotent GitHub calls (issue/PR comments, sub-issue creation) are wrapped in a `SideEffectLedger` keyed `${state}#${visit}:${slot}`. A crash in the post-call / pre-commit window is replayed from the ledger — a completed call is reused (no duplicate comment or sub-issues), and a call left in-flight by a crash escalates `partial_side_effect` rather than retrying a non-idempotent operation. The visit index (transitions into the state) makes automatic recovery dedup within a visit while an operator resume — a fresh visit — deliberately retries clean. Proven by an extended crash-recovery test (a triage split replayed through the loop creates each sub-issue exactly once).
- **`needs_human` UX** (`escalationModel` in `dashboard/src/lib/render.ts` → the escalation inspector in `RunDetail.svelte`): a `needs_human` run shows *why* it escalated — the trigger, the stage it escalated from, the structured reason, and a one-line operator guidance per trigger (including the `partial_side_effect` GitHub-cleanup step) — alongside the existing Resume / Revert / Stop controls. Resume (from `needs_human`) and Revert both reset the round counters (a fresh budget), now asserted directly in the loop tests.

**On top of Milestone 7 — resolved-lane archive + UI/CLI polish** (**495 tests passing, 2 skipped** as this batch shipped — the figure includes Milestone 8 Phase A + B1/B2/B3 and PR feedback re-entry; see the note at the end of this section for the live count). Hardening and ergonomics that landed after the M7 core, not a new milestone:

- **Archive / unarchive** — a terminal run (`done` / `stopped`) can be archived out of the dashboard's **Resolved** lane to keep it uncluttered, and restored. Backed by `runs.archived_at` (schema migration 1), `Orchestrator.archive` (refuses `409` for a non-terminal run) / `unarchive` (an always-allowed no-op undo), `POST /runs/:id/archive` + `/unarchive`, and the render-layer rule that drops archived runs from the Resolved lane (`pipelineModel`).
- **New-run autocomplete** — `GET /suggestions[?q=]` backs the dashboard's *File a new run* bar with GitHub-issue search (the same adapter surface a future continuous mode reuses, Milestone 11).
- **Dashboard UI/UX + CLI ergonomics** — pipeline-lane layout, the live activity feed, and clearer CLI output (the `[real mode]` banner, the escalation-reason + resume hint on a `needs_human` finish) were refined across these commits. The `dev-preview` populated-mock daemon (`src/dev-preview.ts`, `npm run dev:preview`; launch configs in `.claude/launch.json`) drives the browser-preview tool against seeded data.

**Added in Milestone 8 — multi-repo + parallel execution** (design in [plans/milestone-8.md](plans/milestone-8.md)). **Complete:** Phase A (multi-repo, serial), Phase B B1 (the worker pool), B2 (concurrent crash-recovery, proven), and B3 (rate-limit handling + the optional global cost ceiling). The pure FSM engine and its tests are untouched, as the milestone requires.

- **Phase A — repo as a first-class dimension.** A `repos` registry (`repos` table, schema migration 3, on-disk retrofit verified) stores each enrolled repo's working root / clone source / base branch — secrets stay env-only (a `token_ref`, never the token). A **`RepoResolver`** (`src/integration/github-resolver.ts`) resolves the right `GitHub` adapter per `run.repoRef`, memoized: `EnrolledRepoResolver` (real, registry-backed, throws on an unenrolled repo) and `singleRepoResolver` (mock/tests, accepts any repo). The Agent Runner and Reply Poller consult the resolver per run (they accept `GitHub | RepoResolver`, so single-repo callers were untouched) — **the pre-M8 single-adapter binding is gone.** New routes: `GET|POST /repos` (list / enroll — enroll defaults the working root to `--work` and invalidates the resolver cache), and a `?repo=` filter on `GET /runs` and `GET /stream` (case-insensitive). The dashboard gains a repo-tab strip (`RepoTabs.svelte`, counts from the pure `repoOverviewModel`) that filters the board client-side; the trailing **+** enrolls a repo. The daemon boot-enrolls its `--repo` so existing runs resolve.
- **Phase B B1 — bounded worker pool + within-run serialization.** `claimNextEvent` gained a `NOT EXISTS (… events.status = 'processing')` guard, so a run with a stage in flight is skipped until it finalizes: the pool is **parallel across runs, serial within a run** (two stages of one run never share a working tree or state cursor). It is safe because a run's follow-up event is enqueued *inside* the stage's commit transaction, before the event is marked done. `EventLoop.drain(concurrency)` replaces the serial drain in the daemon pump — up to N overlapping `runStage` calls, resolving when the queue is idle and every worker has settled; a `FatalExecutorError` still aborts the whole pass after in-flight stages finish. Serial `runUntilIdle` is retained for the one-shot CLI and Reply Poller. The `Orchestrator` `concurrency` option defaults to **1** (so existing tests stay serial); the daemon resolves the global cap `--concurrency` → `FLEET_CONCURRENCY` → **4** (`build-runner.resolveConcurrency`). Because `better-sqlite3` is synchronous, the atomic claim already serialized concurrent claimers — the pool just calls it from N workers.
- **Phase B B2 — per-run worktrees / per-repo roots + concurrent crash recovery.** No new production code: per-repo working roots (each adapter is built from its `repos` row's `workingRoot`) and per-run working trees (`prepareWorkingTree` keys `<workingRoot>/run-<id>` on the *global* run id) already existed from Phase A + M3, and idempotency is run-scoped (event-keyed transitions; the outbox ledger is keyed `(run_id, key)` UNIQUE). B2 **proves** the design holds under the pool — the README-mandated Phase B test — by extending the M2 post-commit and M7 outbox crash-recovery tests to several runs across two repos recovered and drained concurrently.
- **Phase B B3 — rate-limit handling + optional global cost ceiling.** The Stage Executor now retries a **rate-limited / overloaded** invocation (a `RateLimitError` classified from either a non-zero exit or an `is_error` result) with capped exponential backoff + equal jitter (injectable `sleep`/`random`) — N parallel agents no longer escalate en masse on a shared limit; exhaustion escalates as a normal `HarnessError`, other failures fail on the first attempt, auth stays fatal (`--max-retries`, default 4). The **global cost ceiling** (loop-level, on top of the untouched per-run FSM budget) aggregates `cost_used` across active runs: at/over the ceiling `Orchestrator.start` refuses new runs (`429`) and the shared claim (`EventLoop.claimNext`) parks existing runs' next stages — a non-deadlocking human-in-the-loop gate. The operator overrides per run (`POST /runs/:id/cost-override`): `next_step` runs one more stage (consumed on use), `full` runs it to completion, `none` clears it. Config: `runs.cost_override` (migration 4), `--cost-ceiling` / `FLEET_COST_CEILING` (off by default). The dashboard shows a header spend/ceiling chip (red + "parked" over the ceiling) and per-run override buttons (`GET /cost` + the pure `costStatusModel`).
- **Tests:** repos CRUD + `listRuns({ repo })` + the migration-3 retrofit; resolver per-repo/memoize/throws; runner + poller hitting the correct per-repo adapter; the orchestrator enrollment check + repo-filtered runs/stream; an end-to-end multi-repo loop (`multi-repo.test.ts`); the claim's within-run/cross-run serialization; the pool's parallelism + global-cap + per-run-serial witness + fatal-rejects paths; a two-repo concurrent drain; `--concurrency` parsing + `resolveConcurrency` precedence; **concurrent crash recovery across repos** (`concurrent-recovery.test.ts` — no duplicate/lost events, no duplicate transitions, one PR per run on its own adapter with distinct per-run branches, split sub-issues/comments created exactly once); rate-limit classification + backoff + retry-then-succeed / exhaust-then-escalate / no-retry-on-other-failures; the cost-ceiling gate (park / `next_step` / `full` / under-ceiling), the `start` 429 + `overrideCost` command, and `resolveCostCeiling` precedence; and the pure `costStatusModel`.

**Added on top of Milestone 8 — PR feedback re-entry.** A finished run's PR keeps getting reviewed after
the pipeline stops, so review feedback now flows back into the pipeline. A **PR Feedback Poller**
(`src/loop/pr-feedback-poller.ts`, the sibling of the Reply Poller) scans each finished run (`done` or
`needs_human`) that has an **open** PR for a new reviewer comment whose body starts with a deterministic
marker (default **`feedback:`**, `--feedback-marker`). On a match it re-opens the run via a loop-owned
`EventLoop.reopenForPrFeedback` — a control transition (like `revert`/`resume`, so **the FSM engine is
untouched**) back to a configurable re-entry stage (default `plan`, `--feedback-reentry`), with counters
reset and a run flag (`addressing_pr_feedback`) set. That flag makes the Agent Runner inject the open PR
+ its comment thread into **every** stage's input (`pullRequest` / `prFeedback`), and the prompts tell
the agent to *iterate on the existing PR* — refining the plan/interface/code to address the feedback —
rather than rebuild it (so `tdd` adopts the existing PR via its find-or-create path; no duplicate PR).
A comment counts as unaddressed feedback when it was posted **after the run entered its finished state**
— the run's most recent transition (the one that moved it into `done`/`needs_human`) is the boundary, so
its timestamp is exactly "when the run finished." This is anchored in the transition log (like the Reply
Poller), needs no stored high-water mark, and is restart-safe: after a re-open the run's *new* finish
transition advances the boundary, so an addressed comment never re-triggers, and a comment left *before*
completion (a pipeline review comment) is ignored. Polling **stops** once the PR is merged or closed (the
run is flagged and skipped), and an **archived** run is never watched (archiving files a resolved run
away). The daemon runs it alongside the Reply Poller, on the same `--poll-interval` and `--poll-timeout 0`
disable switch.

The **Orchestrator owns the poller**, so the daemon's background tick (`pollPrFeedbackOnce`) and the
dashboard's on-demand check (`POST /runs/:id/check-pr-feedback` → `checkPrFeedback`) drive the same
instance. The **dashboard** surfaces it in the run detail: a finished run with an open PR shows a pulsing
"watching PR #N for feedback" chip plus a **Check now** button (pure `isWatchingPrFeedback`; the button
banners the outcome — re-opened / still watching / stopped). So the operator can see the watch is live
and force an immediate check instead of waiting for the next poll.

- **Tests:** `isFeedbackComment` marker matching and the pure `newFeedbackComments` boundary rule
  (only marker comments newer than the finished-at timestamp); the poller re-opening on a `feedback:`
  comment left after completion, ignoring one left before completion and benign chatter, not re-detecting
  it once the run is re-opened, stopping on merge **and** close, re-opening a `needs_human` run, excluding
  an archived run, per-run adapter isolation (multi-repo), and transient-error isolation; the loop's
  `reopenForPrFeedback` (done/needs_human re-entry, reset + flag + one advance event, configured re-entry
  stage, and the not-finished / missing-reason / terminal-target rejections); the runner injecting
  `pullRequest`/`prFeedback` only when the flag is set; and the fake's `getPr`/`listPrComments`/
  `seedPrComment`/`seedPr`. The **on-demand check** adds: the poller's `checkRun` outcomes
  (watching → reopened → not_watching → stopped), the `Orchestrator.checkPrFeedback` command
  (reopen / watching / stopped / not_watching + a 404), the `POST /runs/:id/check-pr-feedback` route,
  and the pure `isWatchingPrFeedback` badge helper.

**Added on top of Milestone 8 — multi-harness support (Claude Code + Cursor)** (design + per-PR log in
[plans/harness-abstraction.md](plans/harness-abstraction.md); operating guide §9.8). Each run is pinned
to an **agent harness** at start (`runs.harness`, default `claude-code`), resolved per stage through a
`HarnessRegistry` at the Layer 5 seam: the subprocess executor is parameterized by a **`HarnessProfile`**
(argv construction, prompt delivery, stream parsing, model tags, failure classification), so **Cursor**
(`cursor-agent` CLI) is a profile + registration, not a second executor — and a third harness would be
the same. The daemon default lives in a settings KV (`GET /settings`, `PUT /settings/default-harness`),
overridable per run on `POST /runs` (an unknown harness id is a 400, never coerced; an unregistered
harness escalates *that run* as `executor_error`, never the fleet). Whether an **auth failure** is
fleet-fatal is the profile's call (`HarnessProfile.authFatal`): Claude Code stays fatal — the default
harness being logged out means nothing can flow — while an unauthenticated Cursor escalates only its own
runs, each carrying the login remedy. The dashboard's new-run box gains a harness selector with a per-run
badge, alongside the per-run **model override** dropdown (`runs.model_override`, catalog via
`GET /models`) that lets a running run switch models between stages. Cursor cost estimation and
per-stage harness overrides are explicitly deferred (plan §9).

**Added in Milestone 9 — multi-issue async + dependency ordering** (design in
[plans/milestone-9.md](plans/milestone-9.md); operating guide §9.9). Several issues run at once with
ordering **enforced at pickup time**, exactly as §3.3 promised. The pure **Scheduler**
(`src/loop/scheduler.ts`: satisfaction, Tarjan cycle detection, the total-order comparator) and the
**§3.5 marker codec** (`src/integration/issue-markers.ts`: strict field-by-field parse, byte-stable
idempotent upsert) are the new table-tested cores. The **claim is the gate**: `claimNextEvent` gained a
dependency predicate over cached columns (migration 8: `runs.depends_on/priority/order_key/`
`deps_satisfied_at`) plus the Scheduler's `ORDER BY` (`priority` desc → `order_key` asc → issue number
asc — a cross-check test pins the SQL to `compareRuns`), so correctness is airtight under the M8 pool
whether or not the poller has ticked. **Declarations flow**: triage's optional `scheduling` output is
spliced into the issue's marker block by the runner (partial declarations overlay; a human's block is
carried through body rewrites, never stripped) and cached on the run *at triage-commit*, so `plan` can
never outrun an unmerged dependency. The **Scheduler Poller** (per-repo — issue numbers collide across
repos) refreshes declarations each tick (the issue wins), verifies satisfaction (**issue-closed** is
the signal — `Closes #N` auto-close makes merged ⇒ closed), stamps a **latch** (cleared automatically
when a human edits the dep set), flips the visible `running ↔ blocked` status, **drops the working
tree at wake** (the §3.1 fresh-base discipline, riding the proven lost-tree re-clone path), and
escalates **dependency cycles** to `needs_human` with the cycle in the reason. Plus: one active run
per issue (409), `POST /scheduler/check`, the best-effort **`af:<state>` PR label mirror**
(`Issue.state`/`dropWorkingTree`/`setPrLabels` adapter additions), and dashboard blocked/priority
badges + a RunDetail scheduling line. The FSM engine and its tests are untouched — ordering lives
entirely beside it.

**Added on top — merge-conflict handling** (`repos.conflict_policy`, schema migration 12). Between-stage
base sync keeps a run's branch current; a per-repo `conflict_policy` (`manual` default / `auto`) decides
what happens on conflict, and `auto` runs a mechanically-verified **resolver agent** as a pseudo-stage
(`resolve_conflicts`). A poller re-opens a finished (`done`) run whose PR has gone **CONFLICTING** so the
conflict is addressed rather than silently blocking the merge. The working tree is never left mid-merge.

**Added on top — Milestone 12: per-repo source binding** (`repos.source_mode`, schema migration 11). A
repo must declare a **source mode before it can run** — `clone` (fetch from the GitHub remote) or `local`
(build each run's working tree from a validated local git checkout, offline, still pushing to GitHub) —
resolved per run through the repo registry (`src/integration/local-checkout.ts`, dir validation via
`src/api/dir-suggest.ts`). This removes the last implicit single-repo assumption in working-tree setup and
fixes the daemon-cwd triage bug + sync-on-merge for local sources.

**Added on top — per-run operator↔agent chat side channel** (`run_chat` table, schema migration 13;
`POST /runs/:id/chat`, `GET /runs/:id/chat`, `POST /runs/:id/chat/:chatId/cancel`; `RunChat.svelte` dock).
A per-run side channel between the operator and the run's agent. **Read** prompts run immediately;
**write** prompts hold until the pipeline pauses — enforced by SQL mutual exclusion with stage dispatch (a
queued write ⇄ the event claim, so chat and a stage never touch the working tree at once). Replies stream
to the dashboard as `chat` stream events.

### Remaining planned work (tracked as GitHub issues)

Everything below is not-yet-built planned work, one [GitHub issue](https://github.com/jzohdi/agents-fsm/issues) each:

- **Milestone 10 — Claude Agent SDK stage executor** (the only whole milestone not started) — [#9](https://github.com/jzohdi/agents-fsm/issues/9).
- **Continuous mode: configurable in-flight cap > 1** (parallel pickup; today hardcoded to 1) — [#10](https://github.com/jzohdi/agents-fsm/issues/10).
- **Continuous mode: label/milestone backlog filter** — [#11](https://github.com/jzohdi/agents-fsm/issues/11).
- **Per-stage harness override** — [#12](https://github.com/jzohdi/agents-fsm/issues/12).
- **Per-harness model catalogs for off-default runs** — [#13](https://github.com/jzohdi/agents-fsm/issues/13).
- **Cursor `.cursor/rules` system-prompt path** (conditional) — [#14](https://github.com/jzohdi/agents-fsm/issues/14).
- **Opt-in auto-merge of approved PRs** — [#15](https://github.com/jzohdi/agents-fsm/issues/15).
- **Remote / phone access** (API auth + networking + hardening) — [#16](https://github.com/jzohdi/agents-fsm/issues/16).
- **Webhook-driven signals to replace polling** — [#17](https://github.com/jzohdi/agents-fsm/issues/17).
- **Per-repo FSM config and per-repo secrets** (multi-org) — [#18](https://github.com/jzohdi/agents-fsm/issues/18).
- **Time-based aging in the Scheduler order** (starvation mitigation) — [#19](https://github.com/jzohdi/agents-fsm/issues/19).
- **Cursor token/cost accounting** (Cursor records `0`) — [#2](https://github.com/jzohdi/agents-fsm/issues/2).
- **Layer 3 escalation-resolution advisor** (suggested-fix option cards) — [#4](https://github.com/jzohdi/agents-fsm/issues/4).
- **Configurable custom prompt context from the UI** — [#5](https://github.com/jzohdi/agents-fsm/issues/5).

> The per-milestone test counts above record each milestone as it shipped and are not updated after
> the fact. For the current figure run `npm test` (plus `npm run check:dashboard` for the dashboard
> render-model suite) — any skipped entries are the flag-gated real-integration tests. No live count
> is hand-maintained here; it drifted every time.

---

## 9. Operating the fleet

A practical guide: from zero to a running, recoverable fleet. The daemon is headless and binds to
loopback; the dashboard is a pure client of its API (§3.3 Layer 7).

### 9.1 Prerequisites
- **Node ≥ 20** and a working **`gh`** (GitHub CLI), authenticated (`gh auth login`) — the real
  Git/GitHub adapter shells out to it.
- **Secrets** live in the environment, never in SQLite. Copy `.env.example` → `.env` and fill in
  `GITHUB_TOKEN` (issues / PRs / branches / comments) and, for the default Claude Code harness,
  `ANTHROPIC_API_KEY` (see the harness bullet). Optionally set `FLEET_API_TOKEN` to require a bearer
  token on the daemon's API + SSE (§9.3 — env-only, never SQLite). `.env` is gitignored — never commit it.
- **A harness (the agent runner).** Runs execute on a selectable harness (§9.8); install + authenticate
  the one(s) you'll run — only those you actually use need credentials:
  - **Claude Code (default):** the `claude` CLI on `PATH`, authenticated via `claude login` or
    `ANTHROPIC_API_KEY`.
  - **Cursor (optional):** the `cursor-agent` CLI on `PATH`, authenticated via `cursor-agent login` or
    `CURSOR_API_KEY`. Not needed unless you select the Cursor harness.
- `npm install` once. The SQLite schema is created/migrated automatically on first open — no manual
  migration step, and an existing daemon DB upgrades in place on the next `serve`.

### 9.2 Run a single issue (one-shot CLI)
```
npm start -- <owner/repo#issue> --repo <owner/repo>
```
Runs **real by default** — it spends tokens and pushes to GitHub; the CLI prints a `[real mode] …`
banner. Add `--mock` for a zero-cost, zero-network run (stub executor + in-memory GitHub). Useful
flags: `--db <path>` (persist state, e.g. `./.agent-work/run.db`), `--config <path>` (custom FSM),
`--poll-timeout`/`--poll-interval` (the triage reply poller).

### 9.3 Run the daemon + dashboard
```
npm run build:dashboard                              # build the SPA the daemon serves
npm start -- serve --repo <owner/repo> --config ./fsm.json
# open http://127.0.0.1:4319
```
The daemon **persists to disk by default** (`<--work>/run.db`, i.e. `./.agent-work/run.db`), so it
survives restarts — on startup it recovers crash-stranded events and resumes queued work. Pass
`--db <path>` to choose the file, or `--db :memory:` for a throwaway (ephemeral) daemon; the startup
banner prints which one is in use. Start runs from the dashboard's **File a new run** bar (GitHub-backed
autocomplete) or by `POST /runs`. For dashboard development with hot reload, `npm run dev` (one-command
build-watch + in-process daemon) or `npm run dev:dashboard` (Vite HMR against a running daemon).

**Dashboard pages.** The dashboard is path-routed (the daemon serves the SPA shell for any
extension-less path, so deep links and reloads work): **`/` — the fleet overview (home)**: a masthead
headline + stat band (agents working, runs awaiting you, resolved, tokens, spend vs. the ceiling), a
**needs-attention queue** (escalations, questions, dependency-blocked runs — click through to the run),
the **repositories ledger** (per-repo run counts / tokens / spend / last activity; click a repo to open
its board; **+ Add repository** enrolls one), and a recent-activity feed. **`/pipelines`** — the run
board (repo tabs, file-a-run bar, pipeline lanes, run detail). **`/editor`** — the FSM config editor.

**Concurrency (Milestone 8 Phase B).** The daemon advances runs in parallel — **parallel across runs,
serial within a run** (two stages of one run never overlap; they share a working tree). The global cap
is `--concurrency <N>` or the `FLEET_CONCURRENCY` env var (default **4**); set it to `1` for fully
serial execution. Higher parallelism means proportionally higher token spend and API rate pressure —
the executor already retries rate-limited invocations with backoff (`--max-retries`, default 4).

**API authentication (issue #25, optional).** By default the HTTP + SSE API is **open** and reachable
only on loopback (`127.0.0.1`) — safe for a local dashboard, but nothing more. Set `FLEET_API_TOKEN`
(or `--api-token <token>`) to require a shared-secret bearer token on **every** route except `GET
/health` (liveness probes) and the static dashboard assets (which must load so the SPA can prompt for a
token). Clients send `Authorization: Bearer <token>`; the SSE `/stream` also accepts `?token=<token>`
because a browser `EventSource` can't set headers. A missing token is `401 authentication required`, a
wrong one `401 invalid token` (constant-time comparison). The token is read from the environment only —
**never** stored in SQLite (§9.1) — and absent/blank keeps auth off (behaviour byte-for-byte unchanged).
The daemon still binds loopback regardless; binding off-localhost is a separate networking/TLS issue
([#16](https://github.com/jzohdi/agents-fsm/issues/16)) that builds on this token layer. The dashboard
prompts for the token on a `401`, stores it in `localStorage`, and attaches it to every request and the
stream; **Forget token** clears it.

**Global cost ceiling (Milestone 8 B3, optional).** `--cost-ceiling <dollars>` or `FLEET_COST_CEILING`
(off by default) caps aggregate `cost_used` across active runs. At/over the ceiling the daemon refuses
new runs (a `429`) and parks each running run at its *next* stage — a currently-executing stage always
finishes. From a parked run in the dashboard the operator overrides per run: **Run next step** (one more
stage) or **Complete issue** (run it to completion); the header chip turns red and shows spend vs. the
ceiling. Runs finishing (or being stopped) frees headroom, and parked runs resume automatically. This is
on top of the per-run token/cost budget in the FSM config (§2), not a replacement.

> **Multiple repos (Milestone 8):** the daemon boot-enrolls its `--repo` as the first repository and
> accepts more at runtime — the dashboard's repo-tab **+** or `POST /repos` (working root defaults to
> `--work`). A run is admitted for any *enrolled* repo and serviced by that repo's own adapter; starting
> an issue in an unenrolled repo is refused with a clear "enroll it (`POST /repos`)" error. The new-run
> autocomplete searches *all* your GitHub issues, so it can surface issues from repos you haven't enrolled
> yet. Runs across repos advance in parallel — see the concurrency cap below.

### 9.4 Configure the FSM
The pipeline (states, transitions, back-edges, guard limits, budget) is one config object. Edit it
in the dashboard's **FSM editor** (validated `PUT /config`: invalid → `400`, the file is untouched)
or edit the `--config` file directly. Edits apply to **new** runs only and are refused (`409`) while
any run is in flight — pause/stop or let runs finish first. Without `--config`, the config is
read-only (the bundled default is never overwritten).

### 9.5 Resolve a `needs_human` run (inspect → fix → resume/revert)
When a run escalates, open it in the dashboard. The **escalation inspector** shows the trigger, the
stage it escalated from, a human-readable account of what happened (e.g. the self-review findings
that never converged, as a list; the raw payload stays behind a *raw payload* toggle), and guidance:
1. **Inspect** — read the account + findings. For `partial_side_effect`, check the issue/PR on
   GitHub and delete any partial comment or sub-issue first.
2. **Fix** — address the cause (credentials, a conflict, the issue text, the budget, …) — or, for
   agent-side causes, just write what should change in the **guidance box**.
3. **Act** — **Resume** re-runs the escalated-from stage with a fresh round budget, or **Revert
   `<state>`** (with a reason) sends the run back to an earlier stage. **Stop** ends it (terminal,
   inspectable). Both Resume and Revert reset the round counters.

Anything typed in the guidance box (and every revert reason / back-edge reason) is **delivered to
the re-run stage** as its `reentry` input — the escalation cause plus the operator's words — so the
stage addresses what went wrong instead of repeating its prior output (README §2's reversion-reason
rule, end to end). On the wire it is `POST /runs/:id/resume` with an optional `{ "notes": "…" }`
body, recorded on the resume transition as `{ kind: "operator_resume", notes }` (audit trail and
delivery are the same record).

### 9.6 Crash recovery
Just restart the daemon (`serve`). On startup it reclaims events stranded `processing` by the crash
and re-drains them; idempotent, event-keyed transitions and the transactional outbox (§8 / risk
register) ensure no duplicate transition, comment, or sub-issue. Nothing manual is required — except
the rare `partial_side_effect` escalation, handled per §9.5.

### 9.7 Iterate on a finished run via PR feedback
Once a run finishes (`done`, or parked in `needs_human`) its PR is still open for review. To feed a
reviewer comment back into the pipeline, **post a PR comment that starts with `feedback:`** — e.g.
`feedback: rename the endpoint and add a test for the empty case`. The daemon's PR Feedback Poller
(running on `--poll-interval`, alongside the triage reply poller) picks it up within a tick and
re-opens the run at `plan` (configurable via `--feedback-reentry`), carrying the open PR + the comment
thread into every stage so the agents refine the *existing* PR instead of rebuilding it. Comments that
don't start with the marker are ignored, so ordinary review chatter is safe. Watching stops
automatically once the PR is **merged or closed** (or if you **archive** the run). Tune the marker with
`--feedback-marker`; disable both pollers with `--poll-timeout 0`.

Don't want to wait for the next poll? Open the run in the dashboard: a watched run shows a **"watching
PR #N for feedback"** chip and a **Check now** button that polls that one PR immediately and tells you
what it found (re-opened / still watching / stopped).

### 9.8 Choose a harness (Claude Code or Cursor)
Each run executes on a **harness** — the headless agent CLI that owns the within-stage tool-use loop
(§3.3 Layer 5). Two ship today: **`claude-code`** (default) and **`cursor`**. A run is stamped with a
harness at start and keeps it across crash/resume — but the operator can **re-point a live run at
another harness** from the run header's **Harness** dropdown (or `POST /runs/:id/harness { "harness": ... }`).
The switch takes effect on the run's **next** stage: an in-flight stage finishes on the executor it
started with, so pause first if you want to hold the run before its next dispatch. Harnesses share the
working-tree/artifact contract, so the new one picks up the branch where the old one left it. Switching
clears the run's model/effort overrides (they name the old harness's catalog); the model picker then
offers the new harness's catalog (`GET /models?harness=<id>`). If you only ever use the default,
there's nothing to configure — this section is only needed to run Cursor or change defaults.

**The default harness** is resolved at boot with this precedence: the **`--harness <id>` flag** /
**`FLEET_HARNESS` env** (a session override — a bad value fails fast at startup, and it does *not*
overwrite your remembered choice) → the **persisted default** (set from the dashboard) → **`claude-code`**.

**Selecting a harness** (a run stamps whichever was chosen at click/submit time):
- **Dashboard (recommended).** The **Harness** dropdown in the *File a new run* bar is a unified
  control: changing it **persists** the fleet default *and* is the harness the next run starts with. A
  run whose harness isn't the current default shows a small badge on its card.
- **Daemon:** `npm start -- serve --harness cursor …` (or `FLEET_HARNESS=cursor npm start -- serve …`).
- **One-shot CLI:** `npm start -- <owner/repo#issue> --repo <owner/repo> --harness cursor`.
- **API:** `POST /runs { "issueRef": "...", "harness": "cursor", "model": "gpt-5", "effort": "high" }` (all
  optional; omit `harness` → the default, omit `model`/`effort` → the persisted sticky default or the model
  default; an unknown value → `400`). `GET /settings` returns the current default harness + selectable ids
  + the persisted `defaultModel`/`defaultEffort`; `PUT /settings/default-harness { "harness": "cursor" }`
  changes the harness, `PUT /settings/default-model { "model": ..., "effort": ... }` the sticky pick. Live
  per-run overrides: `POST /runs/:id/model`, `POST /runs/:id/effort` (`null` clears), and
  `POST /runs/:id/harness` (re-points the run; clears its model/effort overrides).

**Selecting a model + effort.** The *File a new run* bar has a searchable **model picker** next to the
harness control — pick one to start the run on a specific model (validated against the chosen harness's
catalog), or leave it on the harness default. When the picked model supports **reasoning effort** (Claude
Code's `--effort`), an effort selector appears alongside it (`low`/`medium`/`high`/`xhigh`/`max`). The same
picker + effort selector in the run inspector change a live run's model/effort for its **next** stage.

Your harness, model, and effort selection is **sticky**: it persists as the default for later runs and
across restarts (`PUT /settings/default-model`; `GET /settings` returns it), until you pick again. Changing
the harness clears the model/effort default (they belong to that harness's catalog). `GET /models` returns
the active harness's catalog, each model carrying its supported effort levels.

**Reasoning effort by harness — two different mechanisms.** Claude Code takes a **separate `--effort` flag**
(`low`/`medium`/`high`/`xhigh`/`max`; Sonnet 5 / Opus 4.7–4.8 / Fable 5 take all five, Haiku none) —
unsupported levels degrade gracefully, so the model picker pairs it with an effort selector. **Cursor bakes
the effort into the model id** (`gpt-5.5-high`, `gpt-5.5-extra-high`, `claude-opus-4-8-xhigh`) and it's
*required* for most models — so the effort ladder shows as distinct entries in the picker (no separate
selector), and picking `GPT-5.5 · High` runs `--model gpt-5.5-high`. Cursor's naming is non-uniform
(`extra-high` vs `xhigh`; some models omit the suffix for their default), which is why the catalog lists
concrete ids rather than synthesizing them.

**Before running Cursor:**
1. Install the `cursor-agent` CLI and authenticate it (`cursor-agent login` or `CURSOR_API_KEY`) — see §9.1.
2. **The model ids come from `cursor-agent --list-models`** — the authoritative set the CLI accepts (each is
   passed verbatim to `--model`). The picker's catalog is curated in `src/agent/cursor-models.json` from that
   list; `CURSOR_MODEL_MAP`'s frontier/cheap targets (`src/agent/cursor-profile.ts`) must stay in it.

   **Refreshing the list:** `npm run models:refresh` runs `cursor-agent --list-models`, reports which models
   are new/removed, and (with `-- --write`) updates `cursor-models.json` — adding discovered ids and merging
   while preserving your curated labels/costs (`-fast` speed variants are skipped). Skim the added entries
   afterwards to curate labels/cost. Requires the CLI on PATH.

**Caveats (accepted for now):**
- **Cursor doesn't report token/cost usage**, so its runs record `0`. The global cost ceiling (§9.3) and
  the per-run token budget therefore don't gate Cursor runs, and the dashboard shows **"cost n/a"** (never
  a misleading "$0.00"). A cost estimator is deferred.
- **Cursor auth failures are non-fatal**: an unauthenticated `cursor-agent` escalates only *its own* runs
  to `needs_human` (with a login remedy in the reason) — Claude Code runs keep flowing. (A Claude auth
  failure still aborts the whole drain, as before.)
- The per-run **model picker** (in the run inspector) appears only for a run whose harness matches the
  loaded catalog (i.e. the current default's), so it never offers wrong-harness models; per-harness
  catalogs for off-default runs are deferred.

### 9.9 Order work with dependencies (multi-issue)

Run several issues at once and let the fleet enforce the order (Milestone 9, §3.5). Declarations live
in the **issue body** as one machine-readable block — written by `triage` (it may declare
`scheduling` in its output) or by hand:

```
<!-- agent-orchestrator:v1
depends_on: [42, 57]           # same-repo issue numbers that must be merged first
priority: 10                   # higher runs first
order_key: "2026Q3-auth-03"    # lexicographic tiebreaker
-->
```

Every field is optional; no block means "no dependencies, default priority." **The issue owns the
block**: edit it there any time — the daemon's Scheduler Poller (on `--poll-interval`) picks the edit
up within a tick, and a human edit always wins over what triage wrote.

**How a dependent run behaves.** `triage` runs immediately (it's the PM pass that writes the
declarations, and it touches no code); everything after it waits until every `depends_on` issue is
**closed**. The run parks as **`blocked`** — the dashboard card shows *"waiting on #42, #57"* — and
holds no executor, so the rest of the fleet flows around it. A dependency clears when its issue
closes: for fleet-managed work that happens automatically when a human **merges** its PR (the PR body
says `Closes #N`), so `done` alone (merge-ready, unmerged) deliberately does *not* release dependents
— no stacked PRs, ever. On wake the run's working tree is re-cloned so its branch starts from
**post-merge base**. *Caveat:* GitHub auto-closes only when the PR merges into the repo's **default**
branch; on a non-default `base_branch`, close the dependency issue by hand at merge.

**Ordering among runnable work:** `priority` (desc) → `order_key` (asc) → issue number (asc),
enforced at event pickup — deterministic, never preemptive (a higher-priority arrival waits for the
next free slot, it never interrupts a stage).

**Cycles** (A depends on B depends on A) escalate every member to `needs_human` with the cycle named
in the reason: fix the `depends_on` blocks on the issues, then **Resume** each member.

**Ops notes:** one issue = one active run (a second `start` on the same issue is a `409` until the
first finishes); `POST /scheduler/check` (or waiting a tick) re-evaluates immediately; each run's FSM
state is mirrored on its PR as an **`af:<state>` label** (best-effort, informational). Dependency
workflows need the **daemon** (§9.3) — the one-shot CLI exits with a dependent run still parked.

### 9.10 Watch a repo and let it work the backlog (continuous mode)

Instead of filing each run by hand, put a repo in **continuous mode** and the daemon picks up its open
issues on its own (Milestone 11). Enrolling a repo (§9.3) only makes it *serviceable*; watching it is a
separate opt-in — flip the **Watch** toggle on the repo's row in the dashboard's home ledger, or
`POST /repos/watch {"repoRef":"owner/name","watch":true}`. From then on the **Issue Intake Poller**
(on `--poll-interval`, the same `--poll-timeout 0` disables it) scans that repo's open issues each tick
and starts a run for the next eligible one.

**Sequential by default (in-flight cap 1):** a watched repo runs **one issue at a time**. The next
issue is admitted only when the current run's issue **closes** (a human merges its `Closes #N` PR — the
same no-stacked-PRs discipline as §3.5) or the run is **stopped**. A run parked at `needs_human` holds
the slot, so a broken issue pauses the queue rather than silently skipping ahead. Issues are picked up
**oldest first** (issue number ascending).

**Guards — an open issue is untrusted input.** To keep a stranger's issue from becoming an injection
or cost vector, the poller only auto-picks an issue that is (1) **filed by the repo owner**, (2)
**unassigned**, and (3) **not marked `[WIP]`** in its title or body. Any issue the owner explicitly
opts in — by adding the **`agent help wanted`** label (configurable per repo via the `label` field of
`POST /repos/watch`) — bypasses all three. A skipped issue is logged once (`[issue-intake] skipping
…`) with the reason, so you can see *why* something wasn't picked up. Everything else flows through the
same `POST /runs` admission as a manual run — the one-active-run-per-issue guard, the global cost
ceiling, and enrollment all still apply — so continuous mode is admission control, not a bypass. It
**never auto-merges**: a human still reviews and merges every PR. Needs the **daemon** (§9.3).


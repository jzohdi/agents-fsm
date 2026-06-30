# Milestone 5 — API + telemetry surface (design + plan)

> Status: **done** (299 tests passing; live `serve` daemon smoke-tested — HTTP commands + SSE).
> Delivers the headless control plane's public surface: an HTTP command API (start / stop / pause /
> resume / revert / list+fetch runs / get+update FSM config) and a live stream (SSE) of transitions,
> agent activity, and status changes. This document records the M5 decisions; the README is the
> source of truth for the overall architecture (README §3.3 Layer 6).

## 1. Goal and scope

README §5 Milestone 5:
- **HTTP commands:** start, stop, pause, resume, revert, list/fetch runs, get/update FSM config.
- **WebSocket/SSE live stream** of transitions, agent activity, token usage, and logs.

This is the boundary the M6 dashboard becomes a pure client of ("engine independent of UI",
README §3.1). No orchestration logic lives in the transport; the HTTP/SSE layer is a thin adapter
over a testable service layer.

### In scope
- A **service layer** (`Orchestrator`) that owns the run-control commands, the in-process drain
  **pump**, and the get/update-config flow — fully testable without sockets.
- New **Event Loop control methods**: `pauseRun`, `resumePausedRun`, `stopRun`, `revertRun`
  (joining the existing `startRun` / `resumeRun` / `resumeAwaitingInput`).
- A new terminal **`stopped`** run status (README §3.3 Layer 6: `stop` ends a run, not resumable).
- A **Broadcaster** (in-process pub/sub) carrying a typed `StreamEvent` union; the loop's
  `onTransition` and the runner's `onActivity` (the seams called out in M2/M4) feed it.
- An **HTTP + SSE server** (Node's built-in `http`; no framework dependency — KISS) mapping routes
  to `Orchestrator` calls and serving the stream.
- A `serve` CLI entry that builds the orchestrator + server (stub/fake by default; `--real` opt-in).

### Out of scope (deferred, with the milestone that owns it)
- The web dashboard UI and the FSM editor screen → **M6**.
- A **versioned config store** that loads each run's *pinned* config so edits never touch in-flight
  runs. M5 instead guards `updateConfig` to refuse while any run is non-terminal (so we never edit
  rules out from under a running run without that store). The store is the M6 hardening (README §8
  notes the existing `config_version_mismatch` fail-safe and that the store "lands with the FSM
  editor in Milestone 5/6").
- Auth / remote access / multi-user (README §1 out of scope for the MVP).
- WebSockets: the stream is server→client only (transitions/activity/status), so **SSE** is the
  simpler fit — no extra dependency, browser `EventSource` auto-reconnects. README §3.3 Layer 6
  explicitly allows "WebSocket (or SSE)".

## 2. Key design decisions

### 2.1 Transport is thin; the service layer is the unit under test
`Orchestrator` exposes synchronous-ish command methods returning domain objects (`Run`,
`Transition`, `LoadedConfig`). The HTTP server only parses requests, calls one method, and
serializes the result (or maps a thrown `ApiError` to a status code). So the commands are tested
directly against an in-memory DB + stub executor + fake GitHub, and the HTTP layer is a thin shell.

### 2.2 The drain pump (how the daemon advances runs)
The MVP loop is serial and `runUntilIdle`-driven. A daemon must drain whenever a command enqueues
an event without blocking the HTTP response (a real stage takes minutes). The Orchestrator owns a
single-flight **pump**: a command enqueues its event then calls `kick()`, which starts a background
drain if none is running and otherwise sets a re-run flag so an in-flight drain picks up the newly
enqueued event. `settle()` awaits the current drain (the seam tests use instead of sleeping).

### 2.3 Pause / stop are meaningful mid-stage
Execution is serial but a stage `await`s the harness, so a command can land while a stage runs. The
dispatch gate (`claimNextEvent` only claims events of a `running` run) already stops the *next*
dispatch. To also honor a pause/stop that arrives *during* a stage, `applyEvent` re-reads the run's
status right before committing: if it was flipped to `paused`/`stopped`, the committed transition
keeps that status instead of forcing `running`. A `paused` run keeps its pending follow-up event (so
`resume` dispatches it); a `stopped` run enqueues none (it is terminal). The current stage always
finishes — pause "halts dispatch", it does not interrupt the in-flight agent (README §3.3 Layer 6).

### 2.3a Revert refuses an in-flight stage (no serial-loop race)
`revert` changes a run's state *and* enqueues a fresh advance event. If a stage is mid-flight for
that run (its event is `processing`), that stage will commit its own transition when it finishes and
clobber the revert — an orphan transition, an erroneous counter reset, and a silently-ignored
revert. So `revertRun` refuses when `repo.hasProcessingEvent(run)` (→ `409`); the operator waits for
the stage to finish (pausing stops the *next* dispatch, so the run then parks) and reverts the
parked run. `pause` / `stop` / `resume` are race-free without this: they only set status (honored at
the in-flight stage's commit) or act on already-parked runs, never changing state + enqueuing.

### 2.4 One stream, a typed event union
`StreamEvent = transition | activity | status`. `transition` and `status` carry the full updated
`Run`, so the dashboard gets token/cost totals for free (the "token usage" stream item). `activity`
is the live "what is the agent doing now" feed already persisted to `logs` (README §3.3 Layer 1);
streaming it is the in-process push the M2/M4 seams were built for. Operator-initiated transitions
(`revert`, `resume`-from-`needs_human`) emit through the loop's existing `onTransition`; pure
status changes (`pause`, `stop`, `resume`-from-`paused`) are published by the Orchestrator.

### 2.5 get/update FSM config
`getConfig` returns the live `{ fsm, agents, version }`. `updateConfig` validates the posted object
through the existing `parseConfigFile` (invalid → `400` with the aggregated problems — never write a
bad config), writes the file, recomputes the version, and hot-swaps the loop + runner config for
**new** runs. To keep "edits never change the rules for an in-flight run" (README §3.1) without the
deferred versioned store, it refuses (`409`) while any run is non-terminal. Single-user MVP: you
edit the FSM when idle.

## 3. Surface (HTTP)

| Method | Path | Body | Result |
|--------|------|------|--------|
| POST | `/runs` | `{ issueRef, repoRef? }` | `201` the created `Run` |
| GET | `/runs` | `?status=` | `200` `Run[]` |
| GET | `/runs/:id` | — | `200` `{ run, transitions, agentRuns, artifacts, logs }` |
| POST | `/runs/:id/pause` | — | `200` `Run` |
| POST | `/runs/:id/resume` | — | `200` `Run` (paused→running or needs_human→resumed) |
| POST | `/runs/:id/stop` | — | `200` `Run` |
| POST | `/runs/:id/revert` | `{ toState, reason }` | `200` `Run` |
| GET | `/config` | — | `200` `{ fsm, agents, version }` |
| PUT | `/config` | full config object | `200` `{ version }` / `400` problems / `409` busy |
| GET | `/stream` | `?runId=` | SSE: `transition` / `activity` / `status` events |
| GET | `/health` | — | `200` `{ ok: true }` |

Errors are JSON `{ error }`: `400` bad input / invalid config, `404` no such run, `409` illegal
state for the command (e.g. resume a `done` run), `500` otherwise.

## 4. File layout
- `src/api/stream.ts` — `Broadcaster` + `StreamEvent`.
- `src/api/orchestrator.ts` — `Orchestrator` (commands, pump, config), `ApiError`.
- `src/api/server.ts` — `createApiServer(orchestrator)` → `http.Server` (routing + SSE).
- `src/build-runner.ts` — shared runner/adapter builder (extracted from `cli.ts`).
- `src/loop/event-loop.ts` — the new control methods.
- `serve` CLI subcommand + `--port`.

## 5. Definition of done
- Every command + the stream tested against the stub executor + fake GitHub (no network/cost).
- `npm run typecheck`, `npm run lint`, `npm test` green; real-cost paths stay flag-gated.
</content>
</invoke>

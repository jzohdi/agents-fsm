# Milestone 6 — Local web dashboard (design + plan)

> Status: **done** (323 tests passing; built with Vite and verified live in a browser — runs render,
> the FSM graph highlights the current state, controls + the FSM editor work, SSE live, no console
> errors; the HMR dev server + API/SSE proxy verified too). A browser dashboard served by the daemon
> on localhost, a **pure client** of the M5 Layer 6 API (README §3.3 Layer 7). It adds no
> orchestration logic — only views and the control buttons that call the existing endpoints.
>
> **Stack note (revised after the first cut):** M6 first shipped as a dependency-free vanilla SPA.
> On the operator's call it was rebuilt with **Svelte 5 + Vite** (a client-rendered SPA) — the right
> trade as the dashboard gains interactivity: fine-grained reactivity over the SSE stream replaces
> brittle manual `innerHTML` re-rendering (which clobbered transient UI state like a half-typed revert
> reason or scroll position on every event). Svelte compiles to a tiny bundle (~57 kB / 22 kB gzip),
> so it stays the most lightweight framework choice. The one real cost — a build step — is deliberate.

## 1. Goal and scope (README §5 Milestone 6 / Layer 7)
- **Run view** — the live FSM graph with the current node highlighted + the transition history.
- **Telemetry** — token usage, cost, and durations per stage; round counts.
- **Logs** — the live structured activity stream.
- **Artifacts** — links to the plan / interface spec / PR / review comments for the run.
- **Controls** — start / stop / pause / resume / revert buttons.
- **FSM editor** — view and edit states, transitions, back-edges, and guard limits.

## 2. Key decision: Svelte 5 + Vite, client-rendered SPA
The README *recommends* React + React Flow but calls it a recommendation. We use **Svelte 5 + Vite**
(no SvelteKit — we don't need routing/SSR; the daemon *is* the server, and the dashboard is a thin
client per README §3.1). Rationale:

- **Reactivity earns its keep.** The dashboard is driven by a live SSE stream (runs, status, agent
  activity). Svelte's `$state`/`$derived` give fine-grained updates that preserve transient DOM state
  — unlike the manual full-panel re-render the vanilla cut used.
- **Svelte is the lightest framework.** It compiles away to small vanilla JS (no virtual-DOM
  runtime), so it fits this project's minimalism better than React.
- **Backend untouched.** The static-serving seam (`createApiServer(orch, { publicDir })`) already
  serves whatever directory we point it at — so this was a pure frontend-layer swap; we just point
  the default at the Vite build output. A sign the Layer 6/7 boundary was drawn well.
- **The FSM editor is a validated JSON editor.** "Edit states/transitions/back-edges/guards" is met
  by editing the config object with server-side validation feedback (`PUT /config` → `400`/`409`).
  A graphical node editor is post-MVP polish.

### Testability
- **Pure view-model logic** lives in `dashboard/src/lib/render.ts` (no DOM/Svelte): the FSM-graph
  SVG, the runs-table model, telemetry aggregation, formatting. It is unit-tested by
  `dashboard/src/lib/render.test.ts`, **discovered and run by the root vitest suite** (a plain
  `.test.ts`, Node-runnable). This is an upgrade on the vanilla cut, where the logic sat outside the
  toolchain as `public/render.js`.
- **Type-checking:** `svelte-check` covers the dashboard (components + TS) via `dashboard/tsconfig.json`
  (`npm run check:dashboard`); the root `tsc` stays `src/`-only.
- **Reactive glue** (`store.svelte.ts`, components) is browser-only; Svelte auto-escapes interpolated
  text, so the only hand-built markup is the SVG (escaped in the tested `render.ts`).
- **Static serving** is covered by the server's `fetch` tests (against a fixture dir, build-independent)
  plus pure unit tests for the path-traversal guard (`resolveStaticPath`) and content types.
- `dashboard/` is outside the root `tsc` `include` and eslint-ignored (a separate front-end with its
  own toolchain), so the Node toolchain is unaffected.

## 3. Build & serve
- `npm run build:dashboard` → `vite build dashboard` → `dashboard/dist/` (gitignored).
- The daemon serves `dashboard/dist/` (`DEFAULT_PUBLIC_DIR`); `serve` warns if it isn't built yet
  (the API works regardless). `serve` binds to loopback, so the dashboard is localhost-only.
- **HMR dev:** `npm run dev:dashboard` → `vite dashboard` (port 5173) with HMR, proxying
  `/runs`, `/config`, `/health`, `/stream` to a running daemon (`AF_DAEMON`, default
  `http://127.0.0.1:4319`). Develop against `:5173` with hot-reload while real data comes from the
  orchestrator.

## 4. File layout
- `src/api/static.ts` — `resolveStaticPath` (safe path) + `contentTypeFor` + `serveStatic` (tested).
- `dashboard/` — the Svelte + Vite app: `vite.config.ts`, `svelte.config.js`, `tsconfig.json`,
  `index.html`, `src/main.ts`, `src/app.css`, `src/App.svelte`, and `src/lib/` (`render.ts` +
  `render.test.ts`, `types.ts`, `api.ts`, `store.svelte.ts`, and the
  `RunsList` / `RunDetail` / `FsmGraph` / `Editor` components).
- `.claude/launch.json` runs the daemon (`serve`) for the preview tool.

## 5. Definition of done
- The daemon serves the built dashboard at `http://127.0.0.1:<port>/`; it lists runs, shows the live
  graph, history, telemetry, logs, and artifacts, drives the control buttons, and edits the FSM config.
- Pure render logic + the static path guard are unit-tested (root suite); `svelte-check` is clean; the
  server serves assets (fixture-based test).
- `npm run typecheck`, `npm run lint`, `npm test` stay green; the dashboard builds with `vite`.
</content>

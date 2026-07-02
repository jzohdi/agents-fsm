/**
 * Dashboard state + actions (Svelte 5 runes). A single reactive `ui` object holds everything the
 * views render; the actions fetch from / command the Layer 6 API and mutate `ui`, and Svelte's
 * fine-grained reactivity repaints. The live SSE stream keeps `ui.runs` and the selected run's
 * detail/logs current. This replaces the manual `innerHTML` re-rendering of the vanilla dashboard —
 * which is why transient UI state (a half-typed revert reason, scroll position) now survives updates.
 */

import { request } from './api';
import { routeFromPath, routePath, type Route } from './render';
import type { LoadedConfig, LogLine, ModelCatalog, Repo, Run, RunDetail, Settings, Suggestion } from './types';

export const ui = $state({
  runs: [] as Run[], // newest first
  selectedId: null as number | null,
  detail: null as RunDetail | null,
  config: null as LoadedConfig | null,
  conn: 'connecting' as 'on' | 'off' | 'connecting',
  logs: [] as LogLine[], // the selected run's activity feed (persisted logs + live stream)
  // Path-based route (home `/`, pipelines `/pipelines`, editor `/editor`) — kept in sync with the
  // address bar by `navigate` (pushState) and `initRouter`'s popstate listener, so deep links,
  // reloads, and back/forward all work (the daemon serves index.html for extension-less paths).
  route: 'home' as Route,
  // Enrolled repositories (`GET /repos`) — the home page's ledger merges these with run aggregates.
  repos: [] as Repo[],
  banner: null as { msg: string; kind: 'ok' | 'err' } | null,
  // `showArchived` is a client-side view preference; whether a run *is* archived lives on the server
  // (Run.archivedAt), set via the archive/unarchive endpoints below.
  showArchived: false,
  // Multi-repo (Milestone 8 Phase A): the active board filter (null = all repos). The board filters
  // client-side from `ui.runs`, so the SSE stream stays global (no reconnect on tab change). The tabs
  // themselves derive from the runs on screen, so no separate repo list is fetched.
  repoFilter: null as string | null,
  // Global cost ceiling (Milestone 8 B3): the daemon's configured ceiling (null = off), fetched once.
  // Active spend is derived live from `ui.runs` in `costStatusModel`, so only this constant is fetched.
  costCeiling: null as number | null,
  // The active harness's model catalog + default (the new-run bar's model picker), fetched once at startup.
  models: null as ModelCatalog | null,
  // The *selected run's* harness catalog (RunDetail's model picker), fetched per run via
  // GET /models?harness=<run.harness>. Unlike `ui.models` (the default harness's) it follows the run's
  // own — possibly newly-switched — harness, so the RunDetail model dropdown renders for any harness.
  runModels: null as ModelCatalog | null,
  // The operator's sticky pre-run selection shown in the new-run bar (null = the harness/model default).
  // Persisted server-side (PUT /settings/default-model) so it survives reloads and "sticks" as the default
  // for later runs; loaded from GET /settings; cleared when the harness changes (its catalog no longer fits).
  selectedModel: null as string | null,
  selectedEffort: null as string | null,
  // The daemon's default harness + the selectable set (the harness selector). `defaultHarness` is both
  // the runtime selector value AND the persisted default (the unified control): changing it persists via
  // PUT /settings/default-harness and is the harness sent on the next run. `null` until settings load / on
  // an older daemon without the route (the selector then hides).
  defaultHarness: null as string | null,
  harnesses: [] as string[],
});

/** Adopt the current pathname and follow browser back/forward. Call once at mount. */
export function initRouter(): void {
  ui.route = routeFromPath(location.pathname);
  window.addEventListener('popstate', () => {
    ui.route = routeFromPath(location.pathname);
  });
}

/** Switch routes, pushing a history entry so back/forward and deep links work. */
export function navigate(route: Route): void {
  if (ui.route === route) return;
  ui.route = route;
  history.pushState(null, '', routePath(route));
}

/** Jump from the home ledger into a repo's board: scope the pipeline filter, then go there. */
export function openRepoBoard(repoRef: string | null): void {
  ui.repoFilter = repoRef;
  navigate('pipelines');
}

/** Open one run on the board (from the home page's attention queue / activity feed). */
export async function openRun(id: number): Promise<void> {
  const run = ui.runs.find((r) => r.id === id);
  ui.repoFilter = run ? run.repoRef : null;
  navigate('pipelines');
  await selectRun(id);
}

/** Runs scoped to the active repo tab (all repos when no filter). */
export function filteredRuns(): Run[] {
  return ui.repoFilter === null ? ui.runs : ui.runs.filter((r) => r.repoRef === ui.repoFilter);
}

export function setRepoFilter(repoRef: string | null): void {
  ui.repoFilter = repoRef;
}

/** Fetch the enrolled repos (`GET /repos`); tolerant of an older daemon without the route. */
export async function loadRepos(): Promise<void> {
  try {
    ui.repos = await request<Repo[]>('GET', '/repos');
  } catch {
    ui.repos = []; // the home ledger then derives repos from runs alone
  }
}

/** Enroll a repo (`POST /repos`) so runs can be started for it. Returns whether it succeeded. */
export async function enrollRepo(repoRef: string, baseBranch?: string): Promise<boolean> {
  try {
    const body = baseBranch?.trim() ? { repoRef, baseBranch: baseBranch.trim() } : { repoRef };
    const repo = await request<Repo>('POST', '/repos', body);
    banner(`Enrolled ${repo.repoRef}.`, 'ok');
    await loadRepos(); // keep the home ledger current
    return true;
  } catch (err) {
    banner(`Enroll failed: ${(err as Error).message}`, 'err');
    return false;
  }
}

/**
 * Turn continuous mode on/off for an enrolled repo (`POST /repos/watch`, Milestone 11). When on, the
 * daemon auto-picks the repo's eligible open issues. Refreshes the ledger so the toggle reflects state.
 */
export async function setRepoWatch(repoRef: string, watch: boolean): Promise<void> {
  try {
    await request<Repo>('POST', '/repos/watch', { repoRef, watch });
    banner(watch ? `Watching ${repoRef} for new issues.` : `Stopped watching ${repoRef}.`, 'ok');
    await loadRepos();
  } catch (err) {
    banner(`Could not update watch: ${(err as Error).message}`, 'err');
  }
}

/** Archive a resolved (done/stopped) run server-side so it drops out of the Resolved lane. */
export async function archiveRun(id: number): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/archive`));
  } catch (err) {
    banner(`Archive failed: ${(err as Error).message}`, 'err');
  }
}
export async function unarchiveRun(id: number): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/unarchive`));
  } catch (err) {
    banner(`Restore failed: ${(err as Error).message}`, 'err');
  }
}
export function toggleShowArchived(): void {
  ui.showArchived = !ui.showArchived;
}

/**
 * Autocomplete suggestions for the new-run bar. The daemon's `GET /suggestions?q=` returns the logged-in
 * user's own repos + their open issues (real mode) or its seeded issues (stub). If that request fails
 * (e.g. an older daemon without the route, or `gh` unauthenticated) we fall back to the issue refs of
 * runs already on screen so type-ahead still does something useful.
 */
export async function fetchSuggestions(query: string): Promise<Suggestion[]> {
  try {
    return await request<Suggestion[]>('GET', `/suggestions?q=${encodeURIComponent(query)}`);
  } catch {
    return localSuggestions(query);
  }
}

function localSuggestions(query: string): Suggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const r of ui.runs) {
    if (seen.has(r.issueRef)) continue;
    seen.add(r.issueRef);
    if (!q || r.issueRef.toLowerCase().includes(q)) {
      const num = Number(r.issueRef.split('#')[1] ?? 0);
      out.push({ kind: 'issue', ref: r.issueRef, repo: r.repoRef, number: num, title: r.issueRef });
    }
  }
  return out;
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;
export function banner(msg: string, kind: 'ok' | 'err'): void {
  ui.banner = { msg, kind };
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { ui.banner = null; }, kind === 'err' ? 8000 : 3500);
}

function upsertRun(run: Run): void {
  const i = ui.runs.findIndex((r) => r.id === run.id);
  if (i >= 0) ui.runs[i] = run;
  else ui.runs.push(run);
  ui.runs.sort((a, b) => b.id - a.id);
}

function toLogLine(level: string, message: string, data: unknown): LogLine {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
  const line: LogLine = { level, message };
  if (typeof d?.stage === 'string') line.stage = d.stage;
  if (typeof d?.kind === 'string') line.kind = d.kind;
  return line;
}

export async function loadConfig(): Promise<void> {
  ui.config = await request<LoadedConfig>('GET', '/config');
}

export async function loadRuns(): Promise<void> {
  ui.runs = (await request<Run[]>('GET', '/runs')).sort((a, b) => b.id - a.id);
}

/** Fetch the daemon's global cost ceiling once (Milestone 8 B3); tolerant of an older daemon (no route). */
export async function loadCost(): Promise<void> {
  try {
    ui.costCeiling = (await request<{ ceiling: number | null }>('GET', '/cost')).ceiling;
  } catch {
    ui.costCeiling = null; // older daemon without /cost — treat as no ceiling
  }
}

/** Fetch the harness model catalog once (the model dropdown); tolerant of an older daemon (no route). */
export async function loadModels(): Promise<void> {
  try {
    ui.models = await request<ModelCatalog>('GET', '/models');
  } catch {
    ui.models = null; // older daemon without /models — the dropdown just won't render
  }
}

/**
 * Fetch the model catalog for a specific harness (the selected run's), into `ui.runModels`; tolerant of
 * an older daemon (no `?harness=` support) or an unknown harness → null, like `loadModels`. This is what
 * lets the RunDetail model dropdown follow the run's own harness rather than the default one.
 */
export async function loadRunModels(harness: string): Promise<void> {
  try {
    ui.runModels = await request<ModelCatalog>('GET', `/models?harness=${encodeURIComponent(harness)}`);
  } catch {
    ui.runModels = null; // older daemon / unknown harness — the RunDetail dropdown just won't render
  }
}

/** Fetch the harness settings once (the harness selector + the sticky pre-run pick); tolerant of an older
 *  daemon (no route / no defaultModel field). */
export async function loadSettings(): Promise<void> {
  try {
    const s = await request<Settings>('GET', '/settings');
    ui.defaultHarness = s.defaultHarness;
    ui.harnesses = s.harnesses;
    ui.selectedModel = s.defaultModel ?? null; // pre-fill the bar from the persisted selection
    ui.selectedEffort = s.defaultEffort ?? null;
  } catch {
    ui.defaultHarness = null; // older daemon without /settings — the selector hides
    ui.harnesses = [];
  }
}

/**
 * Change the default harness (`PUT /settings/default-harness`). This is the unified control: it persists
 * the new default *and* is the harness the next run is started with. Optimistic — reflect it immediately,
 * then reload the model catalog (which is the new default harness's) and roll back on failure.
 */
export async function setDefaultHarness(harness: string): Promise<void> {
  const previous = ui.defaultHarness;
  ui.defaultHarness = harness; // optimistic
  // The new harness has its own catalog — a stale model/effort pick would no longer be valid (the daemon
  // clears the persisted pair too on a harness change).
  ui.selectedModel = null;
  ui.selectedEffort = null;
  try {
    const { defaultHarness } = await request<Settings>('PUT', '/settings/default-harness', { harness });
    ui.defaultHarness = defaultHarness;
    await loadModels(); // the model picker's catalog follows the default harness
  } catch (err) {
    ui.defaultHarness = previous; // roll back a rejected change
    banner(`Harness change failed: ${(err as Error).message}`, 'err');
  }
}

/** The models of the currently-loaded (default-harness) catalog, or `[]` if none loaded. */
function currentModels(): { id: string; efforts?: string[] }[] {
  return ui.models?.models ?? [];
}

/**
 * Pick the pre-run model in the new-run bar and **persist it as the sticky default** (`PUT
 * /settings/default-model`), so it stays selected for later runs and across reloads. Picking a model that
 * doesn't support the current effort drops the effort. Optimistic; rolls back on failure.
 */
export async function selectDefaultModel(model: string | null): Promise<void> {
  const prev = { model: ui.selectedModel, effort: ui.selectedEffort };
  const efforts = currentModels().find((m) => m.id === model)?.efforts ?? [];
  ui.selectedModel = model;
  if (ui.selectedEffort && !efforts.includes(ui.selectedEffort)) ui.selectedEffort = null; // effort no longer fits
  await persistDefaultSelection(prev);
}

/** Pick the pre-run reasoning effort in the new-run bar and persist it (paired with the current model). */
export async function selectDefaultEffort(effort: string | null): Promise<void> {
  const prev = { model: ui.selectedModel, effort: ui.selectedEffort };
  ui.selectedEffort = effort;
  await persistDefaultSelection(prev);
}

async function persistDefaultSelection(prev: { model: string | null; effort: string | null }): Promise<void> {
  try {
    const saved = await request<{ defaultModel: string | null; defaultEffort: string | null }>(
      'PUT',
      '/settings/default-model',
      { model: ui.selectedModel, effort: ui.selectedEffort },
    );
    ui.selectedModel = saved.defaultModel; // reflect any server-side normalization (e.g. a dropped effort)
    ui.selectedEffort = saved.defaultEffort;
  } catch (err) {
    ui.selectedModel = prev.model; // roll back a rejected change
    ui.selectedEffort = prev.effort;
    banner(`Model change failed: ${(err as Error).message}`, 'err');
  }
}

/**
 * Set (or clear, with `null`) the selected run's harness model. Takes effect on the run's next stage
 * (the current stage keeps its model). Optimistically reflected via the returned run + a status event.
 */
export async function setModel(id: number, model: string | null): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/model`, { model }));
    if (id === ui.selectedId) await refreshDetail();
  } catch (err) {
    banner(`Model change failed: ${(err as Error).message}`, 'err');
  }
}

/** Set (or clear, with `null`) the selected run's reasoning effort. Takes effect on the run's next stage. */
export async function setEffort(id: number, effort: string | null): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/effort`, { effort }));
    if (id === ui.selectedId) await refreshDetail();
  } catch (err) {
    banner(`Effort change failed: ${(err as Error).message}`, 'err');
  }
}

/**
 * Change the selected run's harness (the RunDetail harness selector). Takes effect on the run's next stage
 * (the current stage keeps its harness). The daemon clears the run's model/effort overrides on this change
 * — their catalog no longer fits — so the refreshed run row reflects that. Reloads the per-run catalog for
 * the new harness so the model dropdown follows it.
 */
export async function setHarness(id: number, harness: string): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/harness`, { harness }));
    await loadRunModels(harness); // the RunDetail catalog follows the newly-chosen harness
    if (id === ui.selectedId) await refreshDetail();
  } catch (err) {
    banner(`Harness change failed: ${(err as Error).message}`, 'err');
  }
}

/**
 * Override the cost ceiling for a run (Milestone 8 B3): `next_step` runs one more stage, `full` runs it
 * to completion, `none` clears the override. The daemon kicks the pump, so an over-ceiling run resumes.
 */
export async function overrideCost(id: number, mode: 'next_step' | 'full' | 'none'): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/cost-override`, { mode }));
    if (id === ui.selectedId) await refreshDetail();
  } catch (err) {
    banner(`Override failed: ${(err as Error).message}`, 'err');
  }
}

export async function startRun(issueRef: string): Promise<void> {
  // Stamp the run with the currently-selected harness + the sticky pre-run model/effort. Each is omitted
  // when unset (older daemon / settings not loaded / no pick) so the server applies its own default. The
  // selection is NOT reset after — it persists as the default for later runs (item: sticky defaults).
  const body: { issueRef: string; harness?: string; model?: string; effort?: string } = { issueRef };
  if (ui.defaultHarness) body.harness = ui.defaultHarness;
  if (ui.selectedModel) body.model = ui.selectedModel;
  if (ui.selectedEffort) body.effort = ui.selectedEffort;
  const run = await request<Run>('POST', '/runs', body);
  upsertRun(run);
  await selectRun(run.id);
  banner(`Started run ${run.id}.`, 'ok');
}

export async function selectRun(id: number): Promise<void> {
  ui.selectedId = id;
  ui.logs = [];
  await refreshDetail();
}

export async function refreshDetail(): Promise<void> {
  if (ui.selectedId === null) return;
  const id = ui.selectedId;
  const detail = await request<RunDetail>('GET', `/runs/${id}`);
  if (ui.selectedId !== detail.run.id) return; // selection changed while fetching
  upsertRun(detail.run);
  ui.detail = detail;
  ui.logs = detail.logs.map((l) => toLogLine(l.level, l.message, l.data));
}

/** Run-control command. `notes` (resume of a needs_human run only): operator guidance the daemon
 *  records on the resume transition and delivers to the retried stage as its re-entry context. */
export async function control(action: 'pause' | 'resume' | 'stop', notes?: string): Promise<void> {
  if (ui.selectedId === null) return;
  try {
    await request('POST', `/runs/${ui.selectedId}/${action}`, notes?.trim() ? { notes: notes.trim() } : undefined);
    await refreshDetail();
  } catch (err) {
    banner(`${action} failed: ${(err as Error).message}`, 'err');
  }
}

export async function revertRun(toState: string, reason: string): Promise<void> {
  if (ui.selectedId === null) return;
  if (!reason.trim()) {
    banner('Revert needs a reason.', 'err');
    return;
  }
  try {
    await request('POST', `/runs/${ui.selectedId}/revert`, { toState, reason });
    await refreshDetail();
  } catch (err) {
    banner(`revert failed: ${(err as Error).message}`, 'err');
  }
}

/**
 * Ask the daemon to check a finished run's open PR for feedback **now** (the "Check now" button),
 * instead of waiting for the next background poll. Banners the outcome and refreshes the run so a
 * re-open (or a stopped-watching flag change) shows immediately.
 */
export async function checkPrFeedback(id: number): Promise<void> {
  try {
    const { run, result } = await request<{ run: Run; result: 'reopened' | 'watching' | 'stopped' | 'not_watching' }>(
      'POST',
      `/runs/${id}/check-pr-feedback`,
    );
    upsertRun(run);
    if (id === ui.selectedId) await refreshDetail();
    const pr = run.prNumber != null ? `PR #${run.prNumber}` : 'the PR';
    const msg =
      result === 'reopened'
        ? `New feedback found — re-opened run ${id} to address it.`
        : result === 'stopped'
          ? `${pr} is merged or closed — stopped watching.`
          : result === 'watching'
            ? `No new feedback yet — still watching ${pr}.`
            : `Run ${id} isn't being watched for PR feedback.`;
    banner(msg, result === 'not_watching' ? 'err' : 'ok');
  } catch (err) {
    banner(`Check failed: ${(err as Error).message}`, 'err');
  }
}

export async function saveConfig(raw: unknown): Promise<{ ok: boolean; msg: string }> {
  try {
    const { version } = await request<{ version: string }>('PUT', '/config', raw);
    await loadConfig();
    return { ok: true, msg: `Saved — config ${version}` };
  } catch (err) {
    return { ok: false, msg: (err as Error).message };
  }
}

export function connectStream(): void {
  const es = new EventSource('/stream');
  es.onopen = () => { ui.conn = 'on'; };
  es.onerror = () => { ui.conn = 'off'; }; // EventSource auto-reconnects

  const onRunEvent = (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { runId: number; run?: Run };
    if (data.run) upsertRun(data.run);
    if (data.runId === ui.selectedId) void refreshDetail();
  };
  es.addEventListener('transition', onRunEvent);
  es.addEventListener('status', onRunEvent);
  es.addEventListener('activity', (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { activity: { runId: number; stage: string; activity: { summary: string; kind?: string } } };
    if (data.activity.runId === ui.selectedId) {
      ui.logs.push(toLogLine('info', data.activity.activity.summary, { stage: data.activity.stage, kind: data.activity.activity.kind }));
    }
  });
}

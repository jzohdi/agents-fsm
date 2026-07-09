/**
 * Dashboard state + actions (Svelte 5 runes). A single reactive `ui` object holds everything the
 * views render; the actions fetch from / command the Layer 6 API and mutate `ui`, and Svelte's
 * fine-grained reactivity repaints. The live SSE stream keeps `ui.runs` and the selected run's
 * detail/logs current. This replaces the manual `innerHTML` re-rendering of the vanilla dashboard —
 * which is why transient UI state (a half-typed revert reason, scroll position) now survives updates.
 */

import { request, AuthError } from './api';
import { clearToken, setToken, withToken } from './auth';
import { routeFromPath, routePath, type Route } from './render';
import type { Advice, ChatExchange, ChatMode, LoadedConfig, LogLine, ModelCatalog, Repo, Run, RunDetail, Settings, Suggestion } from './types';

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
  // Per-harness catalog cache (`GET /models?harness=`), keyed by harness id — the per-run picker reads
  // the catalog of the harness the *run* is on, which need not be the daemon default's (`ui.models`).
  catalogs: {} as Record<string, ModelCatalog>,
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
  // Operator-provided context (issue #5), three layers. Layers 1–2 are daemon settings (persisted in
  // `settings`), hydrated from GET /settings and edited via the actions below; Layer 3 (per-run) lives on
  // each Run's `issueContext`. Empty layers contribute nothing; the runner composes them before invoking.
  contextGlobal: null as string | null,
  contextStages: {} as Record<string, string>,
  // Run chat (the per-run operator ↔ agent side channel). The thread itself lives on `detail.chat`;
  // these are the dock's view state: open/closed, the sticky permission mode, and how many replies
  // landed while the dock was closed (the launcher badge). Unread resets on open and on run switch.
  chatOpen: false,
  chatMode: 'read' as ChatMode,
  chatUnread: 0,
  // A send in flight (disables the composer so one prompt can't be posted twice).
  chatSending: false,
  // The escalation-resolution advisor (Layer 3): true while a "Suggest resolutions" request is in
  // flight, so the button shows a loading state and can't be double-clicked. The result itself lands
  // on `detail.advice`.
  advising: false,
  // Token auth (issue #25): true ⇒ the daemon returned a 401, so show the token prompt overlay. The
  // static SPA is served open, so this renders even though every data load failed. Auth-off daemons
  // never set it (no 401 is ever returned), so the prompt stays hidden by default.
  authRequired: false,
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
 * Bind an enrolled repo's working directory (`POST /repos/source`, Milestone 12): `clone` clones a fresh
 * per-run tree from GitHub; `local` uses an absolute path on the daemon's machine via git worktree, after
 * the daemon validates it's a checkout of this repo (a wrong directory surfaces as the banner error).
 * Returns whether it succeeded; refreshes the ledger so the new label/state shows.
 */
export async function configureRepoSource(repoRef: string, mode: 'clone' | 'local', localRepo?: string): Promise<boolean> {
  try {
    const body = mode === 'local' ? { repoRef, mode, localRepo } : { repoRef, mode };
    await request<Repo>('POST', '/repos/source', body);
    banner(mode === 'local' ? `Using local directory for ${repoRef}.` : `${repoRef} will clone on each run.`, 'ok');
    await loadRepos();
    return true;
  } catch (err) {
    banner(`Could not set working directory: ${(err as Error).message}`, 'err');
    return false;
  }
}

/**
 * Directory-path completions for the local-checkout picker (`GET /fs/dirs`, Milestone 12). The browser
 * can't read absolute paths out of a native folder dialog, so the daemon (running on the operator's
 * machine) supplies shell-style tab-completions the input renders as a click-to-drill dropdown.
 * Best-effort: any failure (older daemon, unreadable path) is just "no suggestions".
 */
export async function fetchDirSuggestions(q: string): Promise<string[]> {
  try {
    return (await request<{ dirs: string[] }>('GET', `/fs/dirs?q=${encodeURIComponent(q)}`)).dirs;
  } catch {
    return [];
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

/**
 * Set an enrolled repo's merge-conflict policy (`POST /repos/conflict-policy`): `manual` parks a
 * conflicted run for the operator; `auto` lets a verified resolver agent handle it. Refreshes the
 * ledger so the control reflects state.
 */
export async function setRepoConflictPolicy(repoRef: string, policy: 'manual' | 'auto'): Promise<void> {
  try {
    await request<Repo>('POST', '/repos/conflict-policy', { repoRef, policy });
    banner(
      policy === 'auto'
        ? `${repoRef}: merge conflicts will be auto-resolved by an agent.`
        : `${repoRef}: merge conflicts will wait for you to resolve.`,
      'ok',
    );
    await loadRepos();
  } catch (err) {
    banner(`Could not update conflict policy: ${(err as Error).message}`, 'err');
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

/** Fetch the harness settings once (the harness selector + the sticky pre-run pick); tolerant of an older
 *  daemon (no route / no defaultModel field). */
export async function loadSettings(): Promise<void> {
  try {
    const s = await request<Settings>('GET', '/settings');
    ui.defaultHarness = s.defaultHarness;
    ui.harnesses = s.harnesses;
    ui.selectedModel = s.defaultModel ?? null; // pre-fill the bar from the persisted selection
    ui.selectedEffort = s.defaultEffort ?? null;
    ui.contextGlobal = s.contextGlobal ?? null; // operator context layers 1–2 (issue #5)
    ui.contextStages = s.contextStages ?? {};
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
 * Set (or clear, with `null`) the global base operator context (Layer 1, issue #5) via
 * `PUT /settings/context/global`. Optimistic — reflect it immediately, then adopt the server value;
 * roll back and banner on failure. Passing an empty string clears the layer (the daemon normalizes blank → unset).
 */
export async function setGlobalContext(text: string | null): Promise<void> {
  const previous = ui.contextGlobal;
  ui.contextGlobal = text; // optimistic
  try {
    const { contextGlobal } = await request<{ contextGlobal: string | null }>('PUT', '/settings/context/global', { context: text });
    ui.contextGlobal = contextGlobal;
  } catch (err) {
    ui.contextGlobal = previous; // roll back a rejected change
    banner(`Context change failed: ${(err as Error).message}`, 'err');
  }
}

/**
 * Set (or clear, with `null`) the per-stage operator context for one stage (Layer 2, issue #5) via
 * `PUT /settings/context/stage`. Optimistic; adopts the server's full stage map on success, rolls back on failure.
 */
export async function setStageContext(stage: string, text: string | null): Promise<void> {
  const previous = ui.contextStages;
  ui.contextStages = text ? { ...previous, [stage]: text } : omitKey(previous, stage); // optimistic
  try {
    const { contextStages } = await request<{ stage: string; contextStages: Record<string, string> }>(
      'PUT',
      '/settings/context/stage',
      { stage, context: text },
    );
    ui.contextStages = contextStages;
  } catch (err) {
    ui.contextStages = previous; // roll back a rejected change
    banner(`Context change failed: ${(err as Error).message}`, 'err');
  }
}

function omitKey(map: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _drop, ...rest } = map;
  return rest;
}

/**
 * Set (or clear, with `null`) the selected run's per-run operator context (Layer 3, issue #5) via
 * `POST /runs/:id/context`. Reflects the returned run (which carries the normalized `issueContext`).
 * Takes effect on the run's next stage; banners on failure.
 */
export async function setRunContext(id: number, text: string | null): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/context`, { context: text }));
    if (id === ui.selectedId) await refreshDetail();
  } catch (err) {
    banner(`Context change failed: ${(err as Error).message}`, 'err');
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
 * Re-point a run at another harness (the per-run harness selector). Takes effect on the run's next
 * stage; the daemon clears the model/effort overrides (they belong to the old harness's catalog).
 * The RunDetail catalog follows automatically: its `$effect` on the refreshed run's harness pulls the
 * new harness's catalog through the per-harness cache (`loadCatalog`).
 */
export async function setHarness(id: number, harness: string): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/harness`, { harness }));
    if (id === ui.selectedId) await refreshDetail();
    banner(`Run ${id} switches to ${harness} from its next stage.`, 'ok');
  } catch (err) {
    banner(`Harness change failed: ${(err as Error).message}`, 'err');
  }
}

/**
 * The model catalog for one harness (`GET /models?harness=`), cached per harness id — the per-run
 * picker calls this for the harness the selected run is on. An older daemon that ignores the query
 * param returns the *default* harness's catalog; the harness-field check refuses to cache that
 * mismatch, so such a run simply shows no picker rather than another harness's models.
 */
export async function loadCatalog(harness: string): Promise<void> {
  if (ui.catalogs[harness]) return;
  try {
    const catalog = await request<ModelCatalog>('GET', `/models?harness=${encodeURIComponent(harness)}`);
    if (catalog.harness === harness) ui.catalogs[harness] = catalog;
  } catch {
    // No catalog for this harness (or the request failed) — the picker stays hidden for its runs.
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
  const switched = ui.selectedId !== id;
  ui.selectedId = id;
  ui.logs = [];
  if (switched) ui.chatUnread = 0; // the badge counts the *selected* run's replies only
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
 *  records on the resume transition and delivers to the retried stage as its re-entry context.
 *  `extraRounds` (resume of an `internal_review_cap` escalation only): bump the review cap for that
 *  visit only, for when the loop was converging and just needs more budget. */
export async function control(
  action: 'pause' | 'resume' | 'stop',
  notes?: string,
  extraRounds?: number,
): Promise<void> {
  if (ui.selectedId === null) return;
  const body: { notes?: string; extraRounds?: number } = {};
  if (notes?.trim()) body.notes = notes.trim();
  if (extraRounds !== undefined) body.extraRounds = extraRounds;
  try {
    await request('POST', `/runs/${ui.selectedId}/${action}`, Object.keys(body).length ? body : undefined);
    await refreshDetail();
  } catch (err) {
    banner(`${action} failed: ${(err as Error).message}`, 'err');
  }
}

/**
 * On-demand escalation-resolution advisor (the "Suggest resolutions" button, Layer 3). Runs the
 * read-only advisor over the selected `needs_human` run (`POST /runs/:id/advise`), then upserts the
 * returned advice into the cached detail so the option cards render immediately and survive a reload
 * (the daemon also returns it in `getRunDetail`).
 */
export async function requestAdvice(): Promise<void> {
  if (ui.selectedId === null) return;
  const id = ui.selectedId;
  ui.advising = true;
  try {
    const advice = await request<Advice>('POST', `/runs/${id}/advise`);
    if (ui.detail && ui.detail.run.id === id) ui.detail.advice = advice;
  } catch (err) {
    banner(`Suggest resolutions failed: ${(err as Error).message}`, 'err');
  } finally {
    ui.advising = false;
  }
}

/**
 * Escape hatch: ask the daemon to run the dedicated conflict resolver on a finished run whose PR
 * conflicts with base (`POST /runs/:id/resolve-conflicts`). Works regardless of the repo's conflict
 * policy — clicking is the authorization. Refreshes the run so it shows entering `resolve_conflicts`.
 */
export async function resolveConflicts(id: number): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/resolve-conflicts`));
    if (id === ui.selectedId) await refreshDetail();
    banner(`Resolving merge conflicts for run ${id}…`, 'ok');
  } catch (err) {
    banner(`Could not start conflict resolution: ${(err as Error).message}`, 'err');
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

/**
 * Ask the daemon to check an `awaiting_input` run's issue thread for a human reply **now** (the "Check
 * now" button on a run waiting for your answer), instead of waiting for the next background poll.
 * Banners the outcome and refreshes the run so a resume shows immediately.
 */
export async function checkReply(id: number): Promise<void> {
  try {
    const { run, result } = await request<{ run: Run; result: 'resumed' | 'no_reply' | 'not_awaiting' }>(
      'POST',
      `/runs/${id}/check-reply`,
    );
    upsertRun(run);
    if (id === ui.selectedId) await refreshDetail();
    const msg =
      result === 'resumed'
        ? `Reply found — resuming run ${id}.`
        : result === 'no_reply'
          ? `No reply yet — reply on the issue and I’ll pick it back up.`
          : `Run ${id} isn’t waiting for a reply.`;
    banner(msg, result === 'not_awaiting' ? 'err' : 'ok');
  } catch (err) {
    banner(`Check failed: ${(err as Error).message}`, 'err');
  }
}

// --- run chat (the per-run operator ↔ agent side channel) -----------------------

export function toggleChat(open?: boolean): void {
  ui.chatOpen = open ?? !ui.chatOpen;
  if (ui.chatOpen) ui.chatUnread = 0;
}

export function setChatMode(mode: ChatMode): void {
  ui.chatMode = mode;
}

/**
 * Send a chat prompt to the selected run (`POST /runs/:id/chat`). `read` prompts dispatch
 * immediately (even mid-stage); `write` prompts hold until the pipeline pauses, then edit + commit +
 * push. Returns whether the send was accepted, so the composer knows to clear itself. The reply
 * arrives via the stream's `chat` event (which refreshes the thread).
 */
export async function sendChat(prompt: string, mode: ChatMode): Promise<boolean> {
  if (ui.selectedId === null || !prompt.trim() || ui.chatSending) return false;
  ui.chatSending = true;
  try {
    await request<ChatExchange>('POST', `/runs/${ui.selectedId}/chat`, { prompt: prompt.trim(), mode });
    await refreshDetail(); // show the new exchange (queued or already running) without waiting on SSE
    return true;
  } catch (err) {
    banner(`Chat failed: ${(err as Error).message}`, 'err');
    return false;
  } finally {
    ui.chatSending = false;
  }
}

/** Withdraw a still-queued chat prompt (`POST /runs/:id/chat/:chatId/cancel`). */
export async function cancelChat(chatId: number): Promise<void> {
  if (ui.selectedId === null) return;
  try {
    await request<ChatExchange>('POST', `/runs/${ui.selectedId}/chat/${chatId}/cancel`);
    await refreshDetail();
  } catch (err) {
    banner(`Cancel failed: ${(err as Error).message}`, 'err');
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
  // `EventSource` can't set the Authorization header, so the token rides as `?token=` (issue #25).
  // Auth-off / no stored token ⇒ `withToken` returns '/stream' unchanged (byte-for-byte the old URL).
  // Note: `EventSource` can't read the HTTP status, so an SSE 401 only surfaces as `onerror`
  // (→ `ui.conn = 'off'`); the fetch mount-loads surface the 401 first and drive the token prompt.
  const es = new EventSource(withToken('/stream'));
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
  // Run-chat lifecycle (queued → running → done/error/cancelled): refresh the selected run's thread
  // and, when a reply lands while the dock is closed, bump the launcher's unread badge.
  es.addEventListener('chat', (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { runId: number; exchange: ChatExchange };
    if (data.runId !== ui.selectedId) return;
    if (!ui.chatOpen && (data.exchange.status === 'done' || data.exchange.status === 'error')) ui.chatUnread += 1;
    void refreshDetail();
  });
}

// --- token auth (issue #25) -----------------------------------------------------

/**
 * Run the startup mount-loads and open the live stream. The single place that routes a `401`
 * (`AuthError`) into `ui.authRequired` so the token prompt appears; any other failure banners as a
 * generic load error. Called on mount and after a successful (re-)authentication. An auth-off daemon
 * never returns a 401, so `ui.authRequired` stays false and this behaves exactly as before.
 */
export async function bootstrap(): Promise<void> {
  try {
    await loadConfig(); // first, and it *throws* on 401 (the tolerant loads below swallow errors)
    await loadRuns();
    await loadRepos();
    await loadCost();
    await loadModels();
    await loadSettings();
    ui.authRequired = false;
    // Open a sensible run by default so the detail view isn't empty on load: prefer a running one.
    if (ui.selectedId === null && ui.runs.length) {
      const first = ui.runs.find((r) => r.status === 'running') ?? ui.runs[0]!;
      await selectRun(first.id);
    }
  } catch (err) {
    if (err instanceof AuthError) {
      ui.authRequired = true; // show the token prompt; the SPA is served open so this still renders
      return; // don't open the stream — it would only 401 too (surfacing as a bare reconnect)
    }
    banner(`Failed to load: ${(err as Error).message}`, 'err');
  }
  connectStream();
}

/**
 * Store a token and re-drive the whole startup (`bootstrap`), reconnecting the stream with it. A fresh
 * `401` re-raises the prompt (handled inside `bootstrap`). The token prompt overlay calls this.
 */
export async function authenticate(token: string): Promise<void> {
  setToken(token);
  await bootstrap();
}

/** Forget the stored token and re-raise the prompt (the sign-out path). */
export function signOut(): void {
  clearToken();
  ui.authRequired = true;
}

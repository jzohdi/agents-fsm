/**
 * Dashboard state + actions (Svelte 5 runes). A single reactive `ui` object holds everything the
 * views render; the actions fetch from / command the Layer 6 API and mutate `ui`, and Svelte's
 * fine-grained reactivity repaints. The live SSE stream keeps `ui.runs` and the selected run's
 * detail/logs current. This replaces the manual `innerHTML` re-rendering of the vanilla dashboard —
 * which is why transient UI state (a half-typed revert reason, scroll position) now survives updates.
 */

import { request } from './api';
import type { IssueSuggestion, LoadedConfig, LogLine, Repo, Run, RunDetail } from './types';

export const ui = $state({
  runs: [] as Run[], // newest first
  selectedId: null as number | null,
  detail: null as RunDetail | null,
  config: null as LoadedConfig | null,
  conn: 'connecting' as 'on' | 'off' | 'connecting',
  logs: [] as LogLine[], // the selected run's activity feed (persisted logs + live stream)
  view: 'run' as 'run' | 'editor',
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
});

/** Runs scoped to the active repo tab (all repos when no filter). */
export function filteredRuns(): Run[] {
  return ui.repoFilter === null ? ui.runs : ui.runs.filter((r) => r.repoRef === ui.repoFilter);
}

export function setRepoFilter(repoRef: string | null): void {
  ui.repoFilter = repoRef;
}

/** Enroll a repo (`POST /repos`) so runs can be started for it. Returns whether it succeeded. */
export async function enrollRepo(repoRef: string, baseBranch?: string): Promise<boolean> {
  try {
    const body = baseBranch?.trim() ? { repoRef, baseBranch: baseBranch.trim() } : { repoRef };
    const repo = await request<Repo>('POST', '/repos', body);
    banner(`Enrolled ${repo.repoRef}.`, 'ok');
    return true;
  } catch (err) {
    banner(`Enroll failed: ${(err as Error).message}`, 'err');
    return false;
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
 * Autocomplete suggestions for the new-run bar. The daemon's `GET /suggestions?q=` searches the
 * logged-in user's open GitHub issues (real mode) or its seeded issues (stub). If that request fails
 * (e.g. an older daemon without the route, or `gh` unauthenticated) we fall back to the issue refs of
 * runs already on screen so type-ahead still does something useful.
 */
export async function fetchSuggestions(query: string): Promise<IssueSuggestion[]> {
  try {
    return await request<IssueSuggestion[]>('GET', `/suggestions?q=${encodeURIComponent(query)}`);
  } catch {
    return localSuggestions(query);
  }
}

function localSuggestions(query: string): IssueSuggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: IssueSuggestion[] = [];
  for (const r of ui.runs) {
    if (seen.has(r.issueRef)) continue;
    seen.add(r.issueRef);
    if (!q || r.issueRef.toLowerCase().includes(q)) {
      const num = Number(r.issueRef.split('#')[1] ?? 0);
      out.push({ ref: r.issueRef, repo: r.repoRef, number: num, title: r.issueRef });
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
  const run = await request<Run>('POST', '/runs', { issueRef });
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

export async function control(action: 'pause' | 'resume' | 'stop'): Promise<void> {
  if (ui.selectedId === null) return;
  try {
    await request('POST', `/runs/${ui.selectedId}/${action}`);
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

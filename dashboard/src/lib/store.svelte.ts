/**
 * Dashboard state + actions (Svelte 5 runes). A single reactive `ui` object holds everything the
 * views render; the actions fetch from / command the Layer 6 API and mutate `ui`, and Svelte's
 * fine-grained reactivity repaints. The live SSE stream keeps `ui.runs` and the selected run's
 * detail/logs current. This replaces the manual `innerHTML` re-rendering of the vanilla dashboard —
 * which is why transient UI state (a half-typed revert reason, scroll position) now survives updates.
 */

import { request } from './api';
import type { LoadedConfig, LogLine, Run, RunDetail } from './types';

const ARCHIVE_KEY = 'af-archived-runs';
function loadArchived(): number[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

export const ui = $state({
  runs: [] as Run[], // newest first
  selectedId: null as number | null,
  detail: null as RunDetail | null,
  config: null as LoadedConfig | null,
  conn: 'connecting' as 'on' | 'off' | 'connecting',
  logs: [] as LogLine[], // the selected run's activity feed (persisted logs + live stream)
  view: 'run' as 'run' | 'editor',
  banner: null as { msg: string; kind: 'ok' | 'err' } | null,
  // Archiving resolved runs is client-side only for now — the M5 control plane has no archive
  // endpoint yet (deferred). We hide archived ids from the Resolved lane and persist the choice.
  archived: loadArchived() as number[],
  showArchived: false,
});

function persistArchived(): void {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(ui.archived));
  } catch {
    /* private mode / quota — archiving just won't persist across reloads */
  }
}

/** Archive a resolved (done/stopped) run so it drops out of the Resolved lane. */
export function archiveRun(id: number): void {
  if (!ui.archived.includes(id)) {
    ui.archived = [...ui.archived, id];
    persistArchived();
  }
}
export function unarchiveRun(id: number): void {
  ui.archived = ui.archived.filter((n) => n !== id);
  persistArchived();
}
export function toggleShowArchived(): void {
  ui.showArchived = !ui.showArchived;
}

/**
 * Autocomplete suggestions for the new-run bar. For now these are derived from the issue refs the
 * daemon already knows about (distinct repos + recent issues); a GitHub-backed source (the logged-in
 * user's active repos & open issues) is the intended upgrade — same shape, different fetch.
 */
export interface RunSuggestion {
  ref: string;
  repo: string;
}
export function suggestRuns(query: string): RunSuggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: RunSuggestion[] = [];
  for (const r of ui.runs) {
    if (seen.has(r.issueRef)) continue;
    seen.add(r.issueRef);
    if (!q || r.issueRef.toLowerCase().includes(q)) out.push({ ref: r.issueRef, repo: r.repoRef });
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
  const stage = data && typeof data === 'object' && 'stage' in data ? String((data as { stage: unknown }).stage) : undefined;
  return stage ? { level, message, stage } : { level, message };
}

export async function loadConfig(): Promise<void> {
  ui.config = await request<LoadedConfig>('GET', '/config');
}

export async function loadRuns(): Promise<void> {
  ui.runs = (await request<Run[]>('GET', '/runs')).sort((a, b) => b.id - a.id);
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
    const data = JSON.parse(e.data) as { activity: { runId: number; stage: string; activity: { summary: string } } };
    if (data.activity.runId === ui.selectedId) {
      ui.logs.push(toLogLine('info', data.activity.activity.summary, { stage: data.activity.stage }));
    }
  });
}

<script lang="ts">
  // The fleet's front page (home route): a masthead headline summarizing the fleet, a stat band,
  // the attention queue, the repositories ledger (with inline enrollment), and a recent-activity
  // feed. Everything derives from `ui.runs`/`ui.repos`, which the SSE stream keeps live — this page
  // is pure derivation, no polling of its own.
  import { ui, configureRepoSource, enrollRepo, fetchDirSuggestions, openRepoBoard, openRun, setRepoAutoMerge, setRepoConflictPolicy, setRepoWatch, setRepoWatchFilter, setRepoWatchInFlightCap } from './store.svelte';
  import {
    attentionModel,
    costStatusModel,
    fleetStatsModel,
    fmtRelTime,
    fmtTokens,
    recentRunsModel,
    repoLedgerModel,
  } from './render';

  const stats = $derived(fleetStatsModel(ui.runs));
  const cost = $derived(costStatusModel(ui.runs, ui.costCeiling));
  const ledger = $derived(repoLedgerModel(ui.repos, ui.runs));
  const attention = $derived(attentionModel(ui.runs));
  const recent = $derived(recentRunsModel(ui.runs, 8));
  const ceilingPct = $derived(cost.ceiling === null ? 0 : Math.min(100, (cost.activeCost / cost.ceiling) * 100));

  const dateline = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

  let enrolling = $state(false);
  let repoRef = $state('');
  let baseBranch = $state('');
  let busy = $state(false);

  // With nothing under management the form *is* the page's call to action, so it shows regardless
  // of the toggle (derived, not an effect — data arriving after mount must be able to close it).
  const showEnroll = $derived(enrolling || ledger.length === 0);

  async function submitEnroll(): Promise<void> {
    if (!repoRef.trim() || busy) return;
    busy = true;
    try {
      if (await enrollRepo(repoRef.trim(), baseBranch)) {
        repoRef = '';
        baseBranch = '';
        enrolling = false;
      }
    } finally {
      busy = false;
    }
  }

  function pad(i: number): string {
    return String(i + 1).padStart(2, '0');
  }

  // Per-repo working-directory config (Milestone 12). An unconfigured repo's row is always open (it
  // blocks runs — but the row is a single compact line, so this costs little); a configured one opens
  // on demand via the Directory pill. `dirInputs` holds each row's draft local path so typing in one
  // row doesn't leak into another.
  type LedgerRow = { repoRef: string; configured: boolean; sourceMode: 'clone' | 'local' | null; localRepo: string | null };
  let openConfig = $state<string | null>(null);
  let dirInputs = $state<Record<string, string>>({});
  let savingSource = $state<string | null>(null);
  // The repo whose local-directory editor is open (clicked "Local directory" but hasn't saved yet).
  let localEditor = $state<string | null>(null);
  // Path completions (daemon-backed `GET /fs/dirs` — the browser can't open Finder for an absolute
  // path, so the input doubles as a click-to-drill folder browser). Scoped to one row at a time.
  let dirSugs = $state<string[]>([]);
  let sugFor = $state<string | null>(null);
  let sugTimer: ReturnType<typeof setTimeout> | undefined;

  function isConfigOpen(row: LedgerRow): boolean {
    return !row.configured || openConfig === row.repoRef;
  }

  function toggleConfig(row: LedgerRow): void {
    openConfig = openConfig === row.repoRef ? null : row.repoRef;
    localEditor = null;
    closeSugs();
  }

  /** The effective draft path for a row: what the operator typed, else the already-bound directory. */
  function dirValue(row: LedgerRow): string {
    return dirInputs[row.repoRef] ?? (row.sourceMode === 'local' ? (row.localRepo ?? '') : '');
  }

  /** Whether to show the path input: the repo is already on local mode, or its editor was opened. */
  function localOpen(row: LedgerRow): boolean {
    return row.sourceMode === 'local' || localEditor === row.repoRef;
  }

  function refreshSugs(repoRef: string, q: string): void {
    clearTimeout(sugTimer);
    sugTimer = setTimeout(async () => {
      const dirs = await fetchDirSuggestions(q);
      // Only surface if this row's editor is still the active one (a stale response must not pop a
      // dropdown under another row).
      if (localEditor === repoRef || sugFor === repoRef) {
        dirSugs = dirs;
        sugFor = repoRef;
      }
    }, 120);
  }

  function onDirInput(repoRef: string, value: string): void {
    dirInputs[repoRef] = value;
    sugFor = repoRef;
    refreshSugs(repoRef, value);
  }

  function onDirFocus(row: LedgerRow): void {
    localEditor = row.repoRef;
    sugFor = row.repoRef;
    refreshSugs(row.repoRef, dirValue(row)); // empty → the daemon starts completions at ~
  }

  /** Adopt a suggestion, then immediately list its children so the operator drills down click-by-click. */
  function pickSug(repoRef: string, dir: string): void {
    dirInputs[repoRef] = dir;
    refreshSugs(repoRef, `${dir}/`);
  }

  function closeSugs(): void {
    clearTimeout(sugTimer);
    dirSugs = [];
    sugFor = null;
  }

  // Continuous-mode scope filter (issue #11). A compact chip next to Watch expands into two draft
  // inputs (label, milestone); applying POSTs the filter without toggling `watch`. Drafts are keyed
  // by repo so one row's typing never leaks into another; `?? row.value` shows the persisted filter.
  type FilterRow = { repoRef: string; watchFilterLabel: string | null; watchFilterMilestone: string | null };
  let openFilter = $state<string | null>(null);
  let filterLabelInputs = $state<Record<string, string>>({});
  let filterMilestoneInputs = $state<Record<string, string>>({});
  let savingFilter = $state<string | null>(null);

  /** A one-line summary of the active scope: `label:bug · milestone:v2`, or "all issues" when unset. */
  function filterSummary(row: FilterRow): string {
    const parts: string[] = [];
    if (row.watchFilterLabel) parts.push(`label:${row.watchFilterLabel}`);
    if (row.watchFilterMilestone) parts.push(`milestone:${row.watchFilterMilestone}`);
    return parts.length ? parts.join(' · ') : 'all issues';
  }

  function toggleFilter(row: FilterRow): void {
    openFilter = openFilter === row.repoRef ? null : row.repoRef;
  }

  function filterLabelValue(row: FilterRow): string {
    return filterLabelInputs[row.repoRef] ?? (row.watchFilterLabel ?? '');
  }
  function filterMilestoneValue(row: FilterRow): string {
    return filterMilestoneInputs[row.repoRef] ?? (row.watchFilterMilestone ?? '');
  }

  async function applyFilter(row: FilterRow): Promise<void> {
    savingFilter = row.repoRef;
    try {
      // Empty inputs clear that dimension (normalized to null server-side).
      await setRepoWatchFilter(row.repoRef, filterLabelValue(row).trim() || null, filterMilestoneValue(row).trim() || null);
      openFilter = null;
      delete filterLabelInputs[row.repoRef];
      delete filterMilestoneInputs[row.repoRef];
    } finally {
      savingFilter = null;
    }
  }

  // Continuous-mode in-flight cap (agents-fsm#10). A compact chip next to Scope expands into a single
  // integer input; applying POSTs the cap without toggling `watch`. Draft is keyed by repo so one
  // row's typing never leaks into another; `?? row.watchInFlightCap` shows the persisted value.
  type CapRow = { repoRef: string; watchInFlightCap: number };
  let openCap = $state<string | null>(null);
  let capInputs = $state<Record<string, string>>({});
  let savingCap = $state<string | null>(null);

  function toggleCap(row: CapRow): void {
    openCap = openCap === row.repoRef ? null : row.repoRef;
  }

  function capValue(row: CapRow): string {
    return capInputs[row.repoRef] ?? String(row.watchInFlightCap);
  }

  async function applyCap(row: CapRow): Promise<void> {
    const cap = Math.trunc(Number(capValue(row)));
    if (!Number.isInteger(cap) || cap < 1) return; // the input enforces min=1; ignore a bad draft
    savingCap = row.repoRef;
    try {
      await setRepoWatchInFlightCap(row.repoRef, cap);
      openCap = null;
      delete capInputs[row.repoRef];
    } finally {
      savingCap = null;
    }
  }

  async function saveSource(row: LedgerRow, mode: 'clone' | 'local'): Promise<void> {
    const dir = dirValue(row).trim();
    if (mode === 'local' && !dir) return;
    if (mode === 'clone' && row.sourceMode === 'clone') { openConfig = null; return; } // already bound — nothing to do
    savingSource = row.repoRef;
    try {
      if (await configureRepoSource(row.repoRef, mode, mode === 'local' ? dir : undefined)) {
        openConfig = null;
        localEditor = null;
        closeSugs();
      }
    } finally {
      savingSource = null;
    }
  }
</script>

<!-- masthead -->
<section class="af-sec af-hmast">
  <div class="af-wrap">
    <div class="af-hdate"><span class="af-eyebrow">Fleet overview</span><span class="dot">·</span><span class="af-eyebrow dim">{dateline}</span></div>
    <h1 class="af-hheadline">{stats.headline}</h1>
    <div class="af-hsub">
      <span><b>{stats.repos}</b> {stats.repos === 1 ? 'repository' : 'repositories'} with runs</span>
      <span class="sep">—</span>
      <span><b>{stats.totalRuns}</b> {stats.totalRuns === 1 ? 'run' : 'runs'} all-time</span>
      {#if stats.untrackedRuns > 0}
        <span class="sep">—</span>
        <span title="Runs on a harness that reports no usage; their spend can't be counted">{stats.untrackedRuns} untracked for cost</span>
      {/if}
    </div>
  </div>
</section>

<!-- stat band -->
<section class="af-sec af-hstats">
  <div class="af-wrap af-hstats-row">
    <div class="cell">
      <span class="af-eyebrow">Working</span>
      <span class="n" class:live={stats.active > 0}>{stats.active}</span>
      <span class="sub">agents in flight</span>
    </div>
    <div class="cell">
      <span class="af-eyebrow">Awaiting you</span>
      <span class="n" class:warn={stats.awaiting > 0}>{stats.awaiting}</span>
      <span class="sub">escalations &amp; questions</span>
    </div>
    <div class="cell">
      <span class="af-eyebrow">Resolved</span>
      <span class="n">{stats.resolved}</span>
      <span class="sub">runs completed</span>
    </div>
    <div class="cell">
      <span class="af-eyebrow">Tokens</span>
      <span class="n">{fmtTokens(stats.tokens)}</span>
      <span class="sub">burned all-time</span>
    </div>
    <div class="cell">
      <span class="af-eyebrow">Spend</span>
      <span class="n money">${stats.cost.toFixed(2)}</span>
      {#if cost.ceiling !== null}
        <span class="sub" class:over={cost.overCeiling}>active {cost.label}</span>
        <span class="meter" title="Active spend against the global cost ceiling">
          <span class="fill" class:over={cost.overCeiling} style="width:{ceilingPct}%"></span>
        </span>
      {:else}
        <span class="sub">all-time · no ceiling set</span>
      {/if}
    </div>
  </div>
</section>

<!-- attention queue -->
{#if attention.length > 0}
  <section class="af-sec af-hattn">
    <div class="af-wrap">
      <div class="af-sec-h">
        <h2>Needs attention</h2>
        <span class="meta"><b>{attention.length}</b> waiting on you</span>
      </div>
      {#each attention as a (a.id)}
        <button type="button" class="af-hrow af-hattn-row" onclick={() => openRun(a.id)}>
          <span class="pip {a.statusClass}"></span>
          <span class="ref">{a.issueRef}<small>run {a.id}</small></span>
          <span class="why">{a.label}</span>
          <span class={a.statusClass}>{a.status.replace('_', ' ')}</span>
          <span class="when">{fmtRelTime(a.updatedAt)}</span>
          <span class="arr">→</span>
        </button>
      {/each}
    </div>
  </section>
{/if}

<!-- repositories ledger -->
<section class="af-sec af-hledger">
  <div class="af-wrap">
    <div class="af-sec-h">
      <h2>Repositories</h2>
      <span class="meta"><b>{ledger.length}</b> under management</span>
      {#if ledger.length > 0}
        <button type="button" class="af-ghost spacer" onclick={() => (enrolling = !enrolling)}>
          {enrolling ? 'Close' : '+ Add repository'}
        </button>
      {/if}
    </div>

    {#if showEnroll}
      <div class="af-henroll">
        <div class="lead">Point the fleet at a GitHub repository — it will watch its issues and file runs.</div>
        <div class="af-enroll">
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" placeholder="owner/repo" bind:value={repoRef} autofocus
            onkeydown={(e) => { if (e.key === 'Enter') submitEnroll(); }} />
          <input type="text" placeholder="base branch (default main)" bind:value={baseBranch}
            onkeydown={(e) => { if (e.key === 'Enter') submitEnroll(); }} />
          <button type="button" class="af-enroll-go" disabled={!repoRef.trim() || busy} onclick={submitEnroll}>
            {busy ? 'Enrolling…' : 'Enroll'}
          </button>
        </div>
      </div>
    {/if}

    {#if ledger.length === 0}
      <div class="af-hempty">No repositories yet — add one above to put the fleet to work.</div>
    {/if}

    {#each ledger as row, i (row.repoRef)}
      <div class="af-hrow af-hrepo" class:watching={row.watch} class:unconfigured={row.enrolled && !row.configured}>
        <button type="button" class="af-hrepo-open" onclick={() => openRepoBoard(row.repoRef)}>
          <span class="ix">{pad(i)}</span>
          <span class="name">
            <span class="nm">{row.repoRef}{#if row.active > 0}<span class="livedot" title="Agents working now"></span>{/if}</span>
            <span class="meta2">
              {#if row.baseBranch}base {row.baseBranch}{:else}history only — re-enroll to run{/if}
              <!-- Working-directory source label (Milestone 12). -->
              {#if row.enrolled}
                {#if row.sourceMode === 'local'}
                  <span class="af-src local" title={row.localRepo ?? ''}>· 📁 {row.localRepo}</span>
                {:else if row.sourceMode === 'clone'}
                  <span class="af-src clone">· clones on run</span>
                {:else}
                  <span class="af-src warn">· ⚠ needs a working directory</span>
                {/if}
              {/if}
              {#if row.needsHuman > 0}<span class="warn">· {row.needsHuman} escalated</span>{/if}
            </span>
          </span>
          <span class="fig"><b>{row.active}</b><i>working</i></span>
          <span class="fig"><b class:warn={row.awaiting > 0}>{row.awaiting}</b><i>awaiting</i></span>
          <span class="fig"><b>{row.resolved}</b><i>resolved</i></span>
          <span class="fig wide"><b>{fmtTokens(row.tokens)}</b><i>tokens</i></span>
          <span class="fig wide"><b>{row.costLabel}</b><i>spend</i></span>
          <span class="when">{fmtRelTime(row.lastActivity)}</span>
          <span class="arr">→</span>
        </button>
        <!-- Config chips live in their own wrapping rail: on a wide screen they sit at the row's end
             (wrapping internally when tight), on small screens they become a full-width chip row —
             either way they can never crush the repo name to zero width. -->
        <div class="af-hchips">
        <!-- Configure the working directory (Milestone 12). Hidden while unconfigured — the config row
             below is force-open then, so a toggle would be a dead control. -->
        {#if row.enrolled && row.configured}
          <button
            type="button"
            class="af-hcfg"
            class:on={openConfig === row.repoRef}
            title="Change where this repo's code lives"
            onclick={() => toggleConfig(row)}
          >
            Directory
          </button>
        {/if}
        <!-- Continuous mode toggle (Milestone 11): auto-pick this repo's eligible new issues. Only an
             enrolled AND configured repo can be watched (auto-started runs need a working directory). -->
        <button
          type="button"
          class="af-hwatch"
          class:on={row.watch}
          disabled={!row.enrolled || !row.configured}
          title={!row.enrolled
            ? 'Re-enroll this repo to watch it for new issues'
            : !row.configured
              ? 'Choose a working directory before watching this repo'
              : row.watch
                ? 'Auto-picking new issues — click to stop watching'
                : 'Watch for new issues (auto-pick eligible ones)'}
          onclick={() => setRepoWatch(row.repoRef, !row.watch)}
        >
          <span class="pip"></span>{row.watch ? 'Watching' : 'Watch'}
        </button>
        <!-- Continuous-mode scope filter (issue #11): narrow the watched backlog to a label and/or
             milestone. A chip shows the active scope; clicking expands the editor row below. Distinct
             from the guard-bypass override — it only scopes which issues are considered candidates. -->
        {#if row.enrolled}
          <button
            type="button"
            class="af-hwatch af-hfilter"
            class:on={openFilter === row.repoRef}
            class:scoped={row.watchFilterLabel != null || row.watchFilterMilestone != null}
            title="Scope the watched backlog to a label and/or milestone (issue #11)"
            onclick={() => toggleFilter(row)}
          >
            <span class="pip"></span>Scope: {filterSummary(row)}
          </button>
        {/if}
        <!-- Continuous-mode in-flight cap (agents-fsm#10): how many of the watched backlog's issues the
             fleet admits in parallel (default 1 = sequential). A chip shows the current cap; clicking
             expands the editor row below. Actual concurrency stays bounded by FLEET_CONCURRENCY. -->
        {#if row.enrolled}
          <button
            type="button"
            class="af-hwatch af-hcap"
            class:on={openCap === row.repoRef}
            class:scoped={row.watchInFlightCap > 1}
            title="How many of this repo's watched issues run in parallel (agents-fsm#10)"
            onclick={() => toggleCap(row)}
          >
            <span class="pip"></span>Parallel: {row.watchInFlightCap}
          </button>
        {/if}
        <!-- Merge-conflict policy toggle: when a run's branch conflicts with base (the between-stage
             sync, or a finished run's PR turning CONFLICTING), 'auto' lets a resolver agent handle it;
             'manual' parks the run for you. Labeled "Auto-resolve conflicts" (not "Auto-merge") so it
             cannot be read as the PR auto-merge toggle beside it (agents-fsm#15 naming guard). -->
        <button
          type="button"
          class="af-hwatch af-hconflict"
          class:on={row.conflictPolicy === 'auto'}
          disabled={!row.enrolled}
          title={!row.enrolled
            ? 'Re-enroll this repo to configure conflict handling'
            : row.conflictPolicy === 'auto'
              ? 'Merge conflicts are auto-resolved by an agent (verified) — click to handle them yourself'
              : 'Merge conflicts wait for you — click to let an agent auto-resolve them'}
          onclick={() => setRepoConflictPolicy(row.repoRef, row.conflictPolicy === 'auto' ? 'manual' : 'auto')}
        >
          <span class="pip"></span>{row.conflictPolicy === 'auto' ? 'Auto-resolve conflicts' : 'Conflicts: manual'}
        </button>
        <!-- Opt-in auto-merge (agents-fsm#15): a run reaching the terminal `done` state merges its own
             PR into base. Never forced — a non-mergeable PR escalates needs_human with the PR left open.
             Same enrollment gating as the conflict-policy control. -->
        <button
          type="button"
          class="af-hwatch af-hautomerge"
          class:on={row.autoMerge}
          disabled={!row.enrolled}
          title={!row.enrolled
            ? 'Re-enroll this repo to configure auto-merge'
            : row.autoMerge
              ? 'Approved runs merge their own PRs into base (never forced) — click to keep merges manual'
              : 'Finished PRs wait for you to merge — click to let approved runs merge their own PRs'}
          onclick={() => setRepoAutoMerge(row.repoRef, !row.autoMerge)}
        >
          <span class="pip"></span>{row.autoMerge ? 'Auto-merging PRs' : 'Auto-merge PRs'}
        </button>
        </div>
      </div>

      <!-- Working-directory config row (Milestone 12): one compact line — a small segmented mode
           control, plus (for local mode) a path input that doubles as a daemon-backed folder browser.
           Force-open while unconfigured (runs are blocked until a mode is chosen), else on demand. -->
      {#if row.enrolled && isConfigOpen(row)}
        <div class="af-hsrccfg">
          <span class="lbl">source</span>
          <div class="af-srcseg" role="group" aria-label="Working-directory source for {row.repoRef}">
            <button
              type="button"
              class="af-srcmode"
              class:active={row.sourceMode === 'clone'}
              disabled={savingSource === row.repoRef}
              title="Clone a fresh copy from GitHub for every run — no local checkout needed"
              onclick={() => saveSource(row, 'clone')}
            >
              Clone on run
            </button>
            <button
              type="button"
              class="af-srcmode"
              class:active={row.sourceMode === 'local'}
              class:draft={localEditor === row.repoRef && row.sourceMode !== 'local'}
              disabled={savingSource === row.repoRef}
              title="Work from an existing checkout on this machine (isolated per-run git worktrees)"
              onclick={() => { localEditor = row.repoRef; }}
            >
              Local directory
            </button>
          </div>
          {#if localOpen(row)}
            <div class="af-dirbox">
              <input
                type="text"
                placeholder="/path/to/checkout — type to browse"
                value={dirValue(row)}
                onfocus={() => onDirFocus(row)}
                oninput={(e) => onDirInput(row.repoRef, e.currentTarget.value)}
                onkeydown={(e) => { if (e.key === 'Enter') saveSource(row, 'local'); if (e.key === 'Escape') closeSugs(); }}
                onblur={closeSugs}
              />
              {#if sugFor === row.repoRef && dirSugs.length > 0}
                <div class="af-dirsug">
                  {#each dirSugs as d (d)}
                    <!-- mousedown, not click: it fires before the input's blur closes the dropdown -->
                    <button type="button" onmousedown={(e) => { e.preventDefault(); pickSug(row.repoRef, d); }}>{d}/</button>
                  {/each}
                </div>
              {/if}
            </div>
            <button
              type="button"
              class="af-srcsave"
              disabled={savingSource === row.repoRef || !dirValue(row).trim()}
              title="We verify the folder is a checkout of {row.repoRef} before binding it"
              onclick={() => saveSource(row, 'local')}
            >
              {savingSource === row.repoRef ? 'Checking…' : 'Use folder'}
            </button>
          {/if}
        </div>
      {/if}

      <!-- Continuous-mode scope-filter editor (issue #11): two draft inputs (label, milestone) with an
           apply action. Empty inputs clear that dimension. Only meaningful for an enrolled repo. -->
      {#if row.enrolled && openFilter === row.repoRef}
        <div class="af-hfiltercfg">
          <span class="lbl">scope</span>
          <input
            type="text"
            class="af-filterin"
            placeholder="label (optional)"
            value={filterLabelValue(row)}
            oninput={(e) => { filterLabelInputs[row.repoRef] = e.currentTarget.value; }}
            onkeydown={(e) => { if (e.key === 'Enter') applyFilter(row); }}
          />
          <input
            type="text"
            class="af-filterin"
            placeholder="milestone (optional)"
            value={filterMilestoneValue(row)}
            oninput={(e) => { filterMilestoneInputs[row.repoRef] = e.currentTarget.value; }}
            onkeydown={(e) => { if (e.key === 'Enter') applyFilter(row); }}
          />
          <button
            type="button"
            class="af-srcsave"
            disabled={savingFilter === row.repoRef}
            title="Only issues matching every set field are considered; leave both blank to watch all open issues"
            onclick={() => applyFilter(row)}
          >
            {savingFilter === row.repoRef ? 'Saving…' : 'Apply'}
          </button>
        </div>
      {/if}

      <!-- Continuous-mode in-flight-cap editor (agents-fsm#10): a single integer input (min 1) with an
           apply action. Default 1 = today's strictly-sequential pickup. Only meaningful for an enrolled repo. -->
      {#if row.enrolled && openCap === row.repoRef}
        <div class="af-hfiltercfg">
          <span class="lbl">parallel</span>
          <input
            type="number"
            min="1"
            step="1"
            class="af-filterin af-capin"
            value={capValue(row)}
            oninput={(e) => { capInputs[row.repoRef] = e.currentTarget.value; }}
            onkeydown={(e) => { if (e.key === 'Enter') applyCap(row); }}
          />
          <button
            type="button"
            class="af-srcsave"
            disabled={savingCap === row.repoRef}
            title="Admit up to this many of the watched repo's issues at once — actual concurrency is still bounded by FLEET_CONCURRENCY"
            onclick={() => applyCap(row)}
          >
            {savingCap === row.repoRef ? 'Saving…' : 'Apply'}
          </button>
        </div>
      {/if}
    {/each}
  </div>
</section>

<!-- recent activity -->
{#if recent.length > 0}
  <section class="af-sec af-hrecent">
    <div class="af-wrap">
      <div class="af-sec-h">
        <h2>Latest activity</h2>
        <span class="meta">most recently touched runs, fleet-wide</span>
        <button type="button" class="af-ghost spacer" onclick={() => openRepoBoard(null)}>Open pipelines →</button>
      </div>
      {#each recent as r (r.id)}
        <button type="button" class="af-hrow af-hact" onclick={() => openRun(r.id)}>
          <span class="when">{fmtRelTime(r.updatedAt)}</span>
          <span class="ref">{r.issueRef}<small>run {r.id}</small></span>
          <span class="st">{r.state.replace(/_/g, ' ')}</span>
          <span class={r.statusClass}>{r.status.replace('_', ' ')}</span>
          <span class="sp">{fmtTokens(r.tokens)} · {r.costLabel}</span>
        </button>
      {/each}
    </div>
  </section>
{/if}

<script lang="ts">
  // The fleet's front page (home route): a masthead headline summarizing the fleet, a stat band,
  // the attention queue, the repositories ledger (with inline enrollment), and a recent-activity
  // feed. Everything derives from `ui.runs`/`ui.repos`, which the SSE stream keeps live — this page
  // is pure derivation, no polling of its own.
  import { ui, enrollRepo, openRepoBoard, openRun } from './store.svelte';
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
      <button type="button" class="af-hrow af-hrepo" onclick={() => openRepoBoard(row.repoRef)}>
        <span class="ix">{pad(i)}</span>
        <span class="name">
          <span class="nm">{row.repoRef}{#if row.active > 0}<span class="livedot" title="Agents working now"></span>{/if}</span>
          <span class="meta2">
            {#if row.baseBranch}base {row.baseBranch}{:else}history only — re-enroll to run{/if}
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

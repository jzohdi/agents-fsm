<script lang="ts">
  import { ui, selectRun, archiveRun, unarchiveRun, toggleShowArchived, filteredRuns } from './store.svelte';
  import { pipelineModel, fmtTokens } from './render';

  // Restrained per-lane accent dots (default to the brand accent for unknown states).
  const DOT: Record<string, string> = {
    triage: '#d98a3a', plan: '#5a6fd0', plan_review: '#6a4ea3', interface_design: '#2fa3b8',
    tdd: '#caa12f', frontend: '#1f7a52', backend: '#3a8f6e', code_review: '#caa12f',
    needs_human: '#b0443a', __resolved__: '#928c80',
  };

  // Scope the board to the active repo tab (all repos when no filter is set).
  const runs = $derived(filteredRuns());
  const model = $derived(pipelineModel(runs, ui.config?.fsm, { showArchived: ui.showArchived }));
  const total = $derived(runs.length);
  const active = $derived(runs.filter((r) => r.status === 'running' || r.status === 'paused').length);
  const awaiting = $derived(runs.filter((r) => r.status === 'needs_human' || r.status === 'awaiting_input' || r.status === 'blocked').length);

  // index of the first terminal lane so we can draw a single divider before it
  const firstTermIdx = $derived(model.columns.findIndex((c) => c.terminal));

  function open(id: number) {
    ui.view = 'run';
    void selectRun(id);
  }
</script>

<section class="af-sec">
  <div class="af-wrap">
    <div class="af-sec-h">
      <h2>Pipeline</h2>
      <span class="meta"><b>{active}</b> active · <b>{total}</b> runs · <b>{awaiting}</b> awaiting you</span>
      {#if model.archivedCount > 0 || ui.showArchived}
        <button type="button" class="af-ghost spacer" onclick={toggleShowArchived}>
          {ui.showArchived ? 'Hide archived' : `Show archived (${model.archivedCount})`}
        </button>
      {/if}
    </div>

    <div class="af-buckets">
      {#each model.columns as col, i (col.key)}
        {#if i === firstTermIdx}
          <div class="af-divcol"></div>
        {/if}
        <div class="af-bucket" class:is-empty={col.runs.length === 0} class:last={i === model.columns.length - 1}>
          <div class="af-b-head">
            <span class="dot" style="background:{DOT[col.key] ?? 'var(--accent)'}"></span>
            <span class="nm">{col.label}</span>
            <span class="ct">{col.runs.length}</span>
          </div>
          <div class="af-b-body">
            {#if col.runs.length === 0}
              <div class="af-b-empty">— empty —</div>
            {/if}
            {#each col.runs as r (r.id)}
              <div class="af-unit" class:sel={r.id === ui.selectedId} onclick={() => open(r.id)} role="button" tabindex="0"
                onkeydown={(e) => { if (e.key === 'Enter') open(r.id); }}>
                {#if r.resolved}
                  {#if r.archived}
                    <button type="button" class="archive" title="Restore from archive"
                      onclick={(e) => { e.stopPropagation(); unarchiveRun(r.id); }}>restore</button>
                  {:else}
                    <button type="button" class="archive" title="Archive this resolved run"
                      onclick={(e) => { e.stopPropagation(); archiveRun(r.id); }}>archive</button>
                  {/if}
                {/if}
                <div class="id">{r.id}<small>{r.repo}</small></div>
                <div class="ttl">{r.issue}</div>
                <div class="ln">
                  <span class={r.statusClass}>{r.status.replace('_', ' ')}</span>
                  <span class="sp">{fmtTokens(r.tokens)} · ${r.cost.toFixed(2)}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
</section>

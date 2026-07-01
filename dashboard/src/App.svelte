<script lang="ts">
  import { onMount } from 'svelte';
  import FileRunBar from './lib/FileRunBar.svelte';
  import RepoTabs from './lib/RepoTabs.svelte';
  import Pipeline from './lib/Pipeline.svelte';
  import RunDetail from './lib/RunDetail.svelte';
  import Editor from './lib/Editor.svelte';
  import { ui, loadConfig, loadRuns, loadCost, loadModels, selectRun, connectStream, banner } from './lib/store.svelte';
  import { costStatusModel } from './lib/render';

  onMount(async () => {
    try {
      await loadConfig();
      await loadRuns();
      await loadCost();
      await loadModels();
      // Open a sensible run by default so the detail view isn't empty on load: prefer a running one.
      if (ui.selectedId === null && ui.runs.length) {
        const first = ui.runs.find((r) => r.status === 'running') ?? ui.runs[0]!;
        await selectRun(first.id);
      }
    } catch (err) {
      banner(`Failed to load: ${(err as Error).message}`, 'err');
    }
    connectStream();
  });

  const connLabel = $derived(ui.conn === 'on' ? 'Live' : ui.conn === 'off' ? 'Reconnecting' : 'Connecting');
  // Fleet cost vs. the global ceiling (M8 B3); only surfaced when a ceiling is configured.
  const cost = $derived(costStatusModel(ui.runs, ui.costCeiling));
</script>

<header class="af-topbar">
  <div class="af-wrap af-row">
    <div class="af-brand">agent<span class="o">fleet</span><span>orchestrator</span></div>
    <nav class="af-nav">
      <button type="button" class:on={ui.view === 'run'} onclick={() => (ui.view = 'run')}>Runs</button>
      <button type="button" class:on={ui.view === 'editor'} onclick={() => (ui.view = 'editor')}>FSM editor</button>
    </nav>
    <div class="right">
      {#if cost.ceiling !== null}
        <span class="af-cost" class:over={cost.overCeiling} title={cost.overCeiling ? 'Cost ceiling reached — new runs are refused and runs park until you override them' : 'Fleet spend across active runs vs. the global cost ceiling'}>
          <span class="d"></span>{cost.label}{#if cost.overCeiling} · parked{/if}
        </span>
      {/if}
      <span>config <b>{ui.config?.version ?? '…'}</b></span>
      <span class="af-live {ui.conn}"><span class="d"></span>{connLabel}</span>
    </div>
  </div>
</header>

{#if ui.view === 'run'}
  <RepoTabs />
{/if}

<FileRunBar />

{#if ui.banner}
  <div class="af-banner af-banner-{ui.banner.kind}">{ui.banner.msg}</div>
{/if}

{#if ui.view === 'run'}
  <Pipeline />
  <RunDetail />
{:else}
  <Editor />
{/if}

<script lang="ts">
  import { onMount } from 'svelte';
  import FileRunBar from './lib/FileRunBar.svelte';
  import Home from './lib/Home.svelte';
  import RepoTabs from './lib/RepoTabs.svelte';
  import Pipeline from './lib/Pipeline.svelte';
  import RunDetail from './lib/RunDetail.svelte';
  import Editor from './lib/Editor.svelte';
  import { ui, initRouter, navigate, loadConfig, loadRuns, loadRepos, loadCost, loadModels, loadSettings, selectRun, connectStream, banner } from './lib/store.svelte';
  import { costStatusModel } from './lib/render';

  onMount(async () => {
    initRouter();
    try {
      await loadConfig();
      await loadRuns();
      await loadRepos();
      await loadCost();
      await loadModels();
      await loadSettings();
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
    <button type="button" class="af-brand" onclick={() => navigate('home')}>agent<span class="o">fleet</span><span>orchestrator</span></button>
    <nav class="af-nav">
      <button type="button" class:on={ui.route === 'home'} onclick={() => navigate('home')}>Home</button>
      <button type="button" class:on={ui.route === 'pipelines'} onclick={() => navigate('pipelines')}>Pipelines</button>
      <button type="button" class:on={ui.route === 'editor'} onclick={() => navigate('editor')}>FSM editor</button>
    </nav>
    <div class="right">
      {#if cost.ceiling !== null}
        <span class="af-cost" class:over={cost.overCeiling} title={cost.overCeiling ? 'Cost ceiling reached — new runs are refused and runs park until you override them' : 'Fleet spend across active runs vs. the global cost ceiling'}>
          <span class="d"></span>{cost.label}{#if cost.overCeiling} · parked{/if}
        </span>
      {/if}
      <span class="cfg">config <b>{ui.config?.version ?? '…'}</b></span>
      <span class="af-live {ui.conn}" title={connLabel}><span class="d"></span>{connLabel}</span>
    </div>
  </div>
</header>

{#if ui.route === 'pipelines'}
  <RepoTabs />
  <FileRunBar />
{/if}

{#if ui.banner}
  <div class="af-banner af-banner-{ui.banner.kind}">{ui.banner.msg}</div>
{/if}

{#if ui.route === 'home'}
  <Home />
{:else if ui.route === 'pipelines'}
  <Pipeline />
  <RunDetail />
{:else}
  <Editor />
{/if}

<script lang="ts">
  import { onMount } from 'svelte';
  import FileRunBar from './lib/FileRunBar.svelte';
  import Pipeline from './lib/Pipeline.svelte';
  import RunDetail from './lib/RunDetail.svelte';
  import Editor from './lib/Editor.svelte';
  import { ui, loadConfig, loadRuns, selectRun, connectStream, banner } from './lib/store.svelte';

  onMount(async () => {
    try {
      await loadConfig();
      await loadRuns();
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
</script>

<header class="af-topbar">
  <div class="af-wrap af-row">
    <div class="af-brand">agent<span class="o">fleet</span><span>orchestrator</span></div>
    <nav class="af-nav">
      <button type="button" class:on={ui.view === 'run'} onclick={() => (ui.view = 'run')}>Runs</button>
      <button type="button" class:on={ui.view === 'editor'} onclick={() => (ui.view = 'editor')}>FSM editor</button>
    </nav>
    <div class="right">
      <span>config <b>{ui.config?.version ?? '…'}</b></span>
      <span class="af-live {ui.conn}"><span class="d"></span>{connLabel}</span>
    </div>
  </div>
</header>

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

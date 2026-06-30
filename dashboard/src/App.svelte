<script lang="ts">
  import { onMount } from 'svelte';
  import RunsList from './lib/RunsList.svelte';
  import RunDetail from './lib/RunDetail.svelte';
  import Editor from './lib/Editor.svelte';
  import { ui, loadConfig, loadRuns, connectStream, startRun, banner } from './lib/store.svelte';

  let issue = $state('');

  onMount(async () => {
    try {
      await loadConfig();
      await loadRuns();
    } catch (err) {
      banner(`Failed to load: ${(err as Error).message}`, 'err');
    }
    connectStream();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const ref = issue.trim();
    if (!ref) return;
    try {
      await startRun(ref);
      issue = '';
    } catch (err) {
      banner(`Could not start run: ${(err as Error).message}`, 'err');
    }
  }

  const connLabel = $derived(ui.conn === 'on' ? 'live' : ui.conn === 'off' ? 'reconnecting' : 'connecting');
</script>

<header class="af-header">
  <div class="af-brand">agent&#8209;fleet<span class="af-sub">orchestrator</span></div>
  <form class="af-new-run" onsubmit={submit}>
    <input bind:value={issue} placeholder="owner/repo#123" autocomplete="off" aria-label="issue reference" />
    <button type="submit">Start run</button>
  </form>
  <div class="af-meta">
    <span>config <code>{ui.config?.version ?? '…'}</code></span>
    <span class="af-conn af-conn-{ui.conn}" title="live stream">● {connLabel}</span>
    <nav class="af-tabs">
      <button type="button" class="af-tab" class:af-tab-active={ui.view === 'run'} onclick={() => (ui.view = 'run')}>Runs</button>
      <button type="button" class="af-tab" class:af-tab-active={ui.view === 'editor'} onclick={() => (ui.view = 'editor')}>FSM editor</button>
    </nav>
  </div>
</header>

{#if ui.banner}
  <div class="af-banner af-banner-{ui.banner.kind}">{ui.banner.msg}</div>
{/if}

<main class="af-main">
  <RunsList />
  <section class="af-content">
    {#if ui.view === 'run'}
      <RunDetail />
    {:else}
      <Editor />
    {/if}
  </section>
</main>

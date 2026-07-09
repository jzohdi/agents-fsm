<script lang="ts">
  import { onMount } from 'svelte';
  import FileRunBar from './lib/FileRunBar.svelte';
  import ContextSettings from './lib/ContextSettings.svelte';
  import Home from './lib/Home.svelte';
  import RepoTabs from './lib/RepoTabs.svelte';
  import Pipeline from './lib/Pipeline.svelte';
  import RunDetail from './lib/RunDetail.svelte';
  import Editor from './lib/Editor.svelte';
  import { ui, initRouter, navigate, bootstrap } from './lib/store.svelte';
  import TokenPrompt from './lib/TokenPrompt.svelte';
  import { costStatusModel } from './lib/render';

  onMount(async () => {
    initRouter();
    // `bootstrap` runs the mount-loads + opens the stream, and routes a 401 into `ui.authRequired`
    // (the token prompt below). Auth-off daemons never 401, so this is the old behaviour unchanged.
    await bootstrap();
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

{#if ui.authRequired}
  <TokenPrompt />
{/if}

{#if ui.route === 'pipelines'}
  <RepoTabs />
  <FileRunBar />
  <ContextSettings />
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

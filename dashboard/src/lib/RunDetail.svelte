<script lang="ts">
  import { ui, control, revertRun } from './store.svelte';
  import { telemetryModel, fmtCost, fmtDuration } from './render';
  import FsmGraph from './FsmGraph.svelte';

  const detail = $derived(ui.detail);
  const run = $derived(detail?.run ?? null);
  const terminal = $derived(run ? run.status === 'done' || run.status === 'stopped' : false);
  const tel = $derived(telemetryModel(detail?.agentRuns ?? []));
  const revertable = $derived(
    ui.config ? Object.entries(ui.config.fsm.states).filter(([, d]) => !d.terminal).map(([name]) => name) : [],
  );

  let revertTo = $state('');
  let revertReason = $state('');
  // Keep the revert target valid as the config/run changes, without clobbering a user's choice.
  $effect(() => {
    if (revertable.length && !revertable.includes(revertTo)) revertTo = revertable[0]!;
  });

  function reasonText(reason: unknown): string {
    return typeof reason === 'string' ? reason : JSON.stringify(reason);
  }
  function artifactUrl(locator: unknown): string | null {
    return locator && typeof locator === 'object' && typeof (locator as { url?: unknown }).url === 'string'
      ? (locator as { url: string }).url
      : null;
  }

  async function submitRevert(e: SubmitEvent) {
    e.preventDefault();
    await revertRun(revertTo, revertReason);
    revertReason = '';
  }
</script>

{#if !run}
  <div class="af-empty af-empty-pad">Select a run to inspect it, or start one above.</div>
{:else}
  <div class="af-detail-head">
    <h2>Run {run.id} · {run.issueRef} <span class="af-status af-status-{run.status}">{run.status}</span></h2>
    <div class="af-controls">
      {#if run.status === 'running'}
        <button type="button" onclick={() => control('pause')}>Pause</button>
      {/if}
      {#if run.status === 'paused' || run.status === 'needs_human'}
        <button type="button" onclick={() => control('resume')}>Resume</button>
      {/if}
      {#if !terminal}
        <button type="button" class="af-danger" onclick={() => control('stop')}>Stop</button>
        <form class="af-revert-form" onsubmit={submitRevert}>
          <select bind:value={revertTo} aria-label="revert to state">
            {#each revertable as s (s)}<option value={s}>{s}</option>{/each}
          </select>
          <input bind:value={revertReason} placeholder="revert reason" aria-label="revert reason" />
          <button type="submit" class="af-secondary">Revert</button>
        </form>
      {:else}
        <span class="af-reason">terminal — no further control</span>
      {/if}
    </div>
  </div>

  {#if ui.config}
    <FsmGraph fsm={ui.config.fsm} currentState={run.currentState} />
  {/if}

  <div class="af-panels">
    <section class="af-panel">
      <h3>Transitions</h3>
      {#if detail && detail.transitions.length}
        <table>
          <thead><tr><th>from</th><th>trigger</th><th>to</th></tr></thead>
          <tbody>
            {#each detail.transitions as t (t.id)}
              <tr>
                <td>{t.fromState}</td>
                <td class:af-back={t.backEdge}>{t.trigger}{t.backEdge ? ' ↩' : ''}</td>
                <td>
                  {t.toState}
                  {#if t.reason}<div class="af-reason">{reasonText(t.reason)}</div>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="af-empty">No transitions yet.</p>
      {/if}
    </section>

    <section class="af-panel">
      <h3>Telemetry</h3>
      <table>
        <thead><tr><th>stage</th><th class="af-num">runs</th><th class="af-num">tokens</th><th class="af-num">time</th></tr></thead>
        <tbody>
          {#if tel.stages.length === 0}
            <tr><td colspan="4" class="af-empty">No agent runs yet.</td></tr>
          {/if}
          {#each tel.stages as s (s.stage)}
            <tr><td>{s.stage}</td><td class="af-num">{s.invocations}</td><td class="af-num">{s.tokens}</td><td class="af-num">{fmtDuration(s.durationMs)}</td></tr>
          {/each}
        </tbody>
        <tfoot>
          <tr><td>total</td><td class="af-num">{tel.totals.invocations}</td><td class="af-num">{tel.totals.tokens}</td><td class="af-num">{fmtDuration(tel.totals.durationMs)}</td></tr>
        </tfoot>
      </table>
      <p class="af-reason">cost {fmtCost(run.costUsed)}</p>
    </section>

    <section class="af-panel">
      <h3>Artifacts</h3>
      {#if detail && detail.artifacts.length}
        <ul class="af-artifacts">
          {#each detail.artifacts as a, i (i)}
            <li>
              <span class="af-kind">{a.kind}</span>
              {#if artifactUrl(a.locator)}
                <a href={artifactUrl(a.locator)} target="_blank" rel="noopener">{artifactUrl(a.locator)}</a>
              {:else}
                <code>{reasonText(a.locator)}</code>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="af-empty">No artifacts yet.</p>
      {/if}
    </section>

    <section class="af-panel af-panel-wide">
      <h3>Activity log</h3>
      <div class="af-logs">
        {#if ui.logs.length === 0}
          <p class="af-empty">No activity yet.</p>
        {/if}
        {#each ui.logs as line, i (i)}
          <div class="af-log-line" class:af-log-warn={line.level === 'warn' || line.level === 'error'}>
            {#if line.stage}<span class="af-log-stage">[{line.stage}] </span>{/if}{line.message}
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}

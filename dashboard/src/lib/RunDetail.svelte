<script lang="ts">
  import { ui, control, revertRun, overrideCost, setModel } from './store.svelte';
  import type { HarnessModel } from './types';
  import { telemetryModel, escalationModel, activityLane, costStatusModel, issueUrl, prUrl, branchUrl, fmtCost, fmtDuration, fmtTokens, escapeHtml, humanizeState } from './render';
  import StateMachine from './StateMachine.svelte';
  import ScrollArea from './ScrollArea.svelte';

  const detail = $derived(ui.detail);
  const run = $derived(detail?.run ?? null);
  // GitHub deep links for the header (open in a new tab); null when not applicable.
  const issueHref = $derived(issueUrl(run?.issueRef));
  const branchHref = $derived(branchUrl(run?.repoRef, run?.branch));
  const prHref = $derived(prUrl(run?.repoRef, run?.prNumber));
  // The escalation inspector (needs_human UX, README M7): why the run escalated + operator guidance.
  const escalation = $derived(
    run && run.status === 'needs_human'
      ? escalationModel(detail?.transitions, ui.config?.fsm.escalationState)
      : null,
  );
  const terminal = $derived(run ? run.status === 'done' || run.status === 'stopped' : false);
  // Cost-override controls (M8 B3): the ceiling only parks *running* runs (a needs_human/paused run is
  // parked for a different reason), so show them there once the fleet is at the ceiling, or whenever the
  // run already carries an override (so it can be cleared).
  const cost = $derived(costStatusModel(ui.runs, ui.costCeiling));
  const showCostOverride = $derived(run?.status === 'running' && ui.costCeiling !== null && (cost.overCeiling || !!run?.costOverride));
  const tel = $derived(telemetryModel(detail?.agentRuns ?? []));
  const stageMeta = $derived(
    Object.fromEntries(tel.stages.map((s) => [s.stage, `${fmtDuration(s.durationMs)} · ${s.invocations}×`])),
  );
  const revertable = $derived(
    ui.config ? Object.entries(ui.config.fsm.states).filter(([, d]) => !d.terminal).map(([name]) => name) : [],
  );
  // The run's effective model for the live badge: its override, else the daemon default.
  const model = $derived(run?.modelOverride ?? ui.models?.defaultModel ?? 'default');
  // Catalog models grouped for the dropdown's <optgroup>s (ungrouped models under the '' key).
  const modelGroups = $derived.by(() => {
    const cat = ui.models;
    if (!cat) return [] as Array<[string, HarnessModel[]]>;
    const m = new Map<string, HarnessModel[]>();
    for (const hm of cat.models) {
      const g = hm.group ?? '';
      (m.get(g) ?? m.set(g, []).get(g)!).push(hm);
    }
    return [...m.entries()];
  });

  let revertTo = $state('');
  let revertReason = $state('');
  $effect(() => {
    if (revertable.length && !revertable.includes(revertTo)) revertTo = revertable[0]!;
  });

  // Split the one activity stream into two non-redundant feeds: the agent's actions (tool calls) go to
  // the activity wire; its words (thinking + narration) go to the live "model thinking" stream.
  const wireLines = $derived(ui.logs.filter((l) => activityLane(l.kind) === 'wire'));
  const thinkingLines = $derived(ui.logs.filter((l) => activityLane(l.kind) === 'thinking'));

  // live "model thinking" tail — auto-scroll to the newest line as the stream appends
  let streamEl = $state<HTMLDivElement | undefined>(undefined);
  $effect(() => {
    void thinkingLines.length;
    if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
  });
  const liveTail = $derived(thinkingLines.slice(-14));

  function reasonText(reason: unknown): string {
    return typeof reason === 'string' ? reason : JSON.stringify(reason);
  }
  function artifactUrl(locator: unknown): string | null {
    return locator && typeof locator === 'object' && typeof (locator as { url?: unknown }).url === 'string'
      ? (locator as { url: string }).url
      : null;
  }
  // Escape, then promote `…` spans to <code> and **…** to <mark> so wire lines highlight key pieces.
  function formatWire(message: string): string {
    return escapeHtml(message)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>');
  }

  async function submitRevert(e: SubmitEvent) {
    e.preventDefault();
    await revertRun(revertTo, revertReason);
    revertReason = '';
  }
</script>

{#if !run}
  <section class="af-sec" style="border-bottom:0">
    <div class="af-wrap af-empty-pad">Select a run from the pipeline above, or file a new one.</div>
  </section>
{:else}
  <section class="af-sec">
    <div class="af-wrap">
  <div class="af-dhead">
    <div>
      <h1>Run {run.id} · {run.issueRef}</h1>
      <div class="sub">
        {#if run.branch}
          <span>branch {#if branchHref}<a href={branchHref} target="_blank" rel="noopener">{run.branch}</a>{:else}{run.branch}{/if}</span><span class="sep">·</span>
        {/if}
        <span>{run.agentRunsCount} agent runs</span><span class="sep">·</span>
        <span class="af-statline af-stat-{run.status}"><span class="pip"></span>{run.status.replace('_', ' ')}</span>
      </div>
      <div class="af-open">
        {#if issueHref}<a class="af-openbtn" href={issueHref} target="_blank" rel="noopener">Open issue ↗</a>{/if}
        {#if prHref}<a class="af-openbtn" href={prHref} target="_blank" rel="noopener">Open PR #{run.prNumber} ↗</a>{/if}
      </div>
    </div>
    <div class="af-controls">
      {#if !terminal && ui.models && ui.models.models.length}
        <label class="af-model">
          <span class="lbl">model</span>
          <select
            value={run.modelOverride ?? ''}
            onchange={(e) => setModel(run.id, e.currentTarget.value || null)}
            aria-label="run model"
          >
            <option value="">Default{ui.models.defaultModel ? ` — ${ui.models.defaultModel}` : ''}</option>
            {#each modelGroups as [group, models] (group)}
              {#if group}
                <optgroup label={group}>
                  {#each models as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
                </optgroup>
              {:else}
                {#each models as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
              {/if}
            {/each}
          </select>
        </label>
      {/if}
      {#if run.status === 'running'}
        <button type="button" onclick={() => control('pause')}>Pause</button>
      {/if}
      {#if run.status === 'paused' || run.status === 'needs_human'}
        <button type="button" onclick={() => control('resume')}>Resume</button>
      {/if}
      {#if !terminal}
        <form class="af-revert" onsubmit={submitRevert}>
          <select bind:value={revertTo} aria-label="revert to state">
            {#each revertable as s (s)}<option value={s}>{s}</option>{/each}
          </select>
          <input bind:value={revertReason} placeholder="revert reason" aria-label="revert reason" />
          <button type="submit">Revert</button>
        </form>
        <button type="button" class="stop" onclick={() => control('stop')}>Stop</button>
      {:else}
        <span class="terminal-note">terminal — no further control</span>
      {/if}
      {#if showCostOverride}
        <div class="af-cost-override">
          {#if run.costOverride}
            <span class="af-tag">ceiling override: {run.costOverride === 'full' ? 'complete issue' : 'next step'}</span>
            <button type="button" onclick={() => overrideCost(run.id, 'none')}>Clear</button>
          {:else}
            <span class="af-tag over">cost-parked</span>
            <button type="button" onclick={() => overrideCost(run.id, 'next_step')}>Run next step</button>
            <button type="button" onclick={() => overrideCost(run.id, 'full')}>Complete issue</button>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  {#if ui.config}
    <StateMachine fsm={ui.config.fsm} {run} transitions={detail?.transitions ?? []} {stageMeta} />
  {/if}

  {#if escalation}
    <div class="af-esc" role="alert">
      <div class="af-esc-head">
        <span class="tag">needs human</span>
        <span class="trig">{escalation.trigger}</span>
        <span class="from">escalated from {humanizeState(escalation.fromState)}</span>
      </div>
      <p class="af-esc-guide">{escalation.guidance}</p>
      {#if escalation.reason}<pre class="af-esc-reason">{reasonText(escalation.reason)}</pre>{/if}
    </div>
  {/if}
    </div>
  </section>

  <section class="af-sec">
    <div class="af-wrap af-triptych">
    <div class="af-col">
      <span class="af-eyebrow">Telemetry</span>
      <ScrollArea resetKey={run.id}>
        <table class="af-kv">
          <thead><tr><th>stage</th><th class="num">runs</th><th class="num">tokens</th><th class="num">time</th></tr></thead>
          <tbody>
            {#if tel.stages.length === 0}
              <tr><td colspan="4" class="af-empty">No agent runs yet.</td></tr>
            {/if}
            {#each tel.stages as s (s.stage)}
              <tr><td>{s.stage}</td><td class="num">{s.invocations}</td><td class="num">{fmtTokens(s.tokens)}</td><td class="num">{fmtDuration(s.durationMs)}</td></tr>
            {/each}
          </tbody>
          <tfoot>
            <tr><td>total · {fmtCost(run.costUsed)}</td><td class="num">{tel.totals.invocations}</td><td class="num">{fmtTokens(tel.totals.tokens)}</td><td class="num">{fmtDuration(tel.totals.durationMs)}</td></tr>
          </tfoot>
        </table>
      </ScrollArea>
    </div>

    <div class="af-col">
      <span class="af-eyebrow">Artifacts</span>
      <ScrollArea resetKey={run.id}>
        {#if detail && detail.artifacts.length}
          {#each detail.artifacts as a, i (i)}
            <div class="af-art">
              <span class="k">{a.kind}</span>
              <span class="v">
                {#if artifactUrl(a.locator)}
                  <a href={artifactUrl(a.locator)} target="_blank" rel="noopener">{artifactUrl(a.locator)}</a>
                {:else}
                  {reasonText(a.locator)}
                {/if}
              </span>
            </div>
          {/each}
        {:else}
          <p class="af-empty">No artifacts yet.</p>
        {/if}
      </ScrollArea>
    </div>

    <div class="af-col">
      <span class="af-eyebrow">Transitions</span>
      <ScrollArea resetKey={run.id}>
        {#if detail && detail.transitions.length}
          {#each detail.transitions as t (t.id)}
            <div class="af-tr" class:back={t.backEdge}>
              <span class="f">{t.fromState}</span>
              <span class="ar">{t.backEdge ? '↩' : '→'}</span>
              <span class="to">{t.toState} <span class="trig">{t.trigger}</span></span>
              {#if t.reason}<span class="why">{reasonText(t.reason)}</span>{/if}
            </div>
          {/each}
        {:else}
          <p class="af-empty">No transitions yet.</p>
        {/if}
      </ScrollArea>
    </div>
  </div>
</section>

<section class="af-sec" style="border-bottom:0">
  <div class="af-wrap af-actgrid">
    <div class="wirecol">
      <span class="af-eyebrow"><span>Activity wire</span><span style="color:var(--ink4)">{wireLines.length} actions</span></span>
      <ScrollArea height="300px" resetKey={run.id}>
        <div class="af-wire">
          {#if wireLines.length === 0}
            <p class="af-empty">No actions yet.</p>
          {/if}
          {#each wireLines as line, i (i)}
            <div class="ln" class:warn={line.level === 'warn' || line.level === 'error'}>
              <span class="stg">{line.stage ?? '—'}</span>
              <!-- eslint-disable-next-line svelte/no-at-html-tags — formatWire escapes input then promotes `code`/**mark** -->
              <span class="msg">{@html formatWire(line.message)}</span>
            </div>
          {/each}
        </div>
      </ScrollArea>
    </div>

    <div class="livecol">
      <span class="af-eyebrow"><span>Live · model thinking</span>
        {#if run.status === 'running'}<span class="af-live on" style="font-size:10px"><span class="d"></span>stream</span>{/if}
      </span>
      <div class="af-livebox" class:idle={run.status !== 'running'}>
        <div class="top"><span class="dd"></span><span class="lab">claude · {run.currentState} agent</span><span class="model">{model}</span></div>
        <div class="af-stream" bind:this={streamEl}>
          {#if run.status !== 'running'}
            run is {run.status.replace('_', ' ')} — no live model activity
          {:else if liveTail.length === 0}
            <span class="tk">waiting for the next activity… <span class="af-cursor"></span></span>
          {:else}
            {#each liveTail as line, i (i)}
              <!-- eslint-disable-next-line svelte/no-at-html-tags — escaped by formatWire -->
              <div class="tk" class:warn={line.level === 'warn' || line.level === 'error'}>{@html formatWire(line.message)}</div>
            {/each}
            <span class="tk"><span class="af-cursor"></span></span>
          {/if}
        </div>
      </div>
    </div>
  </div>
</section>
{/if}

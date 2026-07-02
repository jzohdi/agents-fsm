<script lang="ts">
  import { ui, control, revertRun, overrideCost, setModel, setEffort, setHarness, loadRunModels, checkPrFeedback } from './store.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import EffortSelect from './EffortSelect.svelte';
  import { telemetryModel, escalationModel, activityLane, costStatusModel, issueUrl, prUrl, branchUrl, isWatchingPrFeedback, fmtRunCost, fmtDuration, fmtTokens, escapeHtml, humanizeState, humanizeHarness, schedulingLabel } from './render';
  import StateMachine from './StateMachine.svelte';
  import ScrollArea from './ScrollArea.svelte';

  const detail = $derived(ui.detail);
  const run = $derived(detail?.run ?? null);
  // GitHub deep links for the header (open in a new tab); null when not applicable.
  const issueHref = $derived(issueUrl(run?.issueRef));
  const branchHref = $derived(branchUrl(run?.repoRef, run?.branch));
  const prHref = $derived(prUrl(run?.repoRef, run?.prNumber));
  // The M9 scheduling summary (deps + verification state, priority, order key); '' renders nothing.
  const schedulingLine = $derived(run ? schedulingLabel(run) : '');
  // The escalation inspector (needs_human UX, README M7): why the run escalated + operator guidance.
  const escalation = $derived(
    run && run.status === 'needs_human'
      ? escalationModel(detail?.transitions, ui.config?.fsm.escalationState)
      : null,
  );
  const terminal = $derived(run ? run.status === 'done' || run.status === 'stopped' : false);
  // Is the orchestrator watching this finished run's open PR for `feedback:` comments? (README §9.7)
  const watchingPrFeedback = $derived(isWatchingPrFeedback(run));
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
  // Load the *run's own* harness catalog (GET /models?harness=run.harness) whenever the selected run's
  // harness changes — including right after an operator switches it. This drives RunDetail's model/effort
  // controls off the run's harness rather than the default one, so they render for any harness.
  $effect(() => {
    if (run?.harness) void loadRunModels(run.harness);
  });
  // The per-run catalog, but only once it matches the current run's harness (guards the brief window after a
  // harness switch where `ui.runModels` still holds the previous harness's catalog). Null → controls hide.
  const runCatalog = $derived(ui.runModels && ui.runModels.harness === run?.harness ? ui.runModels : null);
  // The run's effective model for the live badge: its override, else the run-harness default, else "default".
  const model = $derived(run?.modelOverride ?? runCatalog?.defaultModel ?? 'default');
  // The effort control appears when the run's effective model (override, else the harness default) supports
  // effort — so a Claude run can bump reasoning per-run, while a Cursor run (no effort) never shows it.
  const runEfforts = $derived.by(() => {
    const id = run?.modelOverride ?? runCatalog?.defaultModel;
    return (id ? runCatalog?.models.find((m) => m.id === id)?.efforts : undefined) ?? [];
  });

  let revertTo = $state('');
  let revertReason = $state('');
  // Operator guidance typed into the escalation panel; sent with resume and delivered to the
  // retried stage as its `reentry.operatorNotes` (so a guided resume changes the retry's behavior).
  let guidance = $state('');
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

  async function submitGuidedResume(e: SubmitEvent) {
    e.preventDefault();
    await control('resume', guidance);
    guidance = '';
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
        {#if schedulingLine}
          <span title="Scheduling declarations from the issue's marker block (edit them on the issue)">{schedulingLine}</span><span class="sep">·</span>
        {/if}
        <span class="af-statline af-stat-{run.status}"><span class="pip"></span>{run.status.replace('_', ' ')}</span>
      </div>
      <div class="af-open">
        {#if issueHref}<a class="af-openbtn" href={issueHref} target="_blank" rel="noopener">Open issue ↗</a>{/if}
        {#if prHref}<a class="af-openbtn" href={prHref} target="_blank" rel="noopener">Open PR #{run.prNumber} ↗</a>{/if}
      </div>
    </div>
    <div class="af-controls">
      {#if !terminal && ui.harnesses.length > 1}
        <!-- Switch the paused/non-terminal run's harness; takes effect on its next stage. The daemon clears
             the run's model/effort overrides on change, and the model dropdown below follows the new harness. -->
        <label class="af-model af-runharness">
          <span class="lbl">harness</span>
          <select value={run.harness} onchange={(e) => setHarness(run.id, e.currentTarget.value)} aria-label="run harness">
            {#each ui.harnesses as h (h)}<option value={h}>{humanizeHarness(h)}</option>{/each}
          </select>
        </label>
      {/if}
      {#if !terminal && runCatalog && runCatalog.models.length}
        <!-- A plain wrapper (not a <label>): a <label> around the picker's button would forward a second
             synthetic click to it, immediately re-closing the popover. -->
        <div class="af-model">
          <span class="lbl">model</span>
          <ModelPicker
            models={runCatalog.models}
            value={run.modelOverride}
            defaultLabel={runCatalog.defaultModel}
            onselect={(id) => setModel(run.id, id)}
            ariaLabel="run model"
          />
        </div>
        {#if runEfforts.length}
          <EffortSelect efforts={runEfforts} value={run.effortOverride} onselect={(e) => setEffort(run.id, e)} ariaLabel="run reasoning effort" />
        {/if}
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
      {:else if !watchingPrFeedback}
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
      {#if watchingPrFeedback}
        <div class="af-prwatch">
          <span class="af-tag"><span class="pip"></span>watching {run.prNumber ? `PR #${run.prNumber}` : 'the PR'} for feedback</span>
          <button type="button" onclick={() => checkPrFeedback(run.id)}>Check now</button>
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
      {#if escalation.detail.headline}
        <p class="af-esc-what">{escalation.detail.headline}</p>
      {/if}
      {#if escalation.detail.bullets.length}
        <ul class="af-esc-issues">
          {#each escalation.detail.bullets as b, i (i)}<li>{b}</li>{/each}
        </ul>
      {/if}
      {#if escalation.reason}
        {#if escalation.detail.headline}
          <details class="af-esc-raw">
            <summary>raw payload</summary>
            <pre class="af-esc-reason">{reasonText(escalation.reason)}</pre>
          </details>
        {:else}
          <pre class="af-esc-reason">{reasonText(escalation.reason)}</pre>
        {/if}
      {/if}
      <form class="af-esc-resolve" onsubmit={submitGuidedResume}>
        <textarea
          bind:value={guidance}
          rows="2"
          placeholder="Guidance for the retry — what should the stage do differently? (optional; delivered to the agent)"
          aria-label="resume guidance"
        ></textarea>
        <button type="submit">{guidance.trim() ? 'Resume with guidance' : 'Resume'}</button>
      </form>
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
            <tr><td>total · {fmtRunCost(run.harness, run.costUsed)}</td><td class="num">{tel.totals.invocations}</td><td class="num">{fmtTokens(tel.totals.tokens)}</td><td class="num">{fmtDuration(tel.totals.durationMs)}</td></tr>
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
        <div class="top"><span class="dd"></span><span class="lab">{humanizeHarness(run.harness || 'claude-code')} · {run.currentState} agent</span><span class="model">{model}</span></div>
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

<script lang="ts">
  import { stepperModel, traversedBackEdges, humanizeState } from './render';
  import type { FsmConfig, Run, Transition } from './types';

  let {
    fsm,
    run,
    transitions,
    stageMeta = {},
  }: { fsm: FsmConfig; run: Run; transitions: Transition[]; stageMeta?: Record<string, string> } = $props();

  // A run that escalated (needs_human) sits off the forward spine; show progress up to the last
  // forward state it actually reached (the `from` of its final transition), so the stepper still reads.
  const effectiveState = $derived.by(() => {
    if (fsm.forwardOrder.includes(run.currentState)) return run.currentState;
    for (let i = transitions.length - 1; i >= 0; i--) {
      if (fsm.forwardOrder.includes(transitions[i]!.fromState)) return transitions[i]!.fromState;
    }
    return undefined;
  });

  const nodes = $derived(stepperModel(fsm, effectiveState));
  const backEdges = $derived(traversedBackEdges(transitions));
  const escalated = $derived(run.status === 'needs_human');

  let wrapEl: HTMLDivElement;
  let svgEl: SVGSVGElement;

  function drawArcs() {
    if (!wrapEl || !svgEl) return;
    const wr = wrapEl.getBoundingClientRect();
    svgEl.setAttribute('viewBox', `0 0 ${wr.width} ${wr.height}`);
    svgEl.querySelectorAll('.arc').forEach((n) => n.remove());
    const NS = 'http://www.w3.org/2000/svg';
    for (const be of backEdges) {
      const fromEl = wrapEl.querySelector(`.af-node[data-state="${be.from}"] .circle`);
      const toEl = wrapEl.querySelector(`.af-node[data-state="${be.to}"] .circle`);
      if (!fromEl || !toEl) continue;
      const f = fromEl.getBoundingClientRect();
      const t = toEl.getBoundingClientRect();
      const x1 = f.left + f.width / 2 - wr.left;
      const x2 = t.left + t.width / 2 - wr.left;
      const yTop = f.top - wr.top;
      const apex = Math.max(8, yTop - 40);
      const midX = (x1 + x2) / 2;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'arc');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M ${x1} ${yTop} C ${x1} ${apex}, ${x2} ${apex}, ${x2} ${yTop}`);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', '#caa54a');
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('stroke-dasharray', '5 4');
      p.setAttribute('marker-end', 'url(#af-ah)');
      const txt = document.createElementNS(NS, 'text');
      txt.setAttribute('x', String(midX));
      txt.setAttribute('y', String(apex + 4));
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('fill', '#9a6a00');
      txt.setAttribute('font-family', 'Spline Sans Mono, monospace');
      txt.setAttribute('font-size', '11');
      txt.textContent = `↩ ${be.label}`;
      g.appendChild(p);
      g.appendChild(txt);
      svgEl.appendChild(g);
    }
  }

  // Redraw whenever the run's back-edges change, and on resize.
  $effect(() => {
    void backEdges;
    void nodes;
    requestAnimationFrame(drawArcs);
  });
</script>

<svelte:window onresize={drawArcs} />

<div class="af-sm-wrap" bind:this={wrapEl}>
  <svg class="af-sm-arcs" bind:this={svgEl} aria-hidden="true">
    <defs>
      <marker id="af-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#9a6a00"></path>
      </marker>
    </defs>
  </svg>
  <div class="af-stepper">
    {#each nodes as n, i (n.state)}
      <div class="af-node {n.status}" data-state={n.state}>
        <div class="circle">{n.status === 'done' ? '✓' : i + 1}</div>
        <div class="lbl"><div class="n">{n.label}</div><div class="m">{stageMeta[n.state] ?? '—'}</div></div>
      </div>
      {#if i < nodes.length - 1}
        <div class="af-seg" class:done={n.status === 'done'}></div>
      {/if}
    {/each}
  </div>
</div>

<div class="af-sm-foot">
  <span class="it"><b>terminal</b> {humanizeState(fsm.forwardOrder.find((s) => fsm.states[s]?.terminal) ?? 'done')}</span>
  <span class="it"><b>escalation</b> {humanizeState(fsm.escalationState)}</span>
  {#if escalated}
    <span class="be">⚠ escalated to {humanizeState(fsm.escalationState)}</span>
  {/if}
  {#if backEdges.length}
    {#each backEdges as be (be.from + be.to)}
      <span class="be">↩ back-edge · {be.from} → {be.to} ({be.label})</span>
    {/each}
  {:else}
    <span class="it" style="color:var(--ink4)">no back-edges traversed</span>
  {/if}
</div>

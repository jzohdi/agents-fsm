<script lang="ts">
  /**
   * The global operator-context settings surface (issue #5, Layers 1–2): a compact disclosure below the
   * new-run bar with one editor for the global base context and one per stage type. Layer 3 (per-run)
   * lives on the run inspector instead. State comes from `ui.contextGlobal` / `ui.contextStages`
   * (hydrated by `loadSettings`); edits persist optimistically through the store actions.
   */
  import { ui, setGlobalContext, setStageContext } from './store.svelte';
  import { humanizeState } from './render';
  import ContextEditor from './ContextEditor.svelte';

  // The canonical FSM stages an operator may attach per-stage context to (mirrors the daemon's
  // CONTEXT_STAGE_TYPES in src/agent/harness.ts; pseudo-stages are excluded — they still get layers 1 & 3).
  const STAGES = ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend', 'code_review'];

  let open = $state(false);
  // How many layers currently carry text — a quiet count on the toggle so it's discoverable.
  const active = $derived((ui.contextGlobal?.trim() ? 1 : 0) + Object.values(ui.contextStages).filter((v) => v.trim()).length);
</script>

<section class="af-ctxset">
  <button type="button" class="toggle" class:open onclick={() => (open = !open)} aria-expanded={open}>
    <span class="arr">▸</span> Custom context
    {#if active > 0}<span class="badge">{active}</span>{/if}
    <span class="sub">reusable prompt guidance injected into agents</span>
  </button>

  {#if open}
    <div class="body">
      <p class="blurb">
        Standing instructions the fleet appends to every agent, labeled as operator-provided context. Composes
        <b>global → stage → run</b>; empty layers are skipped. Large blocks cost tokens on every invocation.
      </p>

      <ContextEditor
        label="Global base"
        hint="every agent, every stage"
        value={ui.contextGlobal}
        placeholder="e.g. Always prefer the simplest change that satisfies the contract (KISS)."
        onsave={(text) => setGlobalContext(text)}
      />

      <div class="stages">
        <div class="stages-head">Per stage</div>
        {#each STAGES as stage (stage)}
          <ContextEditor
            label={humanizeState(stage)}
            value={ui.contextStages[stage] ?? null}
            placeholder={`Applied to every ${humanizeState(stage)} run…`}
            onsave={(text) => setStageContext(stage, text)}
          />
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .af-ctxset {
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 16px;
    border-top: 1px solid var(--rule);
  }
  .toggle {
    display: flex;
    align-items: baseline;
    gap: 9px;
    width: 100%;
    padding: 9px 0;
    background: none;
    border: none;
    color: var(--ink);
    font-family: var(--ui);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .arr {
    display: inline-block;
    transition: transform 0.12s ease;
    color: var(--ink3);
  }
  .toggle.open .arr {
    transform: rotate(90deg);
  }
  .badge {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    color: var(--accent);
  }
  .sub {
    font-weight: 400;
    font-size: 12px;
    color: var(--ink3);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 4px 0 16px;
  }
  .blurb {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink2);
  }
  .stages {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .stages-head {
    font-family: var(--mono);
    font-size: 9.5px;
    font-weight: 600;
    color: var(--ink3);
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
</style>

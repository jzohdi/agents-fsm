<script lang="ts">
  /**
   * A labeled operator-context editor (issue #5): a `<textarea>` plus Save / Clear, shared by all three
   * context layers (global, per-stage, per-run) the way `ModelPicker` / `EffortSelect` are shared. The
   * parent owns persistence — this only edits a draft and calls `onsave` with the new text, or `null` on
   * Clear (which the daemon treats as "unset"). Kept quiet and unobtrusive: standing guidance you set
   * once, not an action you reach for.
   */
  interface Props {
    /** Field label (e.g. "Global base", "frontend", "This run"). */
    label: string;
    /** Optional one-line hint under the label. */
    hint?: string;
    /** The persisted value, or `null` when unset. Editing starts from this. */
    value: string | null;
    /** Placeholder for the empty textarea. */
    placeholder?: string;
    /** Persist the draft (`null` when cleared). */
    onsave: (text: string | null) => void;
  }

  let { label, hint, value, placeholder = 'Standing guidance for the agent…', onsave }: Props = $props();

  // Local draft, re-seeded whenever the persisted value changes (e.g. after a save reflects the server
  // value, or the selected run switches). Tracking the last-seen prop in the effect keeps the draft in
  // sync without clobbering an in-progress edit on unrelated store updates.
  let draft = $state('');
  let seeded = $state<string | null | undefined>(undefined);
  $effect(() => {
    if (value !== seeded) {
      seeded = value;
      draft = value ?? '';
    }
  });

  const trimmed = $derived(draft.trim());
  const persisted = $derived((value ?? '').trim());
  const dirty = $derived(trimmed !== persisted);

  function save(): void {
    onsave(trimmed ? draft : null); // blank draft clears the layer
  }
  function clear(): void {
    draft = '';
    onsave(null);
  }
</script>

<div class="af-ctx">
  <div class="af-ctx-head">
    <span class="lbl">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </div>
  <textarea
    bind:value={draft}
    {placeholder}
    rows="3"
    aria-label={`operator context — ${label}`}
    spellcheck="false"
  ></textarea>
  <div class="af-ctx-actions">
    <button type="button" class="save" disabled={!dirty} onclick={save}>Save</button>
    <button type="button" class="clear" disabled={!persisted} onclick={clear}>Clear</button>
  </div>
</div>

<style>
  .af-ctx {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .af-ctx-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .lbl {
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink3);
  }
  .hint {
    font-size: 11px;
    color: var(--ink3);
  }
  textarea {
    width: 100%;
    resize: vertical;
    font-family: var(--ui);
    font-size: 12px;
    line-height: 1.5;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--rule2);
    background: var(--paper2);
    color: var(--ink);
    box-sizing: border-box;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
    background: #fff;
  }
  .af-ctx-actions {
    display: flex;
    gap: 6px;
  }
  button {
    font-family: var(--mono);
    font-size: 11px;
    padding: 3px 11px;
    border-radius: 5px;
    border: 1px solid var(--rule2);
    background: var(--paper);
    color: var(--ink2);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--ink3);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.save:not(:disabled) {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
  }
</style>

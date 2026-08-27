<script lang="ts">
  /**
   * Per-run operator context (issue #5, Layer 3) as a quiet disclosure for the run header: a one-line
   * chip that shows at a glance whether the run carries standing guidance (accent pip + a preview of
   * it), expanding in place into a bordered editor strip — kin of the Revert panel, not a floating
   * form. The parent owns persistence: this edits a draft and calls `onsave` with the new text, or
   * `null` on Clear (the daemon treats that as "unset"). Distinct from the shared `ContextEditor`
   * (settings page), where an always-open stacked form is the right shape.
   */
  import { tick } from 'svelte';

  interface Props {
    /** The persisted run context, or `null` when unset. Editing starts from this. */
    value: string | null;
    /** Collapse the editor when this changes (the selected run switched). */
    resetKey?: unknown;
    /** Persist the draft (`null` when cleared). */
    onsave: (text: string | null) => void;
  }

  let { value, resetKey, onsave }: Props = $props();

  let open = $state(false);
  let box = $state<HTMLTextAreaElement | undefined>(undefined);

  // Local draft, re-seeded whenever the persisted value changes (a save echoing back from the
  // server, or another session editing the same run) — without clobbering an in-progress edit on
  // unrelated store updates.
  let draft = $state('');
  let seeded = $state<string | null | undefined>(undefined);
  $effect(() => {
    if (value !== seeded) {
      seeded = value;
      draft = value ?? '';
    }
  });
  // Compare by value, not signal: a detail refetch replaces the run object (same id), which would
  // re-fire a plain `void resetKey` effect and collapse the editor mid-interaction.
  let lastKey = $state<unknown>(undefined);
  $effect(() => {
    if (resetKey !== lastKey) {
      lastKey = resetKey;
      open = false;
    }
  });

  const persisted = $derived((value ?? '').trim());
  const trimmed = $derived(draft.trim());
  const dirty = $derived(trimmed !== persisted);
  // One-line chip preview of the saved guidance, whitespace collapsed.
  const preview = $derived(persisted.replace(/\s+/g, ' '));

  async function toggle(): Promise<void> {
    open = !open;
    if (open) {
      await tick();
      box?.focus();
      box?.setSelectionRange(draft.length, draft.length); // cursor at the end, ready to append
    }
  }
  function save(): void {
    if (!dirty) return;
    onsave(trimmed ? draft : null); // blank draft clears the layer
    open = false;
  }
  function clear(): void {
    draft = '';
    if (persisted) onsave(null);
    box?.focus();
  }
  function onKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      draft = value ?? ''; // discard the edit
      open = false;
    }
  }
</script>

<div class="rc" class:open>
  <button type="button" class="chip" aria-expanded={open} onclick={toggle}>
    <span class="lbl"><span class="pip" class:on={!!persisted} aria-hidden="true"></span>Run context</span>
    {#if open}
      <span class="hint">appended to this run's agents · next stage on</span>
    {:else if persisted}
      <span class="prev" title={persisted}>{preview}</span>
    {:else}
      <span class="prev empty">add guidance for this run's agents…</span>
    {/if}
    {#if dirty && !open}
      <span class="draftdot" title="unsaved draft — reopen to finish"></span>
    {/if}
    <span class="caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
  </button>

  {#if open}
    <div class="panel">
      <textarea
        bind:this={box}
        bind:value={draft}
        rows="4"
        placeholder="e.g. the backend agent should add a DB index for issue #42…"
        aria-label="run context — appended to this run's agents"
        spellcheck="false"
        onkeydown={onKeydown}
      ></textarea>
      <div class="foot">
        <span class="keys">⌘↵ save · esc close</span>
        {#if persisted}
          <button type="button" class="ghost" onclick={clear}>Clear</button>
        {/if}
        <button type="button" class="save" disabled={!dirty} onclick={save}>Save</button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Closed: a quiet, borderless row that only reveals chrome on hover. Open: the whole control
     draws itself into one bordered strip (chip = header, editor beneath), like the revert panel. */
  .rc {
    width: 100%;
    border: 1px solid transparent;
    border-radius: 2px;
    transition: border-color 0.12s, background 0.12s, box-shadow 0.12s;
  }
  .rc.open {
    border-color: var(--rule2);
    background: var(--paper2);
    box-shadow: 0 12px 28px -22px rgba(27, 26, 22, 0.5);
  }
  .rc.open:focus-within {
    border-color: var(--accent-line);
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 11px;
    border: 0;
    border-radius: 2px;
    background: none;
    cursor: pointer;
    text-align: left;
    font-family: var(--ui);
  }
  .rc:not(.open) .chip:hover {
    background: var(--paper2);
  }

  .lbl {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink3);
    white-space: nowrap;
  }
  .pip {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid var(--ink4);
    background: transparent;
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
  }
  .pip.on {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .prev {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--ink2);
  }
  .prev.empty {
    color: var(--ink4);
  }
  .hint {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--ink4);
  }
  .draftdot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--amber);
  }
  .caret {
    flex: 0 0 auto;
    font-size: 8.5px;
    color: var(--ink4);
  }

  .panel {
    border-top: 1px solid var(--rule);
    animation: rc-rise 0.18s both;
  }
  @keyframes rc-rise {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }

  textarea {
    display: block;
    width: 100%;
    min-height: 84px;
    resize: vertical;
    border: 0;
    background: transparent;
    padding: 10px 12px;
    font-family: var(--ui);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--ink);
  }
  textarea:focus {
    outline: none;
  }
  textarea::placeholder {
    color: var(--ink4);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px 7px 12px;
    border-top: 1px solid var(--rule);
  }
  .keys {
    margin-right: auto;
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    color: var(--ink4);
    white-space: nowrap;
  }
  .ghost {
    border: 0;
    border-radius: 2px;
    background: none;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink3);
    padding: 6px 10px;
    transition: color 0.12s, background 0.12s;
  }
  .ghost:hover {
    color: var(--rose);
    background: var(--rose-soft);
  }
  .save {
    border: 0;
    border-radius: 2px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    padding: 6px 16px;
    transition: background 0.12s, color 0.12s, opacity 0.12s;
  }
  .save:hover:not(:disabled) {
    background: #19623f;
  }
  .save:disabled {
    background: var(--accent-soft);
    color: var(--accent);
    opacity: 0.55;
    cursor: default;
  }
</style>

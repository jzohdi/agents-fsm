<script lang="ts">
  /**
   * A searchable model picker (combobox) shared by the new-run bar and the run inspector. It renders a
   * compact trigger and, on click, a popover with a type-ahead search, provider brand marks, a relative
   * cost tier (dollar signs), and a "Recommended" shortlist — so a long harness catalog (Cursor lists
   * dozens of models across providers) stays scannable rather than an overwhelming flat `<select>`.
   *
   * It is presentation-only: it owns no catalog and no network. The parent passes the catalog + current
   * value and receives the pick via `onselect(id | null)` (null = clear back to the harness default), so
   * the same component drives both a pre-start pick (bar) and a live per-run override (inspector). The
   * list/filter/nav logic lives in the pure {@link ./model-picker} module (unit-tested there); this file
   * is just the view + interaction wiring.
   */
  import { buildRows, nextSelectable, selectedIndex, type PickerRow } from './model-picker';
  import { PROVIDER_LOGOS } from './provider-logos';
  import type { HarnessModel } from './types';

  interface Props {
    /** The harness's selectable models, in catalog order. */
    models: HarnessModel[];
    /** The currently-selected model id, or `null` for the harness default. */
    value: string | null;
    /** The harness default's id/label, shown on the "Default" row (purely informational). */
    defaultLabel?: string | null;
    /** Called with the chosen id, or `null` when the "Default" row is picked. */
    onselect: (id: string | null) => void;
    /** Disable the trigger (e.g. a terminal run). */
    disabled?: boolean;
    /** Accessible label for the trigger. */
    ariaLabel?: string;
  }

  let { models, value, defaultLabel = null, onselect, disabled = false, ariaLabel = 'model' }: Props = $props();

  let open = $state(false);
  let query = $state('');
  let activeIdx = $state(0);
  let searchEl = $state<HTMLInputElement | null>(null);

  const selected = $derived(models.find((m) => m.id === value) ?? null);
  // The flat popover rows (default row, "Recommended", then grouped models) — a row's position is its
  // nav index, so highlighting and arrow-keys need no index math (see ./model-picker).
  const rows = $derived(buildRows(models, query));
  const hasMatches = $derived(rows.some((r) => r.kind === 'model'));

  function openPanel() {
    if (disabled) return;
    open = true;
    query = '';
    activeIdx = selectedIndex(buildRows(models, ''), value); // highlight the current pick on open
    queueMicrotask(() => searchEl?.focus()); // focus the search box once the panel is in the DOM
  }

  function pickRow(row: PickerRow | undefined) {
    if (!row || row.kind === 'header') return;
    onselect(row.kind === 'model' ? row.model.id : null);
    open = false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = nextSelectable(rows, activeIdx, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = nextSelectable(rows, activeIdx, -1);
    } else if (e.key === 'Enter') {
      // Also stops the surrounding form (the new-run bar) from submitting on Enter-in-search.
      e.preventDefault();
      pickRow(rows[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      open = false;
    }
  }
</script>

{#snippet costTier(cost: number | undefined)}
  {#if cost}
    <span class="cost" title="relative cost">
      {#each [1, 2, 3, 4] as n (n)}<span class:on={n <= cost}>$</span>{/each}
    </span>
  {/if}
{/snippet}

<!-- The provider's brand logo (real SVG), or a monogram chip for a provider we have no mark for. -->
{#snippet brand(provider: string | undefined, label: string)}
  {@const logo = provider ? PROVIDER_LOGOS[provider] : undefined}
  {#if logo}
    <span class="logo" title={provider} aria-hidden="true">
      <svg viewBox={logo.viewBox} width="15" height="15">
        {#each logo.paths as p (p.d)}<path d={p.d} fill={p.fill} />{/each}
      </svg>
    </span>
  {:else}
    <span class="logo mono" title={provider} aria-hidden="true">{(label[0] ?? '?').toUpperCase()}</span>
  {/if}
{/snippet}

<div class="af-mp" class:open>
  <button
    type="button"
    class="af-mp-trigger"
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    {disabled}
    onclick={() => (open ? (open = false) : openPanel())}
  >
    {#if selected}
      {@render brand(selected.provider, selected.label)}
      <span class="tlbl">{selected.label}</span>
    {:else}
      <span class="logo def" aria-hidden="true">✦</span>
      <span class="tlbl">Default</span>
    {/if}
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="af-mp-panel" onkeydown={onKeydown}>
      <div class="af-mp-search">
        <span class="ic" aria-hidden="true">⌕</span>
        <input
          bind:this={searchEl}
          bind:value={query}
          placeholder="Search models…"
          aria-label="search models"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="af-mp-list" role="listbox" aria-label={ariaLabel} tabindex="-1">
        {#each rows as row, i (i)}
          {#if row.kind === 'header'}
            <div class="af-mp-grp">{row.label}</div>
          {:else}
            {@const isSel = row.kind === 'model' ? row.model.id === value : value === null}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="af-mp-opt"
              class:act={i === activeIdx}
              class:sel={isSel}
              role="option"
              aria-selected={isSel}
              tabindex="-1"
              onclick={() => pickRow(row)}
              onmouseenter={() => (activeIdx = i)}
            >
              {#if row.kind === 'model'}
                {@render brand(row.model.provider, row.model.label)}
                <span class="meta"><span class="lbl">{row.model.label}</span><span class="sub">{row.model.id}</span></span>
                {@render costTier(row.model.cost)}
              {:else}
                <span class="logo def" aria-hidden="true">✦</span>
                <span class="meta"><span class="lbl">Harness default</span>{#if defaultLabel}<span class="sub">{defaultLabel}</span>{/if}</span>
              {/if}
              <span class="chk" aria-hidden="true">{isSel ? '✓' : ''}</span>
            </div>
          {/if}
        {/each}
        {#if !hasMatches}
          <div class="af-mp-none">No models match “{query.trim()}”.</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<svelte:window onclick={(e) => { if (open && !(e.target as HTMLElement).closest('.af-mp')) open = false; }} />

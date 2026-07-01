<script lang="ts">
  import { ui, startRun, fetchSuggestions, setDefaultHarness } from './store.svelte';
  import { humanizeHarness } from './render';
  import type { Suggestion } from './types';

  let value = $state('');
  let open = $state(false);
  let activeIdx = $state(-1);
  let busy = $state(false);
  let suggestions = $state<Suggestion[]>([]);
  // The last failed start's message, shown inline until the operator edits the input (so the daemon's
  // reason — a malformed ref, or a cross-repo / wrong-repo mismatch — is never silently swallowed).
  let error = $state<string | null>(null);

  // Debounced, race-guarded fetch of GitHub suggestions for the current query.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  function refresh() {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const mine = ++seq;
      const items = await fetchSuggestions(value);
      if (mine === seq && open) {
        suggestions = items;
        activeIdx = -1;
      }
    }, 160);
  }

  // Split the suggestions into repos (shown first, picking one narrows to its issues) and issues
  // (grouped by repo). `flat` is the exact rendered order, so keyboard nav lines up with the list.
  const repos = $derived(suggestions.filter((s) => s.kind === 'repo'));
  const issueGroups = $derived.by(() => {
    const m = new Map<string, Suggestion[]>();
    for (const s of suggestions) {
      if (s.kind !== 'issue') continue;
      (m.get(s.repo) ?? m.set(s.repo, []).get(s.repo)!).push(s);
    }
    return [...m.entries()];
  });
  const flat = $derived([...repos, ...issueGroups.flatMap(([, items]) => items)]);

  function refParts(ref: string): { repo: string; num: string } {
    const i = ref.indexOf('#');
    return i >= 0 ? { repo: ref.slice(0, i), num: ref.slice(i) } : { repo: ref, num: '' };
  }

  async function submit(e?: Event) {
    e?.preventDefault();
    const ref = value.trim();
    if (!ref || busy) return;
    busy = true;
    error = null;
    try {
      await startRun(ref);
      value = '';
      open = false;
    } catch (err) {
      // Show the daemon's reason inline and close the suggestions so it isn't hidden behind them.
      error = (err as Error).message;
      open = false;
    } finally {
      busy = false;
    }
  }

  // Picking a repo narrows the type-ahead to that repo's issues (keeps the dropdown open + re-queries);
  // picking an issue fills the full ref, ready to start.
  function choose(s: Suggestion) {
    value = s.ref;
    if (s.kind === 'repo') {
      open = true;
      activeIdx = -1;
      refresh();
    } else {
      open = false;
      activeIdx = -1;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open || flat.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(flat.length - 1, activeIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      choose(flat[activeIdx]!);
    } else if (e.key === 'Escape') {
      open = false;
    }
  }
</script>

<svelte:window onclick={(e) => { if (!(e.target as HTMLElement).closest('.af-filebar')) open = false; }} />

<section class="af-filebar">
  <form class="af-wrap inner" onsubmit={submit}>
    <span class="lab"><span class="arr">▸</span> File a new run</span>
    <input
      bind:value
      onfocus={() => { open = true; refresh(); }}
      oninput={() => { open = true; error = null; refresh(); }}
      onkeydown={onKeydown}
      placeholder="owner/repo#123 — start typing to search your repos &amp; issues"
      autocomplete="off"
      aria-label="issue reference"
    />
    {#if ui.harnesses.length > 1}
      <!-- Unified control: this is both the runtime selector and the persisted default, and the harness
           the run is stamped with on submit. Changing it persists via PUT /settings/default-harness. -->
      <label class="af-harness" title="Harness for new runs (remembered as the default)">
        <span class="hlab">harness</span>
        <select
          value={ui.defaultHarness ?? ''}
          onchange={(e) => setDefaultHarness(e.currentTarget.value)}
          aria-label="harness for new runs"
        >
          {#each ui.harnesses as h (h)}<option value={h}>{humanizeHarness(h)}</option>{/each}
        </select>
      </label>
    {/if}
    <button type="submit" class="file-btn" disabled={!value.trim() || busy}>{busy ? 'Starting…' : 'Start run'}</button>
  </form>

  {#if error}
    <div class="af-runerr" role="alert">✖ {error}</div>
  {/if}

  {#if open && value.trim() !== ''}
    <div class="af-ac">
      {#if flat.length === 0}
        <div class="none">No matching repos or issues — press <b>Start run</b> to file <code>{value.trim()}</code> anyway.</div>
      {:else}
        {#if repos.length > 0}
          <div class="grp">Repositories · {repos.length}</div>
          {#each repos as s (s.ref)}
            <div
              class="opt"
              class:act={flat.indexOf(s) === activeIdx}
              onclick={() => choose(s)}
              onkeydown={(e) => { if (e.key === 'Enter') choose(s); }}
              onmouseenter={() => (activeIdx = flat.indexOf(s))}
              role="option"
              aria-selected={flat.indexOf(s) === activeIdx}
              tabindex="-1"
            >
              <span class="ref">{s.ref}</span>
              <span class="t">{s.title}</span>
              <span class="tag">repo</span>
            </div>
          {/each}
        {/if}
        {#each issueGroups as [repo, items] (repo)}
          <div class="grp">{repo} · {items.length}</div>
          {#each items as s (s.ref)}
            {@const p = refParts(s.ref)}
            <div
              class="opt"
              class:act={flat.indexOf(s) === activeIdx}
              onclick={() => choose(s)}
              onkeydown={(e) => { if (e.key === 'Enter') choose(s); }}
              onmouseenter={() => (activeIdx = flat.indexOf(s))}
              role="option"
              aria-selected={flat.indexOf(s) === activeIdx}
              tabindex="-1"
            >
              <span class="ref">{p.repo}<b>{p.num}</b></span>
              <span class="t">{s.title}</span>
              <span class="tag">issue</span>
            </div>
          {/each}
        {/each}
      {/if}
    </div>
  {/if}
</section>

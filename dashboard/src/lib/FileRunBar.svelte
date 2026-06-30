<script lang="ts">
  import { startRun, fetchSuggestions } from './store.svelte';
  import type { IssueSuggestion } from './types';

  let value = $state('');
  let open = $state(false);
  let activeIdx = $state(-1);
  let busy = $state(false);
  let suggestions = $state<IssueSuggestion[]>([]);
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

  // group by repo for the dropdown headers
  const groups = $derived.by(() => {
    const m = new Map<string, IssueSuggestion[]>();
    for (const s of suggestions) (m.get(s.repo) ?? m.set(s.repo, []).get(s.repo)!).push(s);
    return [...m.entries()];
  });

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

  function choose(ref: string) {
    value = ref;
    open = false;
    activeIdx = -1;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(suggestions.length - 1, activeIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      choose(suggestions[activeIdx]!.ref);
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
    <button type="submit" class="file-btn" disabled={!value.trim() || busy}>{busy ? 'Starting…' : 'Start run'}</button>
  </form>

  {#if error}
    <div class="af-runerr" role="alert">✖ {error}</div>
  {/if}

  {#if open && value.trim() !== ''}
    <div class="af-ac">
      {#if suggestions.length === 0}
        <div class="none">No matching open issues — press <b>Start run</b> to file <code>{value.trim()}</code> anyway.</div>
      {:else}
        {#each groups as [repo, items] (repo)}
          <div class="grp">{repo} · {items.length}</div>
          {#each items as s (s.ref)}
            {@const p = refParts(s.ref)}
            <div
              class="opt"
              class:act={suggestions.indexOf(s) === activeIdx}
              onclick={() => choose(s.ref)}
              onkeydown={(e) => { if (e.key === 'Enter') choose(s.ref); }}
              onmouseenter={() => (activeIdx = suggestions.indexOf(s))}
              role="option"
              aria-selected={suggestions.indexOf(s) === activeIdx}
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

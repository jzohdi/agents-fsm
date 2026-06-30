<!--
  A fixed-height scroll area that stays pinned to the latest item as content streams in, with a manual
  override: scrolling up pauses the auto-scroll (and reveals a "jump to latest" button); scrolling back
  to the bottom resumes it. Content growth is detected with a MutationObserver, so callers just render
  their list inside — no need to thread item counts through. `resetKey` re-pins when it changes (e.g.
  switching runs). The at-bottom test is the pure, unit-tested `isAtBottom` in render.ts.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { isAtBottom } from './render';

  let { height = '260px', resetKey = undefined, children }:
    { height?: string; resetKey?: unknown; children: Snippet } = $props();

  let body = $state<HTMLDivElement | undefined>(undefined);
  let pinned = $state(true);

  function toEnd(): void {
    if (body) body.scrollTop = body.scrollHeight;
  }
  function onScroll(): void {
    if (body) pinned = isAtBottom(body.scrollTop, body.clientHeight, body.scrollHeight);
  }
  function jump(): void {
    pinned = true;
    toEnd();
  }

  // Re-pin to the latest whenever the keyed content changes (a new run's detail loads).
  $effect(() => {
    void resetKey;
    pinned = true;
    toEnd();
  });

  // Auto-scroll on content growth while pinned (new transitions / artifacts / activity stream in).
  $effect(() => {
    const node = body;
    if (!node) return;
    const obs = new MutationObserver(() => { if (pinned) toEnd(); });
    obs.observe(node, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  });
</script>

<div class="af-scrollarea" style="--af-sa-h: {height}">
  <div class="af-sa-body" bind:this={body} onscroll={onScroll}>{@render children()}</div>
  {#if !pinned}
    <button type="button" class="af-sa-jump" onclick={jump}>↓ latest</button>
  {/if}
</div>

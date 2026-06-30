<script lang="ts">
  import { fsmGraphSvg } from './render';
  import type { FsmConfig } from './types';

  let { fsm, currentState }: { fsm: FsmConfig; currentState: string } = $props();
  const svg = $derived(fsmGraphSvg(fsm, currentState));
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags — svg is built from config by the pure, tested
     fsmGraphSvg, which escapes all interpolated text; no user-controlled HTML reaches it. -->
<div class="af-graph">{@html svg}</div>

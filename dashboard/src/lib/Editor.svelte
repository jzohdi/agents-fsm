<script lang="ts">
  import { ui, saveConfig } from './store.svelte';

  let text = $state('');
  let msg = $state<{ text: string; kind: 'ok' | 'err' } | null>(null);
  let loaded = false;

  function load() {
    if (!ui.config) return;
    const { fsm, agents } = ui.config;
    text = JSON.stringify({ ...fsm, agents }, null, 2);
    msg = null;
  }

  // Populate the editor once the config has loaded (App fetches it asynchronously).
  $effect(() => {
    if (ui.config && !loaded) {
      loaded = true;
      load();
    }
  });

  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      msg = { text: `Invalid JSON: ${(err as Error).message}`, kind: 'err' };
      return;
    }
    const result = await saveConfig(parsed);
    msg = { text: result.msg, kind: result.ok ? 'ok' : 'err' };
  }
</script>

<h2>FSM config</h2>
<p class="af-hint">
  Edit states, transitions, back-edges, and guard limits. Saving validates server-side and applies to
  <em>new</em> runs; it is refused while any run is in flight (pause/stop or let runs finish first).
</p>
<textarea class="af-config" bind:value={text} spellcheck="false" aria-label="FSM config JSON"></textarea>
<div class="af-editor-actions">
  <button type="button" onclick={save}>Save config</button>
  <button type="button" class="af-secondary" onclick={load}>Reload</button>
  {#if msg}<span class="af-config-msg af-{msg.kind}">{msg.text}</span>{/if}
</div>

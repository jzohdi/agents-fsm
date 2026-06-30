<script lang="ts">
  import { ui, selectRun } from './store.svelte';
  import { runsTableModel } from './render';

  const rows = $derived(runsTableModel(ui.runs));
</script>

<aside class="af-sidebar">
  <h2>Runs</h2>
  <table class="af-runs">
    <thead>
      <tr><th>#</th><th>issue</th><th>state</th><th>status</th><th class="af-num">tok</th></tr>
    </thead>
    <tbody>
      {#if rows.length === 0}
        <tr><td colspan="5" class="af-empty">No runs yet.</td></tr>
      {/if}
      {#each rows as r (r.id)}
        <tr class:af-selected={r.id === ui.selectedId} onclick={() => selectRun(r.id)}>
          <td>{r.id}</td>
          <td>{r.issue}</td>
          <td>{r.state}</td>
          <td><span class={r.statusClass}>{r.status}</span></td>
          <td class="af-num">{r.tokens}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</aside>

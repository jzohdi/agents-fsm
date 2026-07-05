<script lang="ts">
  // Multi-repo tabs strip (Milestone 8 Phase A): an "All" tab plus one per repo that has runs, each
  // showing its active count and a ⚠ escalation count. Clicking a tab scopes the board (client-side).
  // The trailing "+" enrolls a new repo (POST /repos) so runs can then target it.
  import { ui, setRepoFilter, enrollRepo } from './store.svelte';
  import { repoOverviewModel } from './render';

  const summaries = $derived(repoOverviewModel(ui.runs));
  // "All" is only meaningful with more than one repo — with a single repo it would just duplicate it.
  const showAll = $derived(summaries.length > 1);
  const allActive = $derived(summaries.reduce((n, s) => n + s.active, 0));
  const allWarn = $derived(summaries.reduce((n, s) => n + s.needsHuman, 0));

  let enrolling = $state(false);
  let repoRef = $state('');
  let baseBranch = $state('');

  async function submitEnroll(): Promise<void> {
    if (!repoRef.trim()) return;
    if (await enrollRepo(repoRef.trim(), baseBranch)) {
      repoRef = '';
      baseBranch = '';
      enrolling = false;
    }
  }
</script>

<section class="af-repos">
  <div class="af-wrap af-repotabs">
    {#if showAll}
      <button type="button" class="af-repotab" class:on={ui.repoFilter === null} onclick={() => setRepoFilter(null)}>
        <span class="nm">All</span>
        <span class="ct">{allActive}</span>
        {#if allWarn > 0}<span class="warn">{allWarn}⚠</span>{/if}
      </button>
    {/if}
    {#each summaries as s (s.repoRef)}
      <!-- The owner prefix is de-emphasized (and dropped entirely on phones — the title keeps the
           full ref): the repo name is what the operator scans for. -->
      {@const slash = s.repoRef.indexOf('/')}
      <button type="button" class="af-repotab" class:on={ui.repoFilter === s.repoRef} title={s.repoRef} onclick={() => setRepoFilter(s.repoRef)}>
        <span class="nm">{#if slash > 0}<span class="own">{s.repoRef.slice(0, slash + 1)}</span>{s.repoRef.slice(slash + 1)}{:else}{s.repoRef}{/if}</span>
        <span class="ct">{s.active}</span>
        {#if s.needsHuman > 0}<span class="warn">{s.needsHuman}⚠</span>{/if}
      </button>
    {/each}
    <button type="button" class="af-repoadd" class:on={enrolling} title="Enroll a repo" onclick={() => (enrolling = !enrolling)}>+</button>
  </div>

  {#if enrolling}
    <div class="af-wrap af-enroll">
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" placeholder="owner/repo" bind:value={repoRef} autofocus
        onkeydown={(e) => { if (e.key === 'Enter') submitEnroll(); }} />
      <input type="text" placeholder="base branch (default main)" bind:value={baseBranch}
        onkeydown={(e) => { if (e.key === 'Enter') submitEnroll(); }} />
      <button type="button" class="af-enroll-go" onclick={submitEnroll}>Enroll</button>
      <button type="button" class="af-ghost" onclick={() => (enrolling = false)}>Cancel</button>
    </div>
  {/if}
</section>

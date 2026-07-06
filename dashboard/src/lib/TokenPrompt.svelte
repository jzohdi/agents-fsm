<script lang="ts">
  // Token prompt overlay (issue #25): shown when the daemon returns a 401 (`ui.authRequired`). The
  // static SPA is served open, so this renders even though every data load failed. Submitting stores
  // the token and re-drives the startup loads + the live stream (`authenticate`); a fresh 401 keeps
  // the overlay up. "Forget token" clears a stored (stale) token so a different one can be entered.
  import { ui, authenticate, signOut } from './store.svelte';
  import { getToken } from './auth';

  let token = $state(getToken() ?? '');
  let submitting = $state(false);

  async function submit(): Promise<void> {
    if (!token.trim() || submitting) return;
    submitting = true;
    try {
      await authenticate(token.trim());
    } finally {
      submitting = false;
    }
  }
</script>

<div class="af-authgate" role="dialog" aria-modal="true" aria-label="API token required">
  <div class="af-authcard">
    <div class="af-eyebrow">Authentication</div>
    <h2>This daemon requires an API token</h2>
    <p>
      The orchestrator is protected by a shared secret (<code>FLEET_API_TOKEN</code>). Paste it below to
      connect — it's stored in this browser only.
    </p>
    <div class="af-enroll">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="password"
        placeholder="API token"
        bind:value={token}
        autofocus
        autocomplete="off"
        onkeydown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <button type="button" class="af-enroll-go" disabled={submitting || !token.trim()} onclick={submit}>
        {submitting ? 'Connecting…' : 'Connect'}
      </button>
      <button type="button" class="af-ghost" onclick={signOut}>Forget token</button>
    </div>
  </div>
</div>

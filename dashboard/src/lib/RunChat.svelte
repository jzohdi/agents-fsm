<script lang="ts">
  /**
   * Run chat — the operator's direct line to the selected run's agent (the "general chat" side
   * channel). Deliberately out of the way: a small floating launcher that expands into a dockable
   * thread. Prompts carry a permission grant — Ask (read-only, answers immediately even mid-stage)
   * or Work (read + write, held until the pipeline pauses, then edits + commits + pushes) — and the
   * composer says up front which of the two will happen. Exclusive to the selected run.
   */
  import { ui, sendChat, cancelChat, toggleChat, setChatMode } from './store.svelte';
  import { chatSchedulingHint, formatChatReply, fmtRelTime } from './render';
  import type { ChatExchange } from './types';

  const run = $derived(ui.detail?.run ?? null);
  const thread = $derived(ui.detail?.chat ?? []);
  // An older daemon's detail has no `chat` field — hide the dock rather than offer a dead composer.
  const supported = $derived(ui.detail !== null && ui.detail.chat !== undefined);
  const working = $derived(thread.some((c) => c.status === 'running'));
  const held = $derived(thread.filter((c) => c.status === 'queued').length);
  const hint = $derived(chatSchedulingHint(ui.chatMode, run?.status));

  let draft = $state('');
  let threadEl = $state<HTMLDivElement | undefined>(undefined);
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);

  // Follow the newest entry as prompts are sent and replies stream in.
  $effect(() => {
    void thread.length;
    void working;
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
  });
  // Hand focus to the composer whenever the dock opens.
  $effect(() => {
    if (ui.chatOpen && inputEl) inputEl.focus();
  });

  async function submit(): Promise<void> {
    if (await sendChat(draft, ui.chatMode)) draft = '';
  }

  function handleComposerKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function handlePanelKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') toggleChat(false);
  }

  function modeLabel(c: ChatExchange): string {
    if (c.mode === 'write') return 'read + write';
    return 'read-only';
  }

  function timeOf(c: ChatExchange): string {
    return fmtRelTime(c.finishedAt ?? c.startedAt ?? c.createdAt);
  }
</script>

{#if run && supported}
  {#if !ui.chatOpen}
    <button type="button" class="af-chat-launch" onclick={() => toggleChat(true)} title="Ask this run's agent a question, or hand it a task">
      <span class="dot" class:on={working} class:held={held > 0}></span>
      <span class="lab">agent chat</span>
      <span class="run">run {run.id}</span>
      {#if ui.chatUnread > 0}<span class="unread">{ui.chatUnread}</span>{/if}
    </button>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions — Escape-to-close convenience; the close button is the accessible control -->
    <aside class="af-chat" aria-label="run chat" onkeydown={handlePanelKeydown}>
      <header class="af-chat-head">
        <div>
          <span class="af-eyebrow">Run {run.id} · {run.issueRef}</span>
          <h3>Ask the agent</h3>
        </div>
        {#if working}
          <span class="af-chat-live"><span class="d"></span>working</span>
        {/if}
        <button type="button" class="min" onclick={() => toggleChat(false)} aria-label="minimize chat">—</button>
      </header>

      <div class="af-chat-thread" bind:this={threadEl}>
        {#if thread.length === 0}
          <div class="af-chat-empty">
            <p class="serif">A direct line to this run’s agent.</p>
            <p><b>Ask</b> answers questions right away — read-only, safe alongside a running stage.</p>
            <p><b>Work</b> hands it a task — it waits for the pipeline to pause, then edits, commits and pushes to this run’s branch.</p>
          </div>
        {/if}
        {#each thread as c (c.id)}
          <div class="af-chat-x" class:cancelled={c.status === 'cancelled'}>
            <div class="q">
              <span class="who">you · {modeLabel(c)}</span>
              <p>{c.prompt}</p>
            </div>
            {#if c.status === 'queued'}
              <div class="st queued">
                <span class="af-tag hold"><span class="pip"></span>holds until the pipeline pauses</span>
                <button type="button" class="x" onclick={() => cancelChat(c.id)} title="withdraw this prompt">withdraw</button>
              </div>
            {:else if c.status === 'running'}
              <div class="st running"><span class="af-cursor"></span>agent is working…</div>
            {:else if c.status === 'cancelled'}
              <div class="st"><span class="mut">withdrawn</span></div>
            {:else if c.status === 'error'}
              <div class="a err">
                <span class="who">agent · failed</span>
                <p>{c.error ?? 'the exchange failed'}</p>
              </div>
            {:else if c.response !== null}
              <div class="a">
                <span class="who">agent<span class="when"> · {timeOf(c)}</span></span>
                <!-- eslint-disable-next-line svelte/no-at-html-tags — formatChatReply escapes everything before promoting code/bold -->
                <div class="body">{@html formatChatReply(c.response)}</div>
                {#if c.commitSha}
                  <span class="commit" title="the agent's changes were committed and pushed to this run's branch">pushed <code>{c.commitSha.slice(0, 7)}</code></span>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <footer class="af-chat-compose">
        <div class="modes" role="radiogroup" aria-label="chat permissions">
          <button type="button" class:on={ui.chatMode === 'read'} onclick={() => setChatMode('read')} role="radio" aria-checked={ui.chatMode === 'read'}>
            Ask <span class="m">read-only</span>
          </button>
          <button type="button" class:on={ui.chatMode === 'write'} onclick={() => setChatMode('write')} role="radio" aria-checked={ui.chatMode === 'write'}>
            Work <span class="m">read + write</span>
          </button>
          <span class="hint">{hint}</span>
        </div>
        <div class="row">
          <textarea
            bind:this={inputEl}
            bind:value={draft}
            rows="2"
            placeholder={ui.chatMode === 'read' ? 'Ask about this run — the plan, the PR, a failure…' : 'Describe the task — e.g. “fix the failing build on the PR”'}
            aria-label="chat prompt"
            onkeydown={handleComposerKeydown}
          ></textarea>
          <button type="button" class="send" onclick={() => void submit()} disabled={!draft.trim() || ui.chatSending}>
            {#if ui.chatSending}…{:else}Send{/if}
          </button>
        </div>
      </footer>
    </aside>
  {/if}
{/if}

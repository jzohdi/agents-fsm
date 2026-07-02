<script lang="ts">
  /**
   * A compact reasoning-effort selector, shown next to the model picker only for a model that supports
   * effort (Claude Code's `--effort`). A plain native `<select>` — few options, fully accessible, no
   * popover needed. "Default" clears back to the model's own default effort. The parent decides whether to
   * render it (i.e. when `efforts` is non-empty) and where the pick goes.
   */
  interface Props {
    /** The supported levels for the current model, in ascending order (empty → the parent hides this). */
    efforts: string[];
    /** The current effort, or `null` for the model default. */
    value: string | null;
    /** Called with the chosen level, or `null` for the "Default" option. */
    onselect: (effort: string | null) => void;
    /** Accessible label. */
    ariaLabel?: string;
  }

  let { efforts, value, onselect, ariaLabel = 'reasoning effort' }: Props = $props();

  const LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
  const label = (e: string): string => LABELS[e] ?? e;
</script>

<label class="af-effort" title="Reasoning effort for this model">
  <span class="elab">effort</span>
  <select
    value={value ?? ''}
    onchange={(e) => onselect(e.currentTarget.value || null)}
    aria-label={ariaLabel}
  >
    <option value="">Default</option>
    {#each efforts as e (e)}<option value={e}>{label(e)}</option>{/each}
  </select>
</label>

/**
 * Issue scheduling-marker codec (README §3.5 / Milestone 9).
 *
 * The PM/`triage` agent (or a human) declares cross-issue scheduling — dependencies, priority,
 * ordering — as one machine-readable block in the **issue body**, wrapped in a sentinel HTML
 * comment so it is invisible in the rendered issue and safe to rewrite idempotently:
 *
 *   <!-- agent-orchestrator:v1
 *   depends_on: [42, 57]
 *   priority: 10
 *   order_key: "2026Q3-auth-03"
 *   -->
 *
 * This module is the single place that knows the block's byte format. The Scheduler
 * ({@link ../loop/scheduler}) consumes the parsed {@link SchedulingDecl} and never sees markdown;
 * the runner and the Scheduler Poller call {@link parseMarker} / {@link upsertMarker} and never
 * hand-build the text. Pure string-in/string-out — no I/O, no dependencies.
 *
 * Parsing is deterministic and forgiving *field-by-field*: a malformed field degrades to its
 * default (the Scheduler must never crash on prose a human hand-edited), never to an escalation.
 * Every field is optional; an absent block means "no dependencies, default priority" (§3.5).
 */

/** Parsed scheduling declarations, canonicalized: `dependsOn` sorted ascending, de-duplicated. */
export interface SchedulingDecl {
  /** Issue numbers (same repo — §3.5 markers carry bare numbers) that must be closed first. */
  dependsOn: number[];
  /** Higher runs first. Default 0. */
  priority: number;
  /** Lexicographic tiebreaker after priority. Default `''`. */
  orderKey: string;
}

/** The declaration an absent block (or absent field) denotes. Fresh object per call — safe to mutate. */
export function defaultScheduling(): SchedulingDecl {
  return { dependsOn: [], priority: 0, orderKey: '' };
}

/** Two declarations equal field-for-field (both sides canonical, as parse/upsert guarantee). */
export function sameScheduling(a: SchedulingDecl, b: SchedulingDecl): boolean {
  return (
    a.priority === b.priority &&
    a.orderKey === b.orderKey &&
    a.dependsOn.length === b.dependsOn.length &&
    a.dependsOn.every((n, i) => n === b.dependsOn[i])
  );
}

// The sentinel is versioned (README §3.5) so a future v2 can coexist during a migration window.
const OPEN = '<!-- agent-orchestrator:v1';
const CLOSE = '-->';

// First sentinel block in the body: opening line, captured field lines, closing fence. The fence
// is line-anchored (`^-->`) so a `-->` *inside* a JSON-quoted order_key (which can never start a
// line — JSON escapes newlines) cannot end the block early. GitHub's HTML renderer is less picky
// (a comment ends at any `-->`), so such a pathological key renders the block's tail visibly —
// cosmetic only; the codec still round-trips it.
const BLOCK_RE = /<!-- agent-orchestrator:v1[ \t]*\n([\s\S]*?)^-->/m;

// Field lines. Values terminate before any trailing `# comment` (the §3.5 example carries them):
// depends_on ends at `]`, priority at the integer, order_key at the closing quote — so a `#`
// *inside* a quoted order_key is never mistaken for a comment.
const DEPENDS_RE = /^depends_on:\s*\[([^\]]*)\]/;
const PRIORITY_RE = /^priority:\s*(-?\d+)(?:\s|$|#)/;
const ORDER_KEY_RE = /^order_key:\s*("(?:[^"\\]|\\.)*")/;

/**
 * Parse the first sentinel block out of an issue body. Returns `null` when no block exists —
 * callers treat that identically to {@link defaultScheduling} (an absent block *is* the default;
 * `null` only tells writers there is nothing to preserve). Malformed fields degrade one by one:
 * a bad `depends_on` list yields `[]` while a good `priority` on the next line still applies.
 */
export function parseMarker(body: string): SchedulingDecl | null {
  const block = BLOCK_RE.exec(body);
  if (!block) {
    return null;
  }

  const decl = defaultScheduling();
  for (const raw of block[1]!.split('\n')) {
    const line = raw.trim();

    const deps = DEPENDS_RE.exec(line);
    if (deps) {
      decl.dependsOn = parseDependsOn(deps[1]!) ?? decl.dependsOn;
      continue;
    }
    const priority = PRIORITY_RE.exec(line);
    if (priority) {
      decl.priority = Number(priority[1]);
      continue;
    }
    const orderKey = ORDER_KEY_RE.exec(line);
    if (orderKey) {
      decl.orderKey = parseQuoted(orderKey[1]!) ?? decl.orderKey;
    }
  }
  return decl;
}

/**
 * Render `decl` into `body`: replace the existing sentinel block in place, or append one after a
 * blank line. Canonical formatting (every field, one per line, sorted deps, JSON-quoted key), so
 * writing the same declaration twice is byte-identical — idempotent under back-edge re-runs of
 * triage, and a stable diff for humans reading the issue's edit history.
 */
export function upsertMarker(body: string, decl: SchedulingDecl): string {
  const block = renderMarker(decl);
  if (BLOCK_RE.test(body)) {
    // Function replacement: a literal string would have `$&`-style patterns in an order_key
    // interpreted by String.replace.
    return body.replace(BLOCK_RE, () => block);
  }
  const trimmed = body.replace(/\s+$/, '');
  return trimmed === '' ? block : `${trimmed}\n\n${block}`;
}

function renderMarker(decl: SchedulingDecl): string {
  const deps = canonicalDeps(decl.dependsOn);
  return [
    OPEN,
    `depends_on: [${deps.join(', ')}]`,
    `priority: ${Math.trunc(decl.priority)}`,
    `order_key: ${JSON.stringify(decl.orderKey)}`,
    CLOSE,
  ].join('\n');
}

/** Sorted-ascending, de-duplicated positive integers — the one canonical shape (also the DB shape). */
export function canonicalDeps(dependsOn: readonly number[]): number[] {
  return [...new Set(dependsOn.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

/** `[42, 57]` contents → canonical deps, or `undefined` when any element is not a positive integer. */
function parseDependsOn(inner: string): number[] | undefined {
  const parts = inner.split(',').map((p) => p.trim());
  const nonEmpty = parts.filter((p) => p !== '');
  // `[]` and `[ ]` are a valid, explicit "no dependencies"; `[42, x]` is malformed as a whole —
  // half-applying a dependency list could dispatch a run its author meant to hold back.
  if (nonEmpty.length !== parts.length && parts.length > 1) {
    return undefined;
  }
  const nums = nonEmpty.map((p) => (/^\d+$/.test(p) ? Number(p) : undefined));
  if (nums.some((n) => n === undefined || n <= 0)) {
    return undefined;
  }
  return canonicalDeps(nums as number[]);
}

/** A JSON-quoted token (`"…"`, escapes allowed) → its string, or `undefined` when not valid JSON. */
function parseQuoted(token: string): string | undefined {
  try {
    const value: unknown = JSON.parse(token);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

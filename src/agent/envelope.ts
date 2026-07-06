/**
 * The agent output contract (Layer 4 — see README §3.3).
 *
 * Every producing agent returns the *same* envelope, validated before it is trusted.
 * The self-review phase returns a verdict instead. Parsing is done here so the Agent
 * Runner can escalate (never coerce) on malformed output (README §3.3 Layer 4).
 *
 * These schemas describe the *structured result* of an agent work session; they are
 * harness-agnostic, so the same contract holds whether the work session ran in the Claude
 * Code subprocess harness, the Claude Agent SDK, or the in-memory stub.
 */

import { z } from 'zod';

/** A reference (never content) to a durable artifact the agent produced or updated. */
export interface ArtifactRef {
  kind: string;
  locator: unknown;
}

/** The structured envelope a producing/simplifying phase returns. */
export interface AgentEnvelope {
  /** A transition the FSM allows from this state (the engine still enforces legality). */
  requestedTransition: string;
  /** Concrete target, required when the requested transition is a `toOneOf` (e.g. code_review). */
  target?: string;
  /** Structured payload explaining what must change (required by the engine on back-edges). */
  reason?: unknown;
  /** Artifacts produced/updated, to be recorded in the `artifacts` table. */
  artifacts?: ArtifactRef[];
  /** Stage-specific flags the engine reads, e.g. `plan` returns `needs_frontend`/`needs_backend`. */
  flags?: Record<string, boolean>;
  /** Review comments to post on the PR (review stages). The runner posts them; agents never
   * touch GitHub directly (README §3.3 Layer 5). */
  comments?: string[];
  /**
   * A rich, human-facing PR description (markdown) the terminal reviewer (`code_review`) writes when it
   * approves — how the feature works and what a user can now do, the architecture and files worth
   * reading, the tests added, and the manual checks a reviewer should run. The runner frames it with
   * the machine header/footer (`Closes #N`, provenance) and applies it via `updatePr`, replacing the
   * placeholder body `tdd` opened the PR with. Ignored on non-approve transitions and by non-review
   * stages (agents never touch GitHub directly — README §3.3 Layer 5).
   */
  prDescription?: string;
}

/** The verdict a self-review phase returns. */
export interface ReviewVerdict {
  /** True when the work is good enough to hand off; false triggers a fix + re-review. */
  acceptable: boolean;
  /** What must change, fed into the simplify/fix phase. */
  notes?: unknown;
}

/** A proposed smaller issue when triage decides a too-large issue should be split. */
export interface SubIssue {
  title: string;
  body: string;
}

/**
 * Optional §3.5 scheduling declarations from `triage` (Milestone 9): the PM's judgment on what this
 * issue depends on and where it sits in the queue. Field names deliberately mirror the issue
 * marker block (`depends_on`/`priority`/`order_key` — README §3.5), because that block is what the
 * runner writes them into; the agent never formats the block itself. Advice, not control flow: a
 * malformed field is dropped (schema `.catch`), never escalated.
 */
export interface TriageScheduling {
  /** Same-repo issue numbers that must be merged/closed before this run's later stages dispatch. */
  depends_on?: number[];
  /** Higher runs first. */
  priority?: number;
  /** Lexicographic tiebreaker after priority. */
  order_key?: string;
}

/**
 * The structured output of the `triage` stage. Triage is a router/editor, not a producer, so it
 * returns its own contract rather than the generic {@link AgentEnvelope}: it can rewrite the issue
 * into a well-scoped spec (`issueUpdate`) and then choose one of three routes (README §0 triage):
 *  - `proceed` — the issue is clear; sign off and hand to `plan`.
 *  - `clarify` — ask the human; `questions` are posted as an issue comment and the run waits for a reply.
 *  - `split`   — the issue is too large; `subIssues` are opened as new issues. With `handoff` set,
 *                this run continues on that child; without it, the run escalates for the operator.
 * The runner performs the GitHub side effects (agents never touch GitHub directly) and maps the
 * decision onto the FSM.
 */
export interface TriageOutput {
  decision: 'proceed' | 'clarify' | 'split';
  /** Optional improved issue title/body, applied before routing. `body` is required when present. */
  issueUpdate?: { title?: string; body: string };
  /** Required for `clarify`: the questions a human must answer, posted as one issue comment. */
  questions?: string[];
  /** Required for `split`: the smaller issues to open (at least two). */
  subIssues?: SubIssue[];
  /** Optional for `split`: index into `subIssues` of the child this run should continue on. */
  handoff?: number;
  /** Optional human-facing note posted as an issue comment (sign-off rationale / split summary). */
  message?: string;
  /** Optional §3.5 scheduling declarations; the runner writes them into the issue's marker block. */
  scheduling?: TriageScheduling;
}

const artifactRefSchema = z.object({ kind: z.string(), locator: z.unknown() }).strict();

const envelopeSchema = z
  .object({
    requestedTransition: z.string().min(1),
    target: z.string().optional(),
    reason: z.unknown().optional(),
    artifacts: z.array(artifactRefSchema).optional(),
    flags: z.record(z.string(), z.boolean()).optional(),
    comments: z.array(z.string()).optional(),
    prDescription: z.string().min(1).optional(),
  })
  .strict();

const reviewVerdictSchema = z
  .object({
    acceptable: z.boolean(),
    notes: z.unknown().optional(),
  })
  .strict();

const subIssueSchema = z.object({ title: z.string().min(1), body: z.string().min(1) }).strict();

// Scheduling is advice, not control flow (M9 plan §3.4): each malformed field degrades to "not
// declared" via `.catch(undefined)` — and a non-object `scheduling` drops entirely — instead of
// failing the whole triage output. Deliberately NOT `.strict()`: an unknown key inside `scheduling`
// is stripped, mirroring how the issue-marker parser ignores unknown lines.
const schedulingSchema = z.object({
  depends_on: z.array(z.number().int().positive()).optional().catch(undefined),
  priority: z.number().int().optional().catch(undefined),
  order_key: z.string().optional().catch(undefined),
});

const triageOutputSchema = z
  .object({
    decision: z.enum(['proceed', 'clarify', 'split']),
    issueUpdate: z.object({ title: z.string().min(1).optional(), body: z.string().min(1) }).strict().optional(),
    questions: z.array(z.string().min(1)).optional(),
    subIssues: z.array(subIssueSchema).optional(),
    handoff: z.number().int().nonnegative().optional(),
    message: z.string().min(1).optional(),
    scheduling: schedulingSchema.optional().catch(undefined),
  })
  .strict()
  // Cross-field rules: each decision requires (only) its own payload, so a malformed decision is
  // rejected here rather than silently doing nothing in the runner.
  .superRefine((o, ctx) => {
    if (o.decision === 'clarify' && (!o.questions || o.questions.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'decision "clarify" requires a non-empty `questions` array', path: ['questions'] });
    }
    if (o.decision === 'split') {
      if (!o.subIssues || o.subIssues.length < 2) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'decision "split" requires at least two `subIssues`', path: ['subIssues'] });
      } else if (o.handoff !== undefined && o.handoff >= o.subIssues.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`handoff` must be an index into `subIssues`', path: ['handoff'] });
      }
    }
  });

/** A validation outcome that callers branch on, rather than a thrown error. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function format(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function parseEnvelope(raw: unknown): Parsed<AgentEnvelope> {
  const r = envelopeSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data as AgentEnvelope } : { ok: false, error: format(r.error.issues) };
}

export function parseReviewVerdict(raw: unknown): Parsed<ReviewVerdict> {
  const r = reviewVerdictSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data as ReviewVerdict } : { ok: false, error: format(r.error.issues) };
}

export function parseTriageOutput(raw: unknown): Parsed<TriageOutput> {
  const r = triageOutputSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data as TriageOutput } : { ok: false, error: format(r.error.issues) };
}

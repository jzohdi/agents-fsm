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
}

/** The verdict a self-review phase returns. */
export interface ReviewVerdict {
  /** True when the work is good enough to hand off; false triggers a fix + re-review. */
  acceptable: boolean;
  /** What must change, fed into the simplify/fix phase. */
  notes?: unknown;
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
  })
  .strict();

const reviewVerdictSchema = z
  .object({
    acceptable: z.boolean(),
    notes: z.unknown().optional(),
  })
  .strict();

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

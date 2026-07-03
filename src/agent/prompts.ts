/**
 * System-prompt composition for real agents (Milestone 4b — plans/milestone-4.md §3.4).
 *
 * Prompts are **code, not config**: version-controlled markdown files under `./prompts`, loaded
 * once at startup and composed into the per-(stage, phase) system prompt the Agent Runner appends
 * to the harness via `--append-system-prompt`. Composition is:
 *
 *   base  +  stage role  +  (phase instructions for self_review / simplify)  +  output contract
 *
 * where the output contract is the *verdict* contract for `self_review` and the *envelope* contract
 * otherwise. The contract is the load-bearing instruction ("your final message must be exactly this
 * JSON"), which is why every composed prompt ends with it.
 *
 * Prompts are deliberately NOT part of the FSM config hash (plans/milestone-4.md §3.4): a prompt
 * edit can affect an in-flight run on a back-edge re-run — accepted for the MVP, recorded here so it
 * is a decision, not a surprise.
 *
 * Loading is eager and fail-fast: the shared files are read at construction, and an unknown stage
 * throws when composed — better to fail loudly than send a half-formed prompt to a paid agent.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { RESOLVE_CONFLICTS_STAGE, type SystemPromptFn } from './runner';

/** The bundled prompts directory (resolved next to this module, so it works under tsx and vitest). */
const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('./prompts/', import.meta.url));

/** Joins composed sections with a horizontal rule so the agent sees clear boundaries. */
const SECTION_SEPARATOR = '\n\n---\n\n';

export interface SystemPromptOptions {
  /** Directory holding the prompt files. Defaults to the bundled `./prompts`. */
  dir?: string;
}

/**
 * Load the prompt files once and return a {@link SystemPromptFn} that composes them per
 * (stage, phase). Throws at construction if a required shared file is missing, and when invoked for
 * a stage whose role file is absent.
 */
export function createSystemPromptFn(options: SystemPromptOptions = {}): SystemPromptFn {
  const dir = options.dir ?? DEFAULT_PROMPTS_DIR;
  const base = read(dir, 'base.md');
  const envelopeContract = read(dir, 'envelope-contract.md');
  const verdictContract = read(dir, 'verdict-contract.md');
  const triageContract = read(dir, 'triage-contract.md');
  const selfReview = read(dir, join('phases', 'self_review.md'));
  const simplify = read(dir, join('phases', 'simplify.md'));
  const resolveConflicts = read(dir, join('phases', 'resolve_conflicts.md'));
  const stages = loadStages(join(dir, 'stages'));

  return (stage, phase) => {
    // The conflict resolver is a stage-agnostic phase (the between-stage base sync), not an FSM stage:
    // no stage role file, and deliberately NO output contract — its success is judged mechanically from
    // the git state (runner `finishBaseMerge`), so the envelope contract would only mislead it.
    if (stage === RESOLVE_CONFLICTS_STAGE) return [base, resolveConflicts].join(SECTION_SEPARATOR);
    const role = stages.get(stage);
    if (role === undefined) {
      throw new Error(`No stage prompt for "${stage}" (expected ${join(dir, 'stages', `${stage}.md`)})`);
    }
    const parts = [base, role];
    if (phase === 'self_review') parts.push(selfReview);
    if (phase === 'simplify') parts.push(simplify);
    // The contract is the load-bearing instruction. `triage` is a router/editor with its own decision
    // contract (it has only a `produce` phase, so it never needs the verdict one); every other stage's
    // produce/simplify emits the work envelope, and self_review emits the verdict.
    parts.push(phase === 'self_review' ? verdictContract : stage === 'triage' ? triageContract : envelopeContract);
    return parts.join(SECTION_SEPARATOR);
  };
}

/** Read every `stages/<name>.md` into a `stage name → role text` map. */
function loadStages(stagesDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of readdirSync(stagesDir)) {
    if (!file.endsWith('.md')) continue;
    map.set(file.slice(0, -'.md'.length), readFileSync(join(stagesDir, file), 'utf8').trim());
  }
  return map;
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8').trim();
}

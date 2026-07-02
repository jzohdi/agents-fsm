/**
 * Dev-only seeding for the dashboard preview (`src/dev-preview.ts`).
 *
 * Writes a realistic spread of runs — every status, multi-stage telemetry, a traversed back-edge, an
 * escalation, and enough resolved runs to exercise the Resolved lane's scroll + archive — straight
 * into a {@link Repository} via its public write API. This is the rich data the stub `serve` daemon
 * can't produce on its own (the golden-path executor only ever marches a run to `done`), so we can
 * preview the real dashboard against the real control plane without spending tokens or hitting GitHub.
 *
 * NOT shipped and NOT used by the daemon or CLI — only the preview entrypoint imports it.
 */

import type { AgentPhase, Repository, RunStatus } from './store/repository';
import type { FakeGitHub } from './integration/github-fake';

interface RunSpec {
  issue: number;
  repo: string;
  title: string;
  currentState: string;
  status: RunStatus;
  tokens: number;
  cost: number;
  branch: string;
  pr?: number;
  /** Forward states the run visited, in order — drives transitions + per-stage agent runs. */
  path: string[];
  /** Back-edges actually traversed (drawn as return arcs in the stepper). */
  backEdges?: { from: string; to: string; trigger: string; reason: string }[];
  /** Adds a final `escalate` transition from this state to `needs_human`. */
  escalateFrom?: string;
  /** Adds a final operator `stop` transition from `currentState`. */
  stopped?: boolean;
  /** Pre-archive this resolved run (so the dashboard's "Show archived" affordance appears on load). */
  archived?: boolean;
  /** Which harness ran this (defaults to the column default, `claude-code`). A non-default one shows the
   *  run-card harness badge and — for a cost-blind harness like `cursor` — a "cost n/a" figure (§8.2). */
  harness?: string;
  logs: { level: string; message: string; stage: string }[];
  artifacts: { kind: string; locator: unknown }[];
}

const TRIGGERS: Record<string, string> = { plan_review: 'approve', code_review: 'approve' };
const HEAVY = new Set(['tdd', 'frontend', 'backend']); // stages that take ≥2 agent runs

/** The open issues the preview's FakeGitHub offers to the new-run autocomplete. */
export const DEMO_ISSUES: { ref: string; number: number; title: string }[] = [
  { ref: 'acme/web#318', number: 318, title: 'Checkout token refresh fails on expiry' },
  { ref: 'acme/web#312', number: 312, title: 'Cart total rounding error on discounts' },
  { ref: 'acme/web#330', number: 330, title: 'Add dark-mode toggle to settings' },
  { ref: 'acme/web#301', number: 301, title: 'Mobile nav overlaps footer on iOS' },
  { ref: 'acme/api#205', number: 205, title: 'Rate limiter returns 429 under burst load' },
  { ref: 'acme/api#210', number: 210, title: 'Pagination cursor off-by-one at boundary' },
  { ref: 'acme/infra#91', number: 91, title: 'Bump node base image to 20-slim' },
  { ref: 'acme/docs#54', number: 54, title: 'Document webhook retry / backoff policy' },
];

/** Seed the preview's FakeGitHub so the new-run autocomplete has issues to suggest. */
export function seedSuggestions(github: FakeGitHub): void {
  for (const i of DEMO_ISSUES) github.seedIssue(i.ref, { number: i.number, title: i.title });
}

const SPECS: RunSpec[] = [
  {
    issue: 318, repo: 'acme/web', title: 'Checkout token refresh fails on expiry', currentState: 'frontend',
    status: 'running', tokens: 84200, cost: 1.83, branch: 'af/318-checkout-fix',
    path: ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend'],
    backEdges: [{ from: 'code_review', to: 'frontend', trigger: 'request_changes', reason: 'token refresh races a concurrent request — 2 cases failing' }],
    logs: [
      { level: 'info', message: 'Editing `src/checkout/session.ts`', stage: 'frontend' },
      { level: 'warn', message: '2 tests failing — routing **back to planner**', stage: 'code_review' },
      { level: 'info', message: 'Revised approach: single-flight **idempotent refresh**', stage: 'frontend' },
      { level: 'info', message: 'Running suite `vitest · 28 cases`', stage: 'frontend' },
      { level: 'info', message: 'All tests **passing** — preparing review handoff', stage: 'frontend' },
    ],
    artifacts: [
      { kind: 'branch', locator: 'af/318-checkout-fix' },
      { kind: 'diff', locator: '7 files · +218 −64' },
      { kind: 'tests', locator: '28 passed · 0 failed' },
    ],
  },
  {
    issue: 290, repo: 'acme/api', title: 'Pagination cursor off-by-one at boundary', currentState: 'tdd',
    // Run on the Cursor harness: shows the run-card harness badge and a "cost n/a" figure (Cursor reports
    // no usage, §8.2). `cost: 0` mirrors what a real Cursor run records — the UI must not show "$0.00".
    status: 'running', tokens: 0, cost: 0, branch: 'af/290-cursor', harness: 'cursor',
    path: ['triage', 'plan', 'plan_review', 'interface_design', 'tdd'],
    logs: [{ level: 'info', message: 'Writing failing test for boundary cursor', stage: 'tdd' }],
    artifacts: [{ kind: 'branch', locator: 'af/290-cursor' }],
  },
  {
    issue: 277, repo: 'acme/web', title: 'Webhook delivery retries drop events', currentState: 'backend',
    status: 'running', tokens: 41200, cost: 0.92, branch: 'af/277-webhooks',
    path: ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend'],
    logs: [{ level: 'info', message: 'Implementing retry queue in `src/webhooks/queue.ts`', stage: 'backend' }],
    artifacts: [{ kind: 'branch', locator: 'af/277-webhooks' }, { kind: 'diff', locator: '6 files · +180 −22' }],
  },
  {
    issue: 256, repo: 'acme/web', title: 'Improve keyboard a11y on the data grid', currentState: 'plan_review',
    status: 'running', tokens: 15300, cost: 0.34, branch: 'af/256-a11y',
    path: ['triage', 'plan', 'plan_review'],
    logs: [{ level: 'info', message: 'Reviewing plan against WCAG focus-order notes', stage: 'plan_review' }],
    artifacts: [{ kind: 'branch', locator: 'af/256-a11y' }],
  },
  {
    issue: 205, repo: 'acme/api', title: 'Rate limiter returns 429 under burst load', currentState: 'code_review',
    status: 'paused', tokens: 51000, cost: 1.12, branch: 'af/205-rate-limit', pr: 207,
    path: ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend', 'code_review'],
    logs: [
      { level: 'info', message: 'Reviewing diff against `token-bucket` spec', stage: 'code_review' },
      { level: 'warn', message: 'Window resets **off by 1s**', stage: 'code_review' },
      { level: 'info', message: 'Run **paused** by operator', stage: 'code_review' },
    ],
    artifacts: [{ kind: 'branch', locator: 'af/205-rate-limit' }, { kind: 'pr', locator: { url: 'https://github.com/acme/api/pull/207' } }],
  },
  {
    issue: 312, repo: 'acme/web', title: 'Cart total rounding error on discounts', currentState: 'plan',
    status: 'awaiting_input', tokens: 33400, cost: 0.74, branch: 'af/312-rounding',
    path: ['triage', 'plan'],
    logs: [
      { level: 'info', message: 'Two valid rounding strategies identified', stage: 'plan' },
      { level: 'warn', message: '**Asked operator**: round half-up or banker’s rounding?', stage: 'plan' },
    ],
    artifacts: [{ kind: 'branch', locator: 'af/312-rounding' }],
  },
  {
    issue: 301, repo: 'acme/web', title: 'Mobile nav overlaps footer on iOS', currentState: 'needs_human',
    status: 'needs_human', tokens: 47600, cost: 1.05, branch: 'af/301-mobile-nav',
    path: ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend', 'code_review'],
    backEdges: [{ from: 'code_review', to: 'frontend', trigger: 'request_changes', reason: 'layout regressions persist' }],
    escalateFrom: 'code_review',
    logs: [
      { level: 'warn', message: 'Visual diff still failing on `iPhone SE`', stage: 'code_review' },
      { level: 'warn', message: 'Revise budget exhausted (3 / 3)', stage: 'code_review' },
      { level: 'error', message: '**Escalated** — needs human', stage: 'code_review' },
    ],
    artifacts: [{ kind: 'branch', locator: 'af/301-mobile-nav' }, { kind: 'tests', locator: '3 failed · 19 passed' }],
  },
  resolved(88, 'acme/infra', 'Rotate staging TLS certificates', 120000, 2.41, 'af/88-tls', 90),
  resolved(84, 'acme/infra', 'Bump node base image to 20-slim', 96000, 1.88, 'af/84-imagebump', 86),
  resolved(79, 'acme/web', 'Add dark-mode toggle to settings', 71000, 1.42, 'af/79-darkmode', 81),
  { ...resolved(70, 'acme/api', 'Cache the org settings lookup', 64000, 1.27, 'af/70-cache', 72), archived: true },
  {
    issue: 66, repo: 'acme/web', title: 'Promo banner flickers on first paint', currentState: 'frontend',
    status: 'stopped', tokens: 18000, cost: 0.39, branch: 'af/66-banner', stopped: true,
    path: ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend'],
    logs: [{ level: 'warn', message: 'Run **stopped** by operator', stage: 'frontend' }],
    artifacts: [{ kind: 'branch', locator: 'af/66-banner' }],
  },
  {
    issue: 54, repo: 'acme/docs', title: 'Document webhook retry / backoff policy', currentState: 'plan',
    status: 'stopped', tokens: 12100, cost: 0.28, branch: 'af/54-retry-doc', stopped: true,
    path: ['triage', 'plan'],
    logs: [{ level: 'warn', message: 'Run **stopped** by operator', stage: 'plan' }],
    artifacts: [{ kind: 'branch', locator: 'af/54-retry-doc' }],
  },
];

/** A fully-finished run (every forward stage done, PR open for review) for the Resolved lane. */
function resolved(issue: number, repo: string, title: string, tokens: number, cost: number, branch: string, pr: number): RunSpec {
  return {
    issue, repo, title, currentState: 'done', status: 'done', tokens, cost, branch, pr,
    path: ['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend', 'code_review', 'done'],
    logs: [
      { level: 'info', message: `Opened PR \`${repo}#${pr}\``, stage: 'code_review' },
      { level: 'info', message: 'CI green — **open for review** (watching for `feedback:` comments)', stage: 'done' },
    ],
    artifacts: [{ kind: 'branch', locator: branch }, { kind: 'pr', locator: { url: `https://github.com/${repo}/pull/${pr}` } }],
  };
}

/** Seed the repository with the preview run set. Returns the run ids created. */
export function seedRuns(repo: Repository, version: string): number[] {
  // Enroll every seeded repo first (as `POST /repos` would have), so `GET /repos` matches the runs
  // and the home page's ledger shows enrolled repos rather than "history only" leftovers.
  for (const repoRef of new Set(SPECS.map((s) => s.repo))) {
    repo.upsertRepo({ repoRef, workingRoot: `/tmp/agent-fleet-preview/${repoRef}`, baseBranch: 'main' });
  }
  const ids: number[] = [];
  for (const s of SPECS) {
    const run = repo.createRun({
      issueRef: `${s.repo}#${s.issue}`, repoRef: s.repo, initialState: 'triage', fsmConfigVersion: version,
      ...(s.harness ? { harness: s.harness } : {}),
    });
    const id = run.id;
    ids.push(id);

    // transitions: start → first stage, then the forward hops it took
    repo.appendTransition({ runId: id, fromState: '(start)', toState: s.path[0]!, trigger: 'start' });
    for (let i = 0; i < s.path.length - 1; i++) {
      repo.appendTransition({ runId: id, fromState: s.path[i]!, toState: s.path[i + 1]!, trigger: TRIGGERS[s.path[i + 1]!] ?? 'proceed' });
    }
    for (const be of s.backEdges ?? []) {
      repo.appendTransition({ runId: id, fromState: be.from, toState: be.to, trigger: be.trigger, reason: be.reason, backEdge: true });
    }
    if (s.escalateFrom) {
      // Use a real escalation trigger + structured reason (as the loop emits) so the dashboard's
      // escalation inspector shows genuine per-trigger guidance, not the unknown-trigger fallback.
      repo.appendTransition({
        runId: id,
        fromState: s.escalateFrom,
        toState: 'needs_human',
        trigger: 'internal_review_cap',
        // Notes shaped like a real self-review verdict ({ issues }) so the inspector's readable
        // findings list renders in the preview, not just the headline.
        reason: {
          kind: 'internal_review_cap',
          cap: 3,
          notes: {
            kind: 'code_review',
            issues: [
              'The checkout summary re-renders on every cart mutation because the memo key includes the full cart object; key on cart.version instead.',
              'The retry path swallows the AbortError, so a cancelled payment intent is reported as succeeded.',
            ],
          },
        },
      });
    }
    if (s.stopped) {
      repo.appendTransition({ runId: id, fromState: s.currentState, toState: 'stopped', trigger: 'stop', reason: 'stopped by operator' });
    }

    // per-stage agent runs (telemetry), distributing the run's tokens across visited stages
    const stages = s.path.filter((p) => p !== 'done');
    const weights = stages.map((st) => (HEAVY.has(st) ? 2 : 1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let agentRuns = 0;
    stages.forEach((stage, i) => {
      const n = weights[i]!;
      for (let k = 0; k < n; k++) {
        agentRuns += 1;
        repo.recordAgentRun({
          runId: id, stage, phase: 'produce' as AgentPhase, model: 'claude-opus-4-8',
          tokens: Math.round((s.tokens / totalWeight) * (n === 2 ? (k === 0 ? 0.6 : 0.4) : 1)),
          durationMs: 14000 + i * 9000 + k * 11000, success: true,
        });
      }
    });

    for (const l of s.logs) repo.recordLog({ runId: id, level: l.level, message: l.message, data: { stage: l.stage } });
    for (const a of s.artifacts) repo.recordArtifact({ runId: id, kind: a.kind, locator: a.locator });

    repo.setRunBranch(id, s.branch);
    if (s.pr) repo.setRunPr(id, s.pr);
    repo.addRunUsage(id, { tokens: s.tokens, cost: s.cost, agentRuns });
    repo.setRunState(id, s.currentState);
    if (s.status !== 'running') repo.setRunStatus(id, s.status);
    if (s.archived) repo.setRunArchived(id, true);
  }
  return ids;
}

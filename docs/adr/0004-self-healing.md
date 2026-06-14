# ADR-0004: Bounded Self-Healing via `onFail` Agent Hooks

**Status:** Proposed
**Date:** 2026-06-12
**Deciders:** PatrickJS
**Index:** [Design decisions](index.md)
**Depends on:** [ADR-0001](0001-agent-step-type.md) (agent steps), [ADR-0003](0003-failure-context-packs.md) (context packs)

> Proposed design. Nothing here is a shipped behavior claim; claims and tests land with the implementation per [AGENTS.md](../../AGENTS.md). This is deliberately the **last** record in the suggested implementation order.

## Context

The scheduler is fail-fast: first failure stops new scheduling, running tasks drain, the record completes. The attractive next step is obvious — when a task fails, hand the failure to an agent, let it patch, re-run. It is also where agentic CI tools have historically gone wrong: unbounded retry loops, patches that game the failing check instead of fixing the cause, fixes applied to working trees without consent, and "green" runs whose provenance nobody can reconstruct.

This repo has a sharper version of that last concern: AGENTS.md exists because *"all checks pass" has shipped broken promises here before*. A self-healing mode that optimizes for green checks is structurally aligned with that failure mode.

Forces: working-tree writes are currently something only the user's own commands do — the pipeline writes `.async/` and declared sync surfaces, nothing else; sandboxes (Lima, Docker) exist and are opt-in; the run lock serializes runs; ADR-0001 gives policy-bounded, transcripted agent execution; ADR-0003 gives the failure input.

## Decision

Add an opt-in, per-task `onFail` hook that runs an agent step to **propose** a fix. Proposals are artifacts; applying them is a separate, explicit human action. Sketch:

```ts
task({
  dependsOn: ["typecheck"],
  inputs: ["default"],
  run: sh`pnpm run test`,
  onFail: agent({
    use: "claude",
    prompt: "Diagnose the failure from the context pack and produce a minimal fix as a unified diff.",
    budget: { attempts: 1, wallClockMs: 300_000 }
  })
})
```

Bundled decisions:

1. **Propose, never apply.** The hook's output is `.async/runs/<run-id>/fixes/<task>.patch` plus the transcript. The working tree is untouched. Applying is `async-pipeline fix apply <run-id> <task>` (or plain `git apply`), a human command. No flag makes application automatic in v1 — that is a deliberate non-feature, not an oversight.
2. **The fix attempt runs after the run finalizes its verdict.** The run is recorded as failed first; healing happens in an appendix phase. A run that "would have passed with the patch" is still a failed run. Re-running after applying is a new run with its own record.
3. **Sandbox required for write-capable agents.** The `onFail` agent gets a scratch copy (warm checkout under `.async/sources` or sandbox workspace), never the user's working tree. Its command policy is the ADR-0001 default-deny plus explicitly granted build/test commands so it can verify its own patch before proposing it.
4. **Hard budgets, no recursion.** `attempts` and `wallClockMs` are mandatory with low defaults; an `onFail` agent's own failure never triggers another hook; healing is skipped entirely in CI mode (`mode: "ci"`) unless explicitly enabled — CI proposing patches nobody asked for is noise at best.

## Options Considered

### Option A: Propose-only `onFail` with mandatory budgets (proposed)

| Dimension | Assessment |
| --- | --- |
| Complexity | High — scratch workspaces, appendix phase, new CLI verb |
| Risk | Contained — no working-tree writes, no auto-apply, no loops |
| Value | Diagnosis + ready patch at failure time, with provenance |
| Trust model | Human stays the only writer of source |

**Pros:** preserves "the pipeline never touches your tree"; every fix has a transcript, a patch, and a reviewable trail; budgets make the worst case boring.
**Cons:** less magical than auto-heal; scratch-copy fidelity (does the failure reproduce there?) is a real engineering problem; significant machinery for a convenience.

### Option B: Auto-apply and re-run until green (the tempting one)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium |
| Risk | High — check-gaming, unreviewed writes, loop containment |
| Value | High when it works, negative when it doesn't |
| Trust model | Agent becomes a source author without review |

**Pros:** the demo is spectacular; genuinely useful for mechanical failures (lockfile drift, snapshot updates).
**Cons:** directly opposed to this repo's review discipline — it automates *exactly* the behavior AGENTS.md exists to prevent (optimizing the check instead of the promise); cache and record semantics get murky (whose change was that?); a wrong fix that passes tests is worse than a loud failure.

### Option C: No hook — run healing as an outer agent loop (status quo + ADR-0002/0003)

| Dimension | Assessment |
| --- | --- |
| Complexity | Zero in core |
| Risk | Delegated to the outer agent host |
| Value | Most of A, for users already driving agents |
| Trust model | Outer agent's host policy governs |

**Pros:** Claude Code (or any MCP host) can already do run → read pack → patch → re-run using ADR-0002 + ADR-0003; no new core surface; healing logic evolves at agent speed, not release speed.
**Cons:** no budgets or sandbox guarantees from the pipeline's side; provenance scattered across host logs instead of `.async/`; every team re-builds the loop.

## Trade-off Analysis

B is rejected on principle, not feasibility: this package's differentiator is evidence and explicit boundaries, and B erodes both at the exact moment they matter (a failure). The live question is A versus C, and it is genuinely close. C delivers most of the value today with zero core risk — which is why ADR-0002 and ADR-0003 rank earlier. A earns its complexity only if the propose-only loop proves so common that standardizing budgets, scratch fidelity, and fix provenance in the pipeline beats every host doing it ad hoc. Proposed sequencing: ship C implicitly (it falls out of 0002+0003), gather real usage, land A only when the patterns are observed rather than guessed.

## Consequences

- Easier: failure-to-patch latency drops to zero for opted-in tasks; fixes carry transcripts and diffs as first-class run evidence.
- Harder: store layout (`fixes/`), CLI surface (`fix apply`), scratch-workspace machinery, and CI-mode semantics all grow; the "pipeline never writes your tree" claim needs careful rewording to stay true and registered.
- Revisit: auto-apply for an allowlisted class of mechanical fixes (B's good half) once propose-only has a track record; `onFail` for non-agent steps (notifications) as a side benefit of the hook point.

## Action Items

1. [ ] Defer until ADR-0001 and ADR-0003 ship; re-evaluate A-versus-C with observed outer-loop usage.
2. [ ] Spec the appendix phase and `fixes/` layout; define scratch-workspace fidelity requirements (when is a repro attempt honest?).
3. [ ] Spec `fix apply` (collision behavior, dirty-tree refusal).
4. [ ] Register claims (propose-only, budgets, CI-skip, tree-untouched) with `PROMISE:` tests; CHANGELOG entry labeled appropriately.

# ADR-0005: Adversarial Review as a Pipeline Pattern

**Status:** Proposed
**Date:** 2026-06-12
**Deciders:** PatrickJS
**Index:** [Design decisions](index.md)
**Depends on:** [ADR-0001](0001-agent-step-type.md) (agent steps)

> Proposed design. Nothing here is a shipped behavior claim; claims and tests land with the implementation per [AGENTS.md](../../AGENTS.md).

## Context

AGENTS.md mandates a review discipline that is currently entirely manual: before a tranche is complete, a second agent or fresh session runs with the objective *"find where the implementation betrays README.md and docs/, and prove it empirically with a scratch pipeline."* The reviewer falsifies; it does not confirm. This discipline exists because self-verification failed here before — checks passed while promises broke.

Today this works through prompt copy-paste and goal-directory receipts (`goals/*/state.yaml` records a worker/judge pattern). Nothing in the pipeline knows the review happened, what it examined, or what it found. The claims registry (`tests/claims.json`) makes claim→test *existence* checkable mechanically; the reviewer owns *sufficiency* — whether the test actually exercises the promise.

Forces: ADR-0001 provides policy-bounded agent tasks with transcripts; source composition already provides scratch checkouts (`.async/sources` warm clones) for many-repo runs; an adversarial reviewer needs read access plus the ability to *run* things in a scratch copy, but must never gain write access to the tree under review; a falsification objective is only credible if the reviewer's failures block something.

## Decision

Productize the discipline as a documented pattern — an `agent()` task with a falsification prompt, a scratch source checkout, and a structured receipt — shipped first as an example, promoted to a primitive only if the pattern stabilizes.

1. **Shape: a `review` job, not a new core concept.** A pipeline declares a `review` job whose task is `agent()` with: a scratch checkout of the repo at the candidate commit (reusing source machinery), command policy granting read tools plus the project's own verification commands inside the scratch copy only, and the claims registry as declared input.
2. **The objective is falsification, stated in the prompt contract.** The reviewer samples claims, attempts to break each empirically in the scratch pipeline (not by reading code but by running it), and must produce for each examined claim: `upheld` with the exercising command, or `falsified` with a reproduction.
3. **Receipt as run evidence.** Output is `.async/runs/<run-id>/review.json`: claims examined, verdicts, reproduction commands, transcript reference. A `falsified` verdict fails the task — and therefore the job — so review findings block exactly like test failures.
4. **Sufficiency stays human.** The receipt records what was *exercised*; accepting that a test sufficiently enforces a claim remains review judgment. The agent widens coverage of the falsification pass; it does not replace the human sign-off AGENTS.md requires.

## Options Considered

### Option A: Documented pattern + example first, primitive later (proposed)

| Dimension | Assessment |
| --- | --- |
| Complexity | Low — composes ADR-0001 + existing sources |
| Rigidity | Low — prompt and policy iterate per repo |
| Enforceability | Receipt schema checkable; pattern itself opt-in |
| Risk | Reviewer quality varies; pattern may stay bespoke |

**Pros:** examples are exercised by `release:check`, so the pattern stays runnable; learns what the receipt schema should be before freezing it; zero new core surface.
**Cons:** "documented pattern" is weaker than a primitive — drift across adopters; receipt schema informal until promoted.

### Option B: First-class `review` primitive in core now

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium-high — new job kind, receipt schema in record shape |
| Rigidity | High — schema freezes at 1.0 |
| Enforceability | Strong — `schemaVersion`-ed receipts, standard CLI |
| Risk | Freezing a shape designed from one repo's experience |

**Pros:** receipts become portable evidence across projects; tooling (badges, dashboards) gets a stable target.
**Cons:** this repo is the only known user of the discipline; designing the frozen schema from n=1 is how surfaces end up wrong at 1.0.

### Option C: Keep it fully manual (status quo)

| Dimension | Assessment |
| --- | --- |
| Complexity | Zero |
| Rigidity | None |
| Enforceability | None — discipline lives in AGENTS.md prose |
| Risk | The known one: skipped or shallow reviews leave no trace |

**Pros:** maximum reviewer freedom; no machinery.
**Cons:** unfalsifiable process — nothing records whether the adversarial pass happened or what it covered; the discipline's own standard ("prove it empirically") applied to itself fails.

## Trade-off Analysis

C fails the repo's own bar: a review discipline whose execution leaves no evidence is exactly the kind of claim AGENTS.md distrusts. B is premature standardization — the receipt schema worth freezing is the one that survives contact with real reviews, and there has been exactly one project's worth of those. A is the falsifiable middle: the pattern ships as a runnable example (so it cannot rot silently), receipts accumulate, and promotion to primitive happens with schema evidence in hand.

The sharpest open question in A is reviewer independence. A reviewer agent configured by the same `pipeline.ts` it reviews could be steered by a malicious or sloppy change (weakened prompt, narrowed policy). Mitigation in the pattern: the review job's prompt and policy live in a file the review task declares as input, so tampering dirties the review and is visible in the diff — imperfect, honest about being so.

## Consequences

- Easier: the falsification pass scales beyond one human's patience; review evidence lands next to run evidence; PRs can require a passing review job.
- Easier: ADR-0003 packs give the reviewer precomputed "what changed" targeting — review effort concentrates where inputs moved.
- Harder: model cost per review; prompt quality becomes load-bearing; receipts can create false confidence if "claims examined" is read as "claims guaranteed".
- Revisit: promotion to core primitive; cross-repo receipt aggregation; reviewer-independence hardening.

## Action Items

1. [ ] Write the prompt contract and command-policy template for the reviewer agent.
2. [ ] Ship `examples/adversarial-review/` exercised by the examples test, with a mocked agent (`command.mock`) proving the receipt path and failure propagation without a model in CI.
3. [ ] Define the informal `review.json` shape; collect real receipts from this repo's own tranches.
4. [ ] Re-evaluate promotion to primitive (Option B) after several recorded reviews; register claims and tests at that point.

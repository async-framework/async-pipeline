# ADR-0002: An MCP Server Surface for the CLI

**Status:** Accepted (v1 subset shipped in 0.2.3)
**Date:** 2026-06-12
**Deciders:** PatrickJS
**Index:** [Design decisions](index.md)

> Shipped in 0.2.3 per Option A: `async-pipeline mcp` as a hand-rolled line-delimited JSON-RPC 2.0 stdio server with `initialize`/`ping`/`tools/list`/`tools/call`, read-only tools (`list_tasks`, `graph`, `explain_task`, `metadata`, `list_runs`, `read_run`, `diff_inputs`), and `run_job` gated behind `--allow-run` with the same lock, records, and cache as CLI runs — see [api.md](../api.md#mcp) for the reference and registered claims. Not yet shipped: resources/prompts capabilities, HTTP transport, and `matrix`/sync tools (consequences "revisit" list).

## Context

The README promises inspectable commands "for humans, tools, and AI agents": `list`, `graph`, `explain`, `metadata`, `matrix`, `doctor`. Today an agent consumes them by spawning the CLI and parsing output. That works, but every agent re-derives the same glue: which commands exist, which flags emit JSON, which are safe to run, what the output shape is. The [metadata promise](../api.md#metadata) — reads execute nothing, clone nothing, evaluate no deferred callbacks — is exactly the introspection contract an agent wants, and it is currently discoverable only by reading the docs.

MCP (Model Context Protocol) is the emerging standard for exposing tools to agents: JSON-RPC 2.0 over stdio, with tool discovery and schemas. Claude Code, Cowork, and other agent hosts speak it natively.

Forces: zero runtime dependencies is a published promise; the package is pre-1.0 and the CLI surface freezes at 1.0; the [run lock](../api.md#run-lock) already serializes runs per project; the [exit code contract](../api.md#exit-codes) is part of the frozen surface.

## Decision

Add `async-pipeline mcp`: a stdio MCP server implemented by hand in `pipeline-node`, exposing the existing inspection commands as discoverable tools.

1. **Hand-rolled protocol, no SDK.** The server needs `initialize`, `tools/list`, and `tools/call` over JSON-RPC 2.0 on stdio. That is a few hundred lines against a pinned protocol version — well under the bar that would justify breaking the zero-dependency promise.
2. **Read-only by default.** Initial tool set: `list`, `graph`, `explain`, `metadata`, `runs` (read execution records and summaries from `.async/runs/`), `doctor`. All are inert by the same definition as `metadata` today.
3. **Mutation is opt-in.** `run` and `run-task` are exposed only when the server is started with `--allow-run`. They acquire the same `.async/run.lock`, write the same records, and report the same exit-code semantics in the tool result. No tool ever bypasses the scheduler or store.
4. **Tool results are the JSON the CLI already emits.** The MCP layer is a transport, not a second implementation: each tool calls the same internals as `--format json`, so the CLI and MCP surfaces cannot drift apart.

## Options Considered

### Option A: Hand-rolled stdio server in `pipeline-node` (proposed)

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium — small protocol subset, but owned forever |
| Dependency cost | Zero |
| Compatibility | Pinned MCP protocol version; additive evolution |
| Drift risk | Low — delegates to existing command internals |

**Pros:** keeps the zero-dependency promise; tool schemas become executable documentation of the JSON output shapes; works in every MCP host.
**Cons:** protocol conformance is on us (spec churn, capability negotiation edge cases); temptation to grow bespoke extensions.

### Option B: Official MCP SDK in a separate `@async/pipeline-mcp` package

| Dimension | Assessment |
| --- | --- |
| Complexity | Low per feature, high per release (SDK churn) |
| Dependency cost | Real but contained to an opt-in package |
| Compatibility | Tracks spec automatically |
| Drift risk | Medium — second package to version and sync |

**Pros:** full protocol coverage (resources, prompts, notifications) for free; less protocol code to own.
**Cons:** another publishable package with its own engines floor, claims, and drift checks; the core CLI still wants `mcp` as a discoverable subcommand, so the seam is awkward.

### Option C: No MCP — document `--format json` as the agent contract

| Dimension | Assessment |
| --- | --- |
| Complexity | Zero |
| Dependency cost | Zero |
| Compatibility | Works with any agent that can shell out |
| Drift risk | None new |

**Pros:** the contract already mostly exists; nothing to freeze at 1.0.
**Cons:** no discovery (agents must be told what exists), no schemas, every host re-implements spawning/parsing; "inspectable by agents" stays a docs claim rather than a wire protocol.

## Trade-off Analysis

C is the do-nothing baseline and it is not bad — the JSON output contract is genuinely agent-friendly. The case for A over C is discovery and schema: an MCP host can offer pipeline tools with zero configuration, and the tool schemas pin the output shapes that today live only in [api.md](../api.md). The case for A over B is the dependency promise plus surface control: the protocol subset needed is small and stable, while an SDK dependency imports someone else's release cadence into a package that markets having no dependencies at all. If the hand-rolled subset ever needs resources/prompts/streaming, B becomes the migration path — A's tool definitions port directly.

The 1.0 consideration cuts both ways: shipping `mcp` pre-1.0 means the tool names and schemas join the freeze; shipping after 1.0 means agents wait. Proposed: ship pre-1.0 marked experimental, freeze at 1.0 alongside the CLI per [Path to 1.0](../path-to-1.0.md).

## Consequences

- Easier: any MCP-speaking agent drives the pipeline with zero glue; ADR-0003's context packs get a natural delivery channel (`runs` tool).
- Easier: output-shape regressions become protocol-visible (schema mismatch) instead of silently breaking parsers.
- Harder: protocol conformance testing joins the test matrix; one more long-lived process mode for the CLI (signal handling, EPIPE behavior must match the existing contract).
- Revisit: resources/prompts support; HTTP transport; whether `matrix` and sync commands belong in the tool set.

## Action Items

1. [ ] Spec tool names, input schemas, and result shapes from the existing `--format json` outputs.
2. [ ] Implement the JSON-RPC/stdio loop in `pipeline-node` with a pinned protocol version; reuse existing command internals.
3. [ ] Gate `run`/`run-task` behind `--allow-run`; verify lock and record behavior under MCP-initiated runs.
4. [ ] Conformance tests: handshake, discovery, each tool against a fixture pipeline; signal/EPIPE behavior consistent with [exit codes](../api.md#exit-codes).
5. [ ] Register claims (read-only default, lock semantics, no-drift-from-CLI) in `tests/claims.json`; CHANGELOG entry; docs page; example host configuration.

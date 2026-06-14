# ADR-0007: Branded Declaration Protocol

**Status:** Accepted (v1 in 0.3.0)
**Date:** 2026-06-13
**Deciders:** PatrickJS
**Index:** [Design decisions](index.md)

## Context

Helper packages need to expose reusable task groups without owning the host app's jobs, sync policy, cache stores, or runtime context. Passing injected helpers is the preferred form:

```ts
claimsTasks({ task, sh, agent })
```

That keeps the host pipeline in charge of semantics. Some tools also need a portable emitter form that can produce declaration nodes without importing the same physical copy of `@async/pipeline`.

## Decision

Use `Symbol.for("@async/pipeline.declaration")` as a shared declaration marker. Factory helpers attach non-enumerable metadata with `{ kind, version: 1 }`, and `definePipeline()` walks the tree, validates shapes, and normalizes to the existing runtime definitions.

Top-level sections are context-bearing containers. Plain object sections remain the default public API, while explicit section factories such as `tasks({ ... })` and `jobs({ ... })` are accepted for advanced composition. `definePipeline()` detects already-branded sections and does not double wrap them.

Task groups use `.` for local task paths. Source namespaces keep `:`, so `storefront:claims.report` means source `storefront`, local task path `claims.report`.

The brand is not trust. Any package can call `Symbol.for(...)`; the host still validates every object shape and rejects unknown fields before normalization.

API-surface hashing is intentionally out of this package. A future companion package can derive feature sets and hashes from validated declaration trees, but `@async/pipeline` owns pipeline-specific validation and normalization.

## Consequences

- Helper packages can mount local task groups without becoming source pipelines.
- Duplicate installed copies of `@async/pipeline` can still exchange declaration nodes in the same JavaScript realm.
- Existing object-literal configs remain valid.
- Compatibility remains semantic: unsupported declaration versions and unsupported shapes fail clearly, while package-version-based surface hashing remains a future external concern.

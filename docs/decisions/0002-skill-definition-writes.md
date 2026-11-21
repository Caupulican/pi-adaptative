# ADR 0002. Serialize skill definition changes at the physical catalog root

Accepted. This records the locking contract shared by skill repair and curation.

## Context

A skill may be discovered through a symlink. Repair, promotion, archival and restore can address the same definition under different names. A curator can also hold a catalog lock before reaching the mutation helper.

## Decision

`withSkillDefinitionLock` uses the physical definition path to select the catalog root. It reuses a caller-held lock on the same physical root. A different root gets one immediate acquisition attempt so two operations holding different roots cannot wait on each other.

Inspection returns a version derived from modification time and content digest. Repair rereads and compares that version under the shared lock, preserves frontmatter fields, enforces the size bounds and replaces the file atomically.

## Consequences

An intervening change by a cooperating writer yields a stale-version result. Contention can fail an operation immediately. External editors do not share the lock. Atomic replacement protects readers from a partially written definition.

See [skill mutation](../../packages/coding-agent/src/core/skill-mutation.ts) and [skill repair](../../packages/coding-agent/src/core/skill-repair.ts).

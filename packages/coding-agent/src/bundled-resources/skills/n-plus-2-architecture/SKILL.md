---
name: n-plus-2-architecture
description: "Language-agnostic N+2 architecture principles for data layout, allocation, and hot-path design. Use when designing or reviewing system architecture, optimizing performance, planning memory or allocation strategy (arenas, pools, rings, buffers, batching), fixing quadratic growth, rescan, or rebuild-from-scratch patterns, or deciding state ownership and trust-boundary validation points."
---

N+2 ARCHITECTURE

Language-agnostic principles:
1. Bounded flat arenas/pools/rings/chunks, batch recycle.
2. Safe zero/default data/state, no hidden allocation, one activation owner.
3. Validate trust boundary once; internal miss gets safe stub/default, external failure explicit.
4. Stable IDs/indexes/buffers/batches; avoid pointer graphs/dispatch/fallback.
5. Never concatenate growing prefixes, prepend, rescan consumed input, serialize unchanged history, rebuild incremental state; materialize once.

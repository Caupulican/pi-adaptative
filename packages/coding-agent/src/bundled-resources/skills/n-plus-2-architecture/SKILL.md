---
name: n-plus-2-architecture
description: "Language-agnostic N+2 architecture principles for data layout, allocation, and hot-path design. Use when designing or reviewing system architecture, optimizing performance, planning memory or allocation strategy (arenas, pools, rings, buffers, batching), fixing quadratic growth, rescan, or rebuild-from-scratch patterns, or deciding state ownership and trust-boundary validation points."
---

N+2 ARCHITECTURE

## How to use the skill

Apply the five principles when designing or reviewing data layout, allocation, hot paths, state ownership or trust-boundary validation. Freedom Dial: High Freedom; the principles are judgment criteria, not steps.

## North Star

Work and memory grow with the new input only, never with the history already processed.

## Core Sections

Language-agnostic principles:
1. Bounded flat arenas/pools/rings/chunks, batch recycle.
2. Safe zero/default data/state, no hidden allocation, one activation owner.
3. Validate trust boundary once; internal miss gets safe stub/default, external failure explicit.
4. Stable IDs/indexes/buffers/batches; avoid pointer graphs/dispatch/fallback.
5. Never concatenate growing prefixes, prepend, rescan consumed input, serialize unchanged history, rebuild incremental state; materialize once.

## Anti-Patterns

- Appending to a growing string or array by copying the whole prefix each step.
- Re-serializing or re-hashing unchanged history on every request.
- Rebuilding derived state from scratch when one increment changed.
- Re-validating internal data on every hop instead of once at the trust boundary.
- Unbounded per-item allocation on a hot path.

## Examples

- A transcript that grows each turn: keep an append-only buffer and serialize only the new tail (principle 5).
- A parser that receives chunks: track a consumed offset instead of rescanning the buffer from the start (principle 5).
- Per-request objects: take them from a bounded pool and recycle the batch at the end of the request (principle 1).

## Self-Check

- Is each cost proportional to the new input, not to the total history?
- Is every pool, ring or arena bounded, with one activation owner?
- Is validation done once at the trust boundary, with internal misses getting a safe default and external failures made explicit?

## Known Gaps

- Principles only: no language-specific allocators, benchmarks or profiling procedure.
- The skill does not measure; a performance claim still needs a measurement at the real input size.

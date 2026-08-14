# Destructive suite — closed loop

The suite is one cycle. Every path returns to seed. Nothing exits the loop except a loud, reproducible failure.

## Ideal cycle (self-balanced)

```mermaid
flowchart TD
    A["SEED<br/>scenario + PRNG"] --> B["INJECT<br/>failAtOp N / torn / chaos"]
    B --> C["RUN<br/>real product code"]
    C --> D["RECOVER<br/>fresh construct over surviving files"]
    D --> E["ASSERT<br/>INV-G* W* B1 C* R1 L1"]
    E -->|"RED + SEED=/INJECTION=/SCENARIO="| F["FIX<br/>the owning mechanism"]
    E -->|"GREEN"| G["NEXT N / NEXT SCENARIO"]
    F --> A
    G --> H{"catalogue done?"}
    H -->|no| B
    H -->|yes| I["CI nightly + dispatch"]
    I -->|"fail"| F
    I -->|"pass"| J["promote may tag"]
    J --> A
```

## H3 interleave (same loop, shuffled)

```mermaid
flowchart LR
    S["SEED"] --> R["round r = 1"]
    R --> O["shuffle ops"]
    O --> Q["release + quiesce"]
    Q --> V["INV-W1 W2 W3 W5 B1"]
    V -->|"red"| X["repro line"]
    X --> O
    V -->|"green"| N{"r = R?"}
    N -->|no| R2["r + 1"]
    R2 --> O
    N -->|yes| S
```

## H4 soak (same loop, virtual time)

```mermaid
flowchart LR
    S["SEED + t0"] --> A["advance documented bound"]
    A --> F["watchdog must fire"]
    F -->|"silent"| X["repro line"]
    X --> A
    F -->|"fired"| N{"catalogue done?"}
    N -->|no| A
    N -->|yes| S
```

## H1 crash sweep (same loop, smaller)

```mermaid
flowchart LR
    S["measure K"] --> N["N = 1"]
    N --> I["inject at N"]
    I --> R["restart"]
    R --> V["INV-R1 / C2 / G1 / W4"]
    V -->|"red"| X["repro line"]
    X --> I
    V -->|"green"| M{"N = K?"}
    M -->|no| N2["N + 1"]
    N2 --> I
    M -->|yes| S
```

## What is in this tree

| Path | Invariants |
|---|---|
| `crash/goal-usage.destructive.test.ts` | G1 G2 G3 R1 |
| `crash/worker-terminal-handoff.destructive.test.ts` | W4 |
| `crash/compaction-checkpoint.destructive.test.ts` | C1 C2 R1 |
| `crash/worker-ledger-compaction.destructive.test.ts` | W1 W2 W4 C2 R1 |
| `crash/worker-invariants.destructive.test.ts` | W3 W5 W6 B1 |
| `crash/h1b-real-kill.destructive.test.ts` | R1 (SIGKILL / taskkill) |
| `chaos/goal-loop-chaos.destructive.test.ts` | L1 |
| `stress/interleave.destructive.test.ts` | W1 W2 W3 W5 B1 |
| `soak/liveness.destructive.test.ts` | L1 W4 W5 W6 |
| `harness/invariants.destructive.test.ts` | every checker red then green |

Never part of `npm test`. Run `npm run test:destructive` from the repo root.

H3 also runs a rotating nightly seed (`DESTRUCTIVE_NIGHTLY_SEED`, defaulting to UTC `YYYYMMDD`). A failing seed is pinned into the fixed set next to its fix.

Load, transform, and execution stay off the default suite:

- `vitest.config.ts` excludes `test-destructive/**` so `npm test` does not collect, transform, or run these files.
- This project uses Node's native TypeScript loader (`viteModuleRunner: false`). No Vite transform graph.
- One isolate / one worker: the import graph is paid once, then files run sequentially. Do not turn `isolate` back on to "be safe" — that re-transforms the same graph per file.

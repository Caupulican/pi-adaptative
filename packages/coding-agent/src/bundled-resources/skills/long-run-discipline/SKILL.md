---
name: long-run-discipline
description: "Method for long, unattended or multi-phase work and for measured improvement: state a checkable exit predicate, scale rigor to risk, put the riskiest unknown and the proof harness first, run one hypothesis per iteration with a before and after measurement, keep or revert each change, keep a decision trail, never relax the predicate, and design a bespoke run when no routine fits. Use for 'run until done', 'while I am away', 'overnight', a large migration, performance work against a metric, hillclimb, benchmark tuning, or a goal with many phases."
---

# Long-Run Discipline

## How to use the skill

Load this skill when the work will run long, will run without the owner, or aims at a number. The goal tool, the verification obligations and the decision ledger already record the run. This skill gives the plan that makes the record worth reading.

Freedom Dial: Medium Freedom. The predicate and the verdict rules are fixed. The plan is yours.

## North Star

The owner returns and can trust the result from the record: the predicate, the evidence and the decisions.

## Core Sections

### Frame the run

1. Write the exit predicate as a check that can fail: build/check green, reproduction fixed, metric at or below a target, every file migrated.
2. Count the work: units, effort and the blockers you found while grounding.
3. Pick the rigor. A one-way door or a wide blast radius needs more. A reversible step needs less. Rigor means gates and artifacts, not effort.
4. Reversible work proceeds without asking. Ask only for an irreversible action or a product choice that no experiment can settle.

### Design the run

1. Split the work into small units that you can land one by one. Put the riskiest unknown first.
2. Build the proof harness before the work (a measurement script or check, never a test suite unless the owner asked for tests). Capture the baseline from the code before your change, so the check compares an old value with a new value.
3. For a design with no precedent, compare two designs first (skill `fan-out-and-review`). Skip that for mechanical work.
4. Fan out only across real seams, and give each worker its own output.
5. Write the planned phases down. A reviewer reads that list first.

### Run the loop

Each unit is an experiment.

1. State the hypothesis as a mechanism, not as "try caching".
2. Make the smallest change that tests it.
3. Measure on the real artifact with the frozen harness. For a metric, use the median of several runs and run the regression check.
4. Keep the change only if the predicate advanced and the checks stay green. Otherwise revert it completely. A change that might help is not kept.
5. Write one decision record for each unit, kept or reverted.
6. Verdicts are VERIFIED, NOT VERIFIED or INCONCLUSIVE. INCONCLUSIVE is not a pass. Do not hide a negative result.
7. When a delegate passes a check too easily, read its artifacts. If a worker games the check, reset it and tighten the contract. If the check is wrong, fix the check in a separate change.

### Keep the trail

1. Use the harness decision ledger and the goal evidence as the main record.
2. For extra detail, keep an append-only local log with one row per decision: time, phase, decision, reason, evidence pointer, result. Evidence is a path, a commit or a command, not prose. Keep it out of version control unless the owner asks.
3. A wrong decision gets a new row that supersedes it. Do not edit history.
4. Before you hand back, compare the log with what happened. Remove entries for work you did not do. Add the forks you skipped.

### Plateaus and migrations

1. A plateau is not a stop. Change the kind of hypothesis, combine near misses, re-read the source, or try a larger change.
2. Correctness and simplicity outrank the number. Revert a gain that breaks behavior.
3. Stop when the predicate holds. Report a dead end instead of looping, and never relax the predicate to finish.
4. In a planned migration, intermediate breakage is allowed when you declare where, keep it small and reversible, and prove the end state at the end.
5. Pause safely: record the state, the next step and the open risks so that another session can resume.

## Anti-Patterns

- An exit predicate that cannot fail.
- A baseline taken after the first change.
- A batch of untested changes.
- A gain claimed from reading the code.
- A relaxed target.

## Examples

- Goal: cut startup time. Predicate: median of 10 runs under 300 ms on the real binary. Units: one hypothesis each. Keep two wins, revert three.
- Goal: migrate 40 callers to a new API. Unit: one caller group plus its check. Delete the old API at the end.

## Self-Check

- Can the predicate fail?
- Was the baseline taken before the change?
- Does each kept change have a measurement and each reverted change a reason?
- Does the log match the work?

## Known Gaps

- The skill does not schedule wakeups. The goal loop and background tasks do that.
- Commit only when the owner asks.

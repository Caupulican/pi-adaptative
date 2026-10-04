---
name: prove-it-and-blast-radius
description: "Proof method for a change: verify the real artifact instead of a proxy, trust receipts and diffs instead of a worker's summary, climb a five-step confidence ladder for each safety fact, find what a small change can break outside the diff, label each claim measured, inferred or guess, and sequence work in units that each end in a check. Use before declaring a task done, for 'what could this break', 'blast radius', 'prove it works', review of a risky diff, or a completion account that lists regressions."
---

# Prove It And Blast Radius

## How to use the skill

Load this skill before you report a change as done, and when a small diff touches shared code. The harness checks completion claims against receipts and requires evidence for each regression you name in the account. This skill gives the method for gathering that evidence.

Freedom Dial: Low Freedom for the ladder. High Freedom for the choice of check.

Which checks you may run follows the owner's current mode: reading, build and check by default; live runs only when the owner allows them; tests only on an explicit owner request. A step the mode does not allow leaves the claim labelled inferred, never measured.

## North Star

Every claim in the report rests on something you observed on the real artifact. A claim without that stays labelled as unproven.

## Core Sections

### Prove the real artifact

1. Build it. A build is necessary and not sufficient.
2. Run the feature path the way a user would. Read the actual value, not a cached or derived copy.
3. For an integration, exercise the full path from input to output.
4. For delegated work, inspect the diff and the files. A worker summary is not proof.
5. When a check fails, suspect the way you observed before you suspect the system. When a check passes too easily, do the same.
6. Prefer a small script that repeats the check over a one-time look. Keep its output.

### Work in units

1. Split a sweep or migration into units that each end in a check.
2. Run the check before you start the next unit.
3. A break found at the unit that caused it is cheap to locate. A break found after a batch is not.

### The confidence ladder

For each fact that the safety of the change depends on, climb as far as is cheap and say where you stopped.

1. You said so. This has no weight.
2. You pointed at the line. Give the file and line, or the source of the library.
3. You showed the bad case cannot happen. You walked the failure step by step and it does not reach.
4. You ran it. A script or check calls the real code and fails if you are wrong.
5. You reproduced it in the running program.

A fact that stays below step 4 is reported as unproven.

### Find the blast radius

1. Read the change: the symbols it adds, changes and removes, and any behavior the diff does not spell out.
2. Find the one fact the change is safe because of. Most risky changes depend on one fact. Prove that fact first.
3. Look where text search stops: library source and version, timing and teardown order, wire formats, stored data, another language that reads the same bytes, flags, code three calls away.
4. State each risk with how it breaks, the file and line, how likely it is and what it costs. List the risks you cleared separately.
5. Report the cheapest check that would catch the real failure.

### Label claims

Write each claim in the report with its label: measured (you ran it), inferred (you read it) or guess. Never give the owner a check that you could run yourself.

### When the owner asks for tests

Write tests only when the owner asks. A test must call the code the way a user does and assert a literal value. If the test still passes when every imported function returns undefined, rewrite the assertion or delete the test. Do not assert that a mock was called, and do not copy a constant out of the code.

## Anti-Patterns

- "It compiles" as proof.
- A summary from a worker used as evidence.
- A list of callers presented as a blast radius.
- A safety fact stated at step 1 of the ladder.
- A check that was never run, reported as passing.

## Examples

- Change: a cache now drops entries by age. Safety fact: only entries no reader holds are dropped. Proof: a script that holds an entry, runs the cleanup and reads the entry.
- Change: a field is renamed in a stored file. Risk: old files on disk. Check: load a saved file from before the change.

## Self-Check

- Is each safety fact at step 4 or above, or labelled unproven?
- Did I run the check on the final code, not an earlier edit?
- Does each claim in the report carry a label?

## Known Gaps

- The ladder does not give a number. It orders the evidence.
- A change with no runnable surface can reach only step 3. Say so.

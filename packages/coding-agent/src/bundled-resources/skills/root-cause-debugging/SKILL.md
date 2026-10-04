---
name: root-cause-debugging
description: "Debugging method: reproduce first, trace the symptom to its root cause, test hypotheses with instrumentation, and never hide a failure with a guard, a catch block or a lint or type suppression. After two failed fixes that share one assumption, name the assumption and test it. Use for a bug, crash, failing check, regression, flaky behavior, 'why does it fail', a stalled recovery loop, a goal completion that needs a cause, or a refused suppression."
---

# Root-Cause Debugging

## How to use the skill

Load this skill when a defect needs a cause. The harness requires a cause account for a bug-fix goal. It also refuses an added lint or type suppression that has no evidence-backed assumption. This skill gives the method that satisfies both.

Freedom Dial: Low Freedom for the order of steps. High Freedom for the choice of instrument.

## North Star

Remove the cause of the defect so the symptom cannot return. Prove it by running the same reproduction on the fixed code.

## Core Sections

### 1. Reproduce first

1. Write the smallest command, input or sequence that shows the defect on the real surface.
2. Run it. Record the exact output.
3. If it does not fail, force it: change the input, the timing or the state until it fails, or add instrumentation. Do not guess.
4. Do not hand the reproduction to the owner when you can run it yourself.

### 2. Find the cause

1. List the candidate causes. Rule them out one by one. Pick the test that removes the most candidates.
2. When program state is unclear, add a log line or a probe and read it while the code runs.
3. Ask why until the answer is a mechanism you can point at in the code. A mechanism has a file and a line.
4. After a restart, suspect stale state first: cache, lock file, serialized state, config.

### 3. Fix it where it lives

1. Change the owner of the broken rule. Do not patch the caller that noticed it.
2. Do not add a guard, a catch block, a default value or a suppression that only hides the failure.
3. Search for the same pattern. Fix every instance or state which instances remain.
4. If a workaround needs a paragraph to explain it, the code is wrong. Change the code.
5. A suppression is correct only when the rule is wrong for a reason you can show, such as a vendor type that you cannot change. The completion account must then name the file and cite verified evidence.

### 4. Prove it

1. Run the original reproduction on the fixed code when the owner allows live runs; otherwise label the claim inferred. Show the failing output before and the passing output after.
2. Run the narrowest nearby check for the changed area.
3. If the proof passes too easily, suspect the observation method before the system.
4. Write tests only if the owner asked for tests.

### 5. Attack the premise

1. Two or more fixes that failed the same check share a premise. Write the premise as one sentence.
2. Count which actors, inputs or calls hold the failure. A skewed count shows something assigns them that role.
3. Test the premise directly. Remove the cause of the skew. Do not add a return path or a rebalance that leaves it in place.
4. If the count is even, the premise is not the cause. Look elsewhere and keep the count as evidence.

### 6. Account for the cause

State in the completion account what was wrong, why it was wrong, and how the change removes it. Cite the evidence ids of the reproduction and the passing run.

## Anti-Patterns

- A null check that silences a crash.
- A retry loop around a failure that has a cause.
- A suppression comment with no evidence.
- A fix that the owner must verify by hand.
- A new attempt that repeats the old premise.

## Examples

- Symptom: a list shows a stale item after a restart. Cause: the cache file outlives the schema change. Fix: validate the cache version at load. Proof: restart the program with the old file and show a fresh list.
- Symptom: a type error at a call site. Cause: the parser returns a wider type than the caller needs. Fix: narrow at the parser. Do not add a cast at the caller.

## Self-Check

- Did I run the reproduction before and after the change?
- Can I name the mechanism, with a file and a line?
- Does the diff add any guard, catch block or suppression? If yes, is it accounted for?
- Did I search for the same pattern elsewhere?

## Known Gaps

- The method does not cover performance regressions. Use `long-run-discipline` for a measured metric loop.
- The harness reads only the patch. It does not read new untracked files for suppressions.

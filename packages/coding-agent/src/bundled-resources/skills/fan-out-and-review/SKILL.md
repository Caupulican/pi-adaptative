---
name: fan-out-and-review
description: "How to run parallel workers and independent review with the delegate and peer tools: partition work into slices with a coverage table, race the same brief and pick by a rule declared first, run an arena of competing candidates with a rubric, pick a base and graft, give each worker its own output, verify artifacts instead of summaries, and sort review findings into act on, consider, noted and dismissed. Use for 'arena', 'swarm', 'fan out', 'in parallel', 'compare approaches', 'adversarial review', 'second opinion', 'interrogate', or a design with no precedent."
---

# Fan Out And Review

## How to use the skill

Load this skill when independent work or an independent opinion is worth its coordination cost. Keep trivial, dependent and interactive work local. Only the root starts workers. Workers report back and never start workers.

Freedom Dial: Low Freedom for the shapes. High Freedom for briefs.

## North Star

Parallel work and review give more evidence than one pass. Aggregate the evidence, check the artifacts, and settle every finding.

## Core Sections

### Pick the shape

1. Partition: each worker takes a different slice. Use it for coverage, such as one worker per package.
2. Race: several workers take the same brief. Use it when attempts differ in quality. Declare the selection rule first: first pass, rank all, or best of.
3. Arena: several workers each produce a full candidate for a design or an artifact. You pick a base and graft parts of the others.
4. Mixed: slices, with a race inside the slice that matters.

### Dispatch

1. Write a stand-alone brief for each worker: goal, scope, the exact slice or arm, how to verify, what to report, and the owner's test rule verbatim: no tests, no test files, no test runs unless the owner asked (state the owner's current mode, for example builds and checks allowed).
2. Start each worker with the delegate tool. The tool refuses a second compatible worker unless you pass `parallelWork` with `independentOf` and a justification. Name the running workers in `independentOf`.
   For a partition or a race, use the built-in primitive: `delegate start` with `slices` (2 to 8 entries of `id` and `instructions`) dispatches one worker per slice under one group, and `race` (2 to 4) dispatches that many attempts of the same brief. `delegate status` lists each group. A slice with no accepted result shows as a `COVERAGE GAP`. In a race the first accepted result cancels the other attempts that are still running or queued, and a later accepted result is attributed, not cancelled.
3. Give each worker its own output: its own path, directory or lane. Remove the sharing before you add a lock.
4. Wait for several workers with the delegate `wait_many` action. Do not poll their output.
5. If a worker drops out, continue with the rest and record the drop.

### Aggregate a partition or a race

1. Every required slice needs a result. A missing slice is a gap. Say so.
2. Keep a compact table: slice, status, one-line evidence, issues.
3. Apply the declared selection rule. Do not paste raw worker output.

### Run an arena

1. State the artifact and write 3 to 6 gradeable criteria before you start. Candidates see the task. They do not see the rubric.
2. Read every candidate in full. Score each one per criterion.
3. Pick as base the candidate a future maintainer can extend with the least risk. When two tie, take the smaller interface.
4. Name what you graft from each other candidate and what you reject. If all candidates converge, ship the shared shape.
5. If the candidates diverge widely, the task was under-specified. Re-frame it and run again.
6. Verify the merged result as you would verify any change.

### Review with the peer tool

1. Use the peer tool for an independent review by a different model. Give it the full change, the evidence and the known limits. Do not hide adverse facts.
2. Sort each finding: act on (blocks a real change), consider (valid, cost unclear), noted (valid, low impact), dismissed (wrong, with the reason).
3. A finding from two reviewers has more weight than a lone finding. Read the lone finding anyway.
4. Reproduce each candidate defect in your own lane. Fix the confirmed ones and recheck. Report the rejected ones with evidence.
5. Never ask again with the same request to get a better answer. An unsettled finding stays open until you gather new evidence.

### Check the work you receive

Read the diff and the files of delegated work. Run the check yourself. A worker report is a claim, and the artifact is the proof.

## Anti-Patterns

- Starting many workers on a task that one worker can finish.
- Two workers that write the same file.
- A race with no selection rule.
- Averaging two incompatible designs.
- Closing a review finding because the reviewer found nothing the second time.

## Examples

- Partition: check every package against its own check script. One worker per package. One table of results.
- Arena: three workers each draft the interface of a new module. Score by the rubric. Take the best as base. Graft the error type from the second.

## Self-Check

- Did I declare the shape and the selection rule before the first dispatch?
- Does each worker have its own output?
- Did I read the artifacts, not only the summaries?
- Is every finding acted on, rejected with evidence, or open?

## Known Gaps

- A group is root-only and needs the async worker wiring. You still apply the selection rule you declared and check the artifacts: the host reports coverage and cancels race losers, it does not judge quality.
- Review quality depends on the models that are available.

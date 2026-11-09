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
   For a partition or a race, use the built-in primitive: `delegate start` with `slices` (2 to 24 entries of `id` and `instructions`; an `id` is 1 to 24 letters, digits, `.`, `_` or `-`, unique in the group) dispatches one worker per slice under one group, and `race` (2 to 8) dispatches that many attempts of the same brief, named `c1` to `cN`. One call takes `slices` or `race`, not both, and a declaration the host refuses starts no worker. Each member is a fresh worker, budgeted and charged separately. `delegate status` lists each group. A slice with no accepted result shows as a `COVERAGE GAP`. In a race the winner is the accepted candidate that finished first; a result still waiting for independent verification counts as running, not accepted. The win cancels the other attempts that are still running or queued, and a later accepted result is attributed, not cancelled. A loser that cannot be cancelled is retried once on the next terminal event, then stays on the group as `CANCEL FAILED` until it ends.
3. Give each worker its own output: its own path, directory or lane. Remove the sharing before you add a lock.
4. After starting the workers, end the turn. Each worker's terminal handoff wakes you with a completion notification, so do not use the delegate actions `wait` or `wait_many` and do not poll their output. Use `delegate wait_many` only when the very next step of this same turn cannot proceed without the result.
5. If a worker drops out, continue with the rest and record the drop.

### Aggregate a partition or a race

1. Every required slice needs a result. A missing slice is a gap. Say so.
2. Keep a compact table: slice, status, one-line evidence, issues.
3. Apply the declared selection rule. Do not paste raw worker output.

### Combine steps with plan joins

For work with several dependent parts, the `plan` tool runs a graph of steps on workers. A step with `join` combines the steps named in its `uses`: 2 to 24 steps, or 1 to 24 for `verify`. Code decides every join from the members' recorded outcomes, never from worker prose. The offered joins are `collect`, `reduce`, `vote`, `race` and `verify`; `merge` is reserved and refused. The plan tool has no quorum field, so a `collect` waits for every member.

- `reduce`: when every member has settled, one worker combines their results into one answer to the step's `question` and names each disagreement. The join's result is that worker's outcome.
- `race`: settles on the first member the host sees accepted; if several are accepted by the same pass, the one listed first in `uses` wins. Members still running are cancelled. If no member is accepted, the race settles once all members have settled, with one gap per member that failed. This differs from a `delegate` race, whose winner is the accepted candidate that finished first.
- `vote`: no worker votes. The join waits for every member to settle, and `question` (what the winner must meet) is required. No accepted member settles with gaps and no winner. One accepted member wins. Two or more: System One answers one Choice, which accepted candidate best meets the question, over code-built outcome lines (worker words stay in the report files). Code takes the winner only at probability 0.90 or more with a lead of at least 0.15 over the runner-up. Any other reading, a System One outage or timeout included, names no winner: the join settles as partial over every accepted candidate, and you read them all.
- `verify`: when every member has settled, a read-only worker (no write scope, told to change no file) checks each member's claims against the files and commands. Verify steps are released ahead of other ready steps. The join's outcome needs every subject and the verifier to succeed, so a failed verdict fails the join. The host also adds a verify step on its own: when a work step's outcome asks for independent verification, the plan is revised with a step `<id>-check` that takes over that step's dependents (and its place as the final step). If the plan has no room for the step, the work step is held for you to revise the plan.

Each settled join other than the final one wakes you with one plan update. Read the join's result; a result that is accepted, meets every cited requirement and has no gap reads as a report.

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
- A plan `vote` is the one join where the host judges quality, and only through a decisive System One reading; its thresholds are not yet measured against a question set. Without a decisive reading you read every accepted candidate yourself.
- The plan tool offers no quorum and no `merge` join yet.
- Review quality depends on the models that are available.

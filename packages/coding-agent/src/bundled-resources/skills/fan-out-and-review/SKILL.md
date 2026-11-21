---
name: fan-out-and-review
description: "Choose how to delegate a bounded task, partition independent work, race competing approaches or obtain independent review. Use for 'give this to one worker', 'audit and fix this in one worker', 'fan out', 'arena', 'swarm', 'in parallel', 'compare approaches', 'adversarial review', 'interrogate' or 'second opinion'. Covers worker briefs, plan joins and checking the delivered artifacts."
---

# Fan Out And Review

## How to use the skill

Load this skill when independent work or an independent opinion is worth its coordination cost. The root or a bot with delegation tools can assign work. Workers complete their assignments and report back to their director.

Freedom Dial: Low Freedom for the shapes. High Freedom for briefs.

## North Star

Choose the fewest workers that can deliver the requested outcome and evidence. Check the artifacts and account for every material finding.

## Core Sections

### Pick the shape

Handle a quick inspection directly when it is within the session's role. In director mode, give a bounded project edit to one worker. An audit and its repairs belong together when they touch the same files. Name the skill, the paths the worker may edit, and what evidence to return. Use `assign` with the task and its writable files when available. A director with only `delegate` can use its start action.

When several workers can contribute independently, choose a shape.

1. Partition: each worker takes a different slice. Use it for coverage, such as one worker per package.
2. Race: several workers take the same brief. Use it when attempts differ in quality. Declare the selection rule first: first pass, rank all, or best of.
3. Arena: several workers each produce a full candidate for a design or an artifact. You pick a base and graft parts of the others.
4. Mixed: slices, with a race inside the slice that matters.

### Dispatch

1. Give each worker a stand-alone brief with the goal, its write scope, the expected evidence and the owner's verification limits. Carry permissions to maintain tests and permissions to execute them separately, exactly as given.
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

For work with several dependent parts, the `plan` tool runs a graph of steps on workers. A step with `join` combines the steps named in its `uses`: 2 to 24 steps, or 1 to 24 for `verify`. The host settles joins from recorded outcomes and uses candidate evidence when judging a vote. The offered joins are `collect`, `reduce`, `vote`, `race`, `verify` and `merge` (a merge lands each member's worktree onto the default branch in order, and holds until `worktreeSync.gateCommand` is set while the gate is on). A `collect` waits for every member by default. Set `need` when a specified number of successful members is sufficient and remaining work can be stopped.

- `reduce`: when every member has settled, one worker combines their results into one answer to the step's `question` and names each disagreement. The join's result is that worker's outcome.
- `race`: settles on the first member the host sees accepted; if several are accepted by the same pass, the one listed first in `uses` wins. Members still running are cancelled. If no member is accepted, the race settles once all members have settled, with one gap per member that failed. This differs from a `delegate` race, whose winner is the accepted candidate that finished first.
- A `vote` compares candidates against the question and its criteria. The host considers reported changes and checks, and uses the verdicts of verification steps already attached to the vote. If the comparison is inconclusive, read the candidate reports and the reasons in the partial result before commissioning more work.
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

Inspect the changed artifacts against the brief. Check that any cited verification covers this revision and the claimed outcome. If a material claim still lacks evidence, use the smallest permitted check that can settle it. Honor any independent review the owner or host requires.

## Anti-Patterns

- Starting many workers on a task that one worker can finish.
- Two workers that write the same file.
- A race with no selection rule.
- Averaging two incompatible designs.
- Closing a review finding because the reviewer found nothing the second time.

## Examples

- “Have one worker audit and fix comments in the loader.” Assign the loader, its relevant ADR and lint baseline to one worker with the `delete-comment` skill. Ask for the diff, retained comments and issue drafts. The parent handles authorized tracker filing.
- Partition: check every package against its own check script. One worker per package. One table of results.
- Arena: three workers each draft the interface of a new module. Score by the rubric. Take the best as base. Graft the error type from the second.

## Self-Check

- For multiple workers, did I identify independent contributions or declare how competing results will be selected?
- Does each worker have its own output?
- Did I read the artifacts, not only the summaries?
- Is every finding acted on, rejected with evidence, or open?

## Known Gaps

- Fan-out needs a directing session with the group actions available. You still apply the selection rule you declared and check the artifacts: the host reports coverage and cancels race losers, it does not judge quality.
- The host grades a vote from the evidence available to it. A claim that the candidate report cannot establish may still require inspecting the artifact.
- Review quality depends on the models that are available.

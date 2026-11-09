# Stakes and brief

## Reading the stakes

The host computes a stakes level for its proof sheet from the same facts listed here; the agent reads them the same way before delegating, so the two agree.

| Fact | Where it is visible | Counts as |
|---|---|---|
| Files changed | the diff, a worker's changed files | elevated past 10 files |
| Protected path touched | the protected-path list in settings, harness and credential files | high |
| Publish or destructive edge | push, tag, release, publish, force, delete, reset in the commands | high |
| Money | paid calls, purchases, spend recorded against the goal | elevated |
| Others affected | outbound channels, shared branches, another lane's files | high |
| Inconclusive items or failed checks | the result's own receipts | elevated |

Low: no fact present. Elevated: one elevated fact. High: any high fact, or two elevated facts.

## What to hand off

| Stakes | Hand off | Keep at the root |
|---|---|---|
| Low | the whole task, including the decision | reading the proof sheet |
| Elevated | execution and the first check | the plan, the final check, the report |
| High | execution only, in narrow slices | the plan, every decision, the final check, the fresh-context review, the quiz offer |

Being wrong is cheap when the change is local, reversible and only the agent's own scope pays for it. It is expensive when the owner or someone else pays: keep that reasoning.

## The brief

| Field | Question it answers | Tool field |
|---|---|---|
| Ask | what the owner said, in the owner's words | `goal` (one line), the goal objective |
| Audience | who reads or uses the result | `note` |
| Done line | what tangible thing proves it finished | `doneWhen`; goal requirements with a check |
| Out of scope | what must not be touched or decided | `outOfScope` |
| Sources | where the original ask and evidence live | `refs` |

Ask once with `ask_question` when the done line or the out-of-scope list is missing and the task is non-trivial (more than one file, any stakes fact, or more than one reasonable reading). A one-file, low-stakes edit with an obvious done line does not need the question.

Interview mode: when the first answer still leaves two readings, ask one short question at a time, each with the options you can see, until the done line is a check someone else could run.

## Rewrite, do not tweak

After two corrections of the same output, the brief is the defect. Rewrite it from the owner's original words, add the two corrections as out-of-scope or done-line items, and start a fresh attempt.

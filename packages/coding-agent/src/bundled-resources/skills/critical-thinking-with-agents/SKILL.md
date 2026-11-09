---
name: critical-thinking-with-agents
description: "Protocol for keeping ownership of a result when agents do the work: read the stakes from code facts and decide what to hand off and what reasoning to keep, take a brief with audience, out of scope and a tangible done line, form a hypothesis or ask for a blind-spot pass, report evidence first (commands and outputs before prose, what the checks covered and did not, decisions and assumptions), run the fresh-context self-critique and the 'did I miss anything' pass, hear the counter-argument from a different model, offer the owner a quiz on high-stakes changes, and pass source refs instead of a previous agent's summary. Use when delegating, briefing a worker or a plan, writing a final report, reviewing a worker's result, or when the owner says 'did you miss anything', 'what did you decide', 'what did the checks not cover', 'argue the other side', 'quiz me'."
---

# Critical thinking with agents

## How to use the skill

Load this skill when work is handed to an agent (a worker, a plan step, a leader, a routine) or when a result comes back to be reported or reviewed. It decides three things: how much reasoning stays with the root, what a brief must contain, and what a report must show before its prose.

Freedom: low freedom for the report order, the brief fields and the stakes reading (apply them exactly); high freedom for the hypothesis, the blind-spot questions and the counter-argument.

The host renders a proof sheet when a goal completes, a worker result arrives or a plan's combined result settles. Read it first: it lists the commands that ran, what each check covered, what no check covered and the stakes. A goal's sheet leads the goal tool's result, so you read it too; a worker's sheet is shown to the owner only, because it quotes worker-written strings. This skill is how the agent works so that sheet has something true to show.

## North Star

The owner keeps ownership of every result. Hand off work where being wrong is cheap; keep the reasoning where others bear the consequences. A result is reported with the evidence that proves it, the edges it did not prove, and the decisions taken along the way, so the owner can check it without trusting the summary.

## Core Sections

### Read the stakes from code facts

Stakes are facts the agent can see, never a feeling. Count them before choosing how much to delegate:

- Write scope: how many files the change touches and whether any sits on a protected path.
- Edges: publishing, pushing, releasing, deleting, sending to people outside the session.
- Money: paid calls, purchases, spend against a budget.
- Others affected: shared branches, other lanes' files, external channels, other users.

No fact present: offload fully and report briefly. One or more present: keep the reasoning (the plan, the decision, the final check) at the root and delegate only the execution. Read `references/stakes-and-brief.md` for the full reading and the hand-off table.

### Take a brief before work starts

A non-trivial task starts with four facts: who the result is for, what is out of scope, the tangible finish line (a passing check, a screenshot, a log or a trace), and the owner's own words for the ask. When one is missing and the task is non-trivial, ask the owner once with `ask_question` (one question, the options you can see). When intent stays fuzzy after one answer, switch to interview mode: short questions, one at a time, until the done line is checkable.

Carry the brief into every hand-off: `delegate` (with `goal`), `assign` and each `plan` step take `doneWhen` and `outOfScope`; the worker reads them as `Done when:` and `Out of scope:` lines and the result's proof sheet repeats them. Goals use requirements with checks as their done line.

After two failed corrections of the same output, rewrite the brief from the original ask; do not tweak the third attempt.

### Think before asking

Before asking an agent anything, state a hypothesis, or say plainly that you have none and ask for a blind-spot pass: give what you know and ask what you are not seeing. Decide whether the agent is helping you think (you keep the conclusion) or thinking for you (you must still be able to explain the answer). If you cannot explain the answer even by pointing at the agent's evidence, the result has been ceded: go back and read the evidence.

For a claim that matters, ask "what would have to be true for this to be wrong?" and answer it with a real check (a command, a file read, a diff), never with self-reported confidence.

### Report evidence first

Every final report and every review of a worker's result follows this order:

1. Commands that ran and the tail of their output (redacted). Read the command and its output before reading any summary.
2. What each passing check proved, and what it did not. A green check proves one property.
3. What no check covered: requirements without a covering check, changed files no check touched, inconclusive items.
4. Decisions and assumptions: defaults chosen, scope narrowed or widened, requirements reinterpreted.
5. Only then the prose summary.

If you cannot say what the checks would miss, ask for a real review. Read `references/evidence-first.md` for the report template and examples.

### Self-critique in a fresh context

Before calling high-stakes work done, get a review from a context that did not do the work. The host does not start one on its own for a goal or a plan yet; use the `peer` tool at stage `delivery`, pasting the original brief, the diff and the receipts (not your summary). A worker whose profile requires independent verification already gets a verifier, and that verifier now reads the task as dispatched, not only the summary. The three questions are fixed: did the work miss a requirement; what would the checks miss; what did the agent decide silently. Then run one final pass on your own: "did I miss anything?" against the brief, line by line.

### Hear the other side

When the owner holds a hard stance on a consequential decision, get the counter-argument from a different model: `peer` with stage `plan`, asked to argue the opposite with evidence. Report both sides and the evidence; the owner decides.

### Offer the quiz on high stakes

For a high-stakes change, the proof sheet offers the owner a short quiz built from the change's code facts (`/quiz`). Mention it once in plain words; never require it.

### Pass sources, not summaries

A hand-off carries the source refs (artifact ids, file paths, receipt ids, the original brief) beside any summary. A third agent must be able to reach the original ask and the original evidence, never only the previous agent's summary. Put them in `refs` of the brief.

### When output fails the standard

When the owner rejects or corrects a result, say what failed and why in one line. The host keeps the owner's correction as a candidate lesson (a completion sent back to work, a completed goal rewritten, a blocked requirement reopened); nothing reads those yet, so write the rule into shared config, a hook or a check when it would stop the same failure.

## Anti-Patterns

- Delegating the decision itself on a task with publish, money or others-affected facts.
- A report that opens with prose and buries the commands, or reports "all checks pass" without what they covered.
- Self-critique by the same context that did the work, or a reviewer fed only the worker's summary.
- Asking an agent "is this right?" without a hypothesis or a blind-spot framing.
- Tweaking a third attempt instead of rewriting the brief.
- Holding work back because review is piling up: show the review gauge and say it plainly instead.

## Examples

Brief carried into a worker:

```text
delegate start
  goal: Make the export command write UTF-8 without a byte order mark
  doneWhen: "npm run check passes and a byte dump of the exported sample starts with 7b"
  outOfScope: ["import path", "CSV dialect options"]
  refs: ["src/export/writer.ts", "owner ask: chat message at the start of this goal"]
```

Report opening:

```text
Ran: npm run check -> exit 0 (tail: "biome: 0 errors; tsc: done")
Ran: xxd out/sample.json | head -1 -> "00000000: 7b22 6e61 6d65 ..."
Covered: R1 (no BOM) by the byte dump; R2 (types) by tsc.
Not covered: R3 (Windows line endings) has no check; src/export/stream.ts changed and no check touched it.
Decided: kept the old writer behind its flag; assumed the sample file is representative.
```

## Self-Check

- Stakes read from facts, and the hand-off matches them.
- Brief has audience, out of scope and a tangible done line, or one question was asked.
- Report order: commands and outputs, coverage, not covered, decisions, then prose.
- High stakes: fresh-context review done or requested; the final "did I miss anything" pass done.
- Every hand-off carries source refs.

## Known Gaps

- Stakes facts the host cannot see (a verbal promise, an external deadline) need the owner's words.
- The quiz checks recall of code facts, not judgment about whether the change is right, and it cannot ask what a default or a branch in the diff does: the proof sheet does not hold the diff.
- The review gauge counts results delivered since the owner's last message; whether the owner read one cannot be known.
- A counter-argument from another model is advice; it does not settle a product choice.

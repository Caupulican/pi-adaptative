# Decision design

Read this before writing a question set. System One returns typed probabilities for small questions; the decision is the code that combines them.

## The circuit

A decision is a circuit: inputs flow through nodes of code and nodes of judgment to named exits.

1. List the exits the system already has (the routes, the verdicts, the next actions). The model never adds one.
2. For each exit, write the rule that reaches it.
3. Mark every input in every rule:
   - **Code node:** a lookup, arithmetic, an eligibility rule, an exact match, a check result, a count. Compute it and keep it as a fact. "The claim is eligible and the amount is within the limit" is code.
   - **Judgment node:** meaning code cannot compute. "Does the request ask for money back?" is a Noul. Each is its own narrow question.
4. Combine them in ordered exits written in code. The first rule that matches decides.

Do not fold the decision into one Choice with rules and caveats in `criteria`. It works until a new input breaks it, and then the only fix is more prose in `criteria`: the intelligence sits at the wrong layer and the result is one probability with nothing inside to inspect.

## Why the decomposed form

- **Clarity:** the atomic judgments and the logic paths show what flows through and which edge cases need an exit.
- **Observability:** a miss reads "these judgments came back and this rule fired", so you can tell whether a judgment, a fact or a rule was wrong.
- **Extendability:** a new exit adds a judgment and a fact and leaves existing judgments as they were. Questions in one request are evaluated independently, so adding a question does not change validated ones. Adding new state can steer existing answers: give a judgment that needs new evidence its own request.

For an existing prompt-and-parse step, ask which part is a lookup, which is a judgment and which exit each combination reaches, then rebuild it in that shape.

## Thresholds

- Accept an exit at probability 0.90 or higher; to require absence, at 0.10 or lower. A looser threshold needs a written reason next to the rule.
- Never round a probability up to pass. Noul has no separate confidence; do not invent one or read 0.5 as medium intensity.
- Choice probabilities are a distribution over the options you gave; compare the option you would act on against the same floor.

## Outcomes

- **accept:** a rule matched with its thresholds met.
- **reject:** the evidence says no (a confident adverse reading).
- **open:** nothing matched or the evidence is not sufficient. Open asks for more evidence or a better question; it is never reported as a rejection.
- **error / stale evidence:** the call failed or the evidence changed under the question. Neither is a verdict.

Pair a judgment with an evidence-sufficiency Noul over the same state so "not enough to tell" is a reading, not an `other` option.

## Re-deciding

Keep the raw answers. A changed threshold, weight or exit re-decides from the saved answers without another call. Make another call only when evidence is new or the question is materially different, and give new evidence its own request. Never reword a question to obtain a different probability from unchanged evidence.

## In this harness

Harness code uses System One the same way: atomic questions through the catalog (one judgment per question), ordered exits in code, and a decision trace. See `docs/system-one.md`. Do not add a judgment to settle something a deterministic source already states.

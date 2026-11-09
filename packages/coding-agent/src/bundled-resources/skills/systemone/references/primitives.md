# Primitives

Call `systemone` with `action: "evaluate"` and an `evaluation` object holding `state` and `questions`. A question has `type`, `instructions` and the relevant `criteria`.

| Primitive | Meaning | Use for |
| --- | --- | --- |
| `choice` | One option from competing candidates, with its distribution; criteria map option names to descriptions | Classification, routing, action selection, disambiguation, source-span or value selection |
| `noul` | Probability that a condition is true; optional true/false descriptions | Independent labels, bug patterns, contradictions, injection or error detection, claim or citation support, evidence sufficiency |
| `score` | Probability-weighted position on an ordered array of 2 to 10 self-contained levels, with confidence | Relevance, severity, quality, prioritization, ranking, reusable semantic features |

## Fields and limits

- `instructions` and every `criteria` entry accept a string, a structured object or an array. Instructions and Choice/Noul descriptions also accept null; Score levels must not be null (the live API rejects nullable levels, and the tool rejects them locally). Prefer an explicit question; question ids carry no meaning to the judge.
- Choice supports up to 255 options. Keep candidate coverage complete, include no-match and insufficient evidence when they can occur, and copy an extracted value from the source after selecting it.
- Noul has no separate confidence. Choice and Score report confidence over their distributions; compare it to a floor in code.
- Reuse raw scores for changed weights or views when the evidence and question meaning are unchanged.
- Backticked paths in a question point attention at named evidence in structured state; they do not filter the state.

## Shapes that work

- One narrow question per judgment, written so it can be answered from the state alone.
- Independent questions together in one request when they share evidence.
- A Score for ordering candidates, then code takes the top; a Choice when the options are mutually exclusive routes.
- Deterministic code still owns calculations, exact lookups, bounds and every actual execution.

# Review and evidence

## Review

Use `action: "review"` with a `review` object holding `state`, `questions` and an optional `confidence` of `"high"` (0.95) or `"max"` (0.99), required for every question. Each question has `instructions`, `criteria` (named descriptions) and the `expected` option that passes.

```json
{"action":"review","review":{"state":"<source and check results>","confidence":"high","questions":{"claim":{"instructions":"Does this evidence support the claim?","criteria":{"supports":"Supported","insufficient":"Missing evidence"},"expected":"supports"}}}}
```

- Use review to judge one completion claim after the relevant evaluations and deterministic checks. Ask independent questions together; chain calls only when new answers change the evidence the next judgment needs.
- Supply competing options that include insufficient evidence. System One returns typed judgments and probabilities, never explanations or patches.
- Approval needs `accepted: true` for the exact reviewed evidence plus the required deterministic checks. A confident adverse verdict still blocks. Missing, malformed, cancelled, failed or low-confidence reviews stay open. Confidence measures the answer distribution, not correctness.
- Fix findings or gather the specific missing evidence before another review. Keep every earlier result and explain each material evidence change. If iterations stop producing new evidence, report the open question and continue other authorized work.
- Run only the builds and checks the owner's current mode permits; tests run only when the owner asked for them.

## Keep the evidence complete

Include the claim, the source identity and revision, the relevant full implementation and its callers, the contract, the baseline, build and check results, negative controls, prior adverse judgments, known failures, exclusions and untested conditions. Relevance permits removing unrelated material; it never permits withholding contradictory evidence. For a large audit keep an explicit coverage manifest linking every requirement and interaction to a review, and partition by coherent ownership without splitting away the interaction under judgment. A partition passing does not approve uncovered scope.

## Passing evidence

No transcript is uploaded. Provide evidence inline in `state`, or use top-level `evidenceRefs` so the host snapshots an authorized source without loading it into your transcript: `file:<path>`, `artifact:tool-output:<id>`, `git-diff:<path>` or `git-diff-staged:<path>`. Each source is capped at 512 KiB and a request at 1 MiB; containment and credential-path checks run before reading, known credentials are redacted, and references never execute a command.

## Retained records

Each evaluation or review retains its exact submitted state and questions, request hash, model, answers, confidence, usage and failed question ids in durable session evidence. The model receives the judgments and a reference, not a copy of the submitted evidence. Read one with `action: "evidence", id: "<evidence.id>"`, and continue with `nextOffset` as `offset` until it is absent. Foreground and worker agents share the parent's store; unrelated sessions cannot read it. A storage failure blocks approval. An HTTP failure stays an error with its evidence reference, never an approval.

## Uncertain or unavailable results

An uncertain or unavailable result returns to the model that owns the work: gather new evidence, use a stronger reasoning model, or make a reversible decision within its grant, keeping unsettled facts apart from confirmed ones. A worker reports what it cannot settle to its parent; only the root asks the owner, and only when authority or evidence is missing. Silence is never approval or cancellation.

## Detect, verify, gate

A bug judgment is a candidate: reproduce it deterministically with a negative control before fixing it at its authoritative owner. A negative judgment is not proof a bug is absent. Then review the updated source with the baseline before closing.

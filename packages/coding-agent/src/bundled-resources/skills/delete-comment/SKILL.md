---
name: delete-comment
description: "Audit and fix code comments and the workarounds they reveal in a requested repository or section, directly or as a delegated worker. Classify tautologies, excuses, stale comments and decision records, fix confirmed defects, preserve decisions in ADRs, prepare issue drafts, estimate removable lines and ratchet a comment ban."
---

# Delete Comment

## How to use the skill

Use this workflow for a comment audit and fix. Carry the selected batch through source edits, repairs, decision records and the lint rule. An explicit read-only review or estimate stops after inventory and findings. When the owner gives a repository-wide scope, inventory the whole scope and report which files the current batch actually reviewed. Use a named section when the owner gives one.

A director can give one worker the whole audit and fix with `assign`, naming the writable files or directories. Use `delegate start` if that is the available assignment tool. Give the worker the requested scope, write access for the repair and the owner's verification limits. An in-process worker reads the skill with `skill { action: "read", name: "delete-comment" }`. Sessions with a skill vault use `load`.

## North Star

A reviewer should be able to recover why a decision was made and where a workaround is tracked after the source comment disappears.

## Core Sections

Inventory actual comment tokens with the language parser or lexer. Capture the original path, line, owning symbol and text before editing. Read neighbouring code, callers and relevant history. Review adjacent line comments as one passage when they express one thought. Split mixed passages into their separate claims.

| Category | Evidence and action |
|---|---|
| Tautology | The code or signature already expresses the whole claim. Delete the comment. |
| Excuse | Verify the shortcut and its impact. Prepare one local issue draft per confirmed defect with the affected symbols, evidence and acceptance criteria. Fix the implementation at its owner within the requested scope, delete the excuse and record the repair in the draft. If the fix requires a wider change, identify that dependency. Include tracker-ready drafts in the handoff so the parent can find or file the remote issues under the owner's authorization. |
| Stale | Verify which symbol, behavior or assumption has changed. Delete the obsolete claim. |
| Decision Record | The comment supplies a non-obvious reason, tradeoff or constraint that still holds. Move it into the relevant architecture decision record (ADR), including the context, choice, consequence and affected symbols. Combine passages about the same decision. |

Check whether a tool or downstream consumer reads the comment. Preserve required license notices, compiler and linter directives, generated-source markers, and documentation consumed by an API or build until its dependency has been addressed. Identify retained comments individually and give the reason. Preserve embedded source fixtures, strings, regular expressions, token boundaries and significant newlines. If the rationale is unclear, leave the passage in the remaining inventory with the open question.

Use the repository's normal lint entry point. Enrol the reviewed paths and make new ordinary comments fail, including replacements that keep the count constant. Grandfather existing comments by path, exact content and multiplicity. Tighten the baseline when they disappear. In Pi's checkout, `node scripts/check-source-comments.mjs --list <path>` prints the JS/TS inventory, `--inventory <path>` measures it, and `npm run check:comments` enforces `scripts/source-comment-ratchet.json`. For other projects use the check and language tooling available there.

Return the reviewed scope, classifications, changed files, ADRs, issue drafts, gross line savings, retained comments and permitted verification results in the worker's terminal report. The parent checks the delivered changes and handles authorized remote issue filing. An unavailable tracker leaves the local draft available and its publication status explicit.

## Anti-Patterns

A TODO, an unusual implementation or the word “workaround” alone does not establish a defect. Replacing a comment with the same prose in an ADR loses the point of the review. Capture the reason and what a future maintainer would break by reversing the decision.

## Examples

“Validate name” immediately before a call to `validateName` is a tautology. “Do not wait for a second catalog lock while holding the first” explains a lock-order decision. Verify the acquisition policy and retain its rationale in the ADR.

A parent can give one worker this brief. “Use delete-comment on the skill loader. Fix the workarounds, update the ADRs and comment rule, and return the line savings and any issue drafts. Use static verification.”

## Self-Check

Account for every comment in the reviewed section using its original location, classification and disposition. Link the ADRs and issue records. For comment-only edits, compare the parsed code before and after. For implementation repairs, trace existing callers and verify the affected invariant within the project's execution permissions. Report failed scans and unsupported files.

## Known Gaps

Only physical lines consisting entirely of comment text and whitespace can disappear in full. Count each line once, including when several comments share it. Report mixed code/comment lines separately. The gross estimate includes required comments until they are inventoried separately. ADRs, tracking records and the lint rule affect the net repository diff.

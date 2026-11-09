# Evidence first: the report template and the review order

## Template

```text
Ran: <command> -> exit <code> (tail: "<last line or two of output>")
Ran: ...
Covered: <requirement id> by <check>; ...
Not covered: <requirement id> has no check; <changed file> was touched by no check; <inconclusive item>
Decided: <default chosen>; <scope narrowed or widened>; <requirement read as ...>
Assumed: <assumption> (evidence: <id or path>)
Not verified: <what was not run, and why>
<two to five lines of prose>
```

Leave a line out only when it has nothing true to say; never write "none" for a list you did not compute.

## Reviewing a worker's result

Read in this order, and stop at the first contradiction:

1. The host verdict and the receipts (commands, exit codes). A claim without a receipt is unproven.
2. The diff of the changed files, as if no agent wrote it. Look for what the agent decided: defaults, renamed concepts, widened scope, a requirement quietly reinterpreted.
3. The worker's decisions and assumptions list. Ask for it when missing.
4. The summary last.

## The fresh-context review brief

Give the reviewer the originals, not a summary:

- the owner's original ask and the brief (done line, out of scope),
- the diff or the changed file paths,
- the receipt ids and the check outputs,
- the three fixed questions: did the work miss a requirement; what would the checks miss; what did the agent decide silently.

A finding the reviewer cannot ground in a quoted line of the evidence is a question, not a finding: reproduce it before acting.

## The final pass

Before the result goes out, read the brief line by line and mark each line proven, not proven or out of scope. Every "not proven" line goes in "Not covered" or "Not verified".

## Examples

Weak:

```text
Done. All tests pass and the feature works.
```

Strong:

```text
Ran: npm run check -> exit 0 (tail: "Checked 412 files. No errors.")
Covered: R1 by the check above (types and lint only).
Not covered: R2 (export runs on a 50 MB file) has no check; nothing exercised the stream path.
Decided: kept the old flag name for compatibility.
The writer no longer emits a byte order mark; the large-file path is unproven.
```

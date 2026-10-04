---
name: technical-writing
description: "Standard for documents and written deliverables: choose one document mode first (tutorial, how-to, reference, explanation), write sentences to the reader, structure README, RFC, changelog, commit message and pull request text, and remove the tells of machine-written prose. Use when writing or reviewing docs, a README, an RFC, release notes, a changelog entry, a commit message, a pull request description, error text, or when asked to unslop, humanize or tighten writing. Sentence-level style comes from ste100-writing."
---

# Technical Writing

## How to use the skill

Load this skill when the deliverable is text that other people read. Apply the sentence rules from the skill `ste100-writing`. This skill adds the document mode, the layout and the edit pass.

Freedom Dial: Low Freedom for mode and layout. High Freedom for wording.

## North Star

A tired engineer understands the document on the first read, and can find a fact without reading all of it.

## Core Sections

### Pick one mode

Ask two questions. Does the text help the reader to act or to understand? Does the reader want to learn or to work?

1. Act and learn: tutorial. Say what the reader will build. Give a visible result at each step.
2. Act and work: how-to. Give the steps for one goal. Name it by the task. Allow forks with "if".
3. Understand and work: reference. Describe facts only. Mirror the structure of the thing described.
4. Understand and learn: explanation. Give context, reasons and trade-offs. Opinion is allowed here only.

Do not mix modes in one document. Split the document and link the parts.

### Write to the reader

1. Use "you" and the present tense. Use commands for instructions.
2. Put the condition before the instruction. Put the common case first.
3. Use the real names of symbols, files, flags and commands. Do not paraphrase them.
4. Use a heading that carries the point. Use sentence case. Write a task heading as a verb phrase.
5. Use numbered lists for sequences and bullets for the rest. Introduce each list with a full sentence.
6. Say what happens, not how it feels. State a number or a mechanism. If the sentence fits any other project unchanged, delete it.

### Layout by document

1. Commit message: a short subject in the imperative that says what changed. A body that says why. Do not repeat the diff.
2. Pull request: the problem and the user impact first. Then the change. Then how it was checked, with the real command and result. Then open decisions.
3. Changelog: one line per change, under the right heading. Name the user-visible effect.
4. README: what it is, how to install, one working example, where to read more.
5. RFC: the problem, the options with trade-offs, the choice, the cost, what stays open.
6. Error text: say what failed, why, and what the reader can do.

### Edit pass

Scan the draft for these tells and rewrite each one.

1. Praise and chat phrases: "great question", "I hope this helps".
2. Stock words that carry no fact: crucial, pivotal, delve, landscape, tapestry, testament, vibrant, enhance.
3. Large verbs for "is": serves as, stands as, boasts.
4. "Not just X but Y" frames and groups of three that are there only for rhythm.
5. Trailing "-ing" phrases that add nothing: ensuring, highlighting, showcasing.
6. Vague sources: "experts say", "studies show". Name the source or delete the claim.
7. Abstract metaphors for plain things: substrate, wedge, vector, north star, flywheel. Use the concrete word.
8. Long dashes, decorative emoji, bold on every term, title-case headings, curly quotes.
9. Hedges stacked on one claim. Keep one hedge or none.
10. Over-compressed lines: dropped articles, arrows, private abbreviations. Write full sentences.

Then read the draft once more and ask what still looks machine-written. Vary the sentence length. Keep a view where the mode allows it.

## Anti-Patterns

- A tutorial that stops to explain theory.
- A reference page with opinions.
- A commit message that lists every file.
- A summary that repeats the title.

## Examples

- Weak: "This change enhances robustness by ensuring errors are handled." Strong: "The parser now returns an error for an empty file. Before, it threw."
- Weak: "Utilize the flag to facilitate debugging." Strong: "Use `--verbose` to print each request."

## Self-Check

- Does the document have one mode?
- Does each section answer a question the reader has?
- Did I remove every tell in the list?

## Known Gaps

- The list of tells is heuristic. Good prose can contain one of them.
- The skill does not translate between languages.

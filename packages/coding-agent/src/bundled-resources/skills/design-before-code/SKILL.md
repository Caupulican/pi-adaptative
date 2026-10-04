---
name: design-before-code
description: "Design rules to apply before and while writing code: name the data shape first, model the domain in a structure instead of branches, validate at boundaries, delete before adding, keep the diff small, migrate callers and delete the old API in one wave, remove sharing before adding locks, make operations safe to retry, and design a novel interface twice. Use for a new feature, refactor, API change, module layout, state or lifecycle logic, 'where should this live', or a diff that feels too large."
---

# Design Before Code

## How to use the skill

Load this skill before a change that adds a type, a module, a lifecycle or a public function. Apply only the rules that the task triggers. Name each rule you applied and the choice it changed in your report. Do not cite a rule that changed nothing.

Freedom Dial: Medium Freedom. The rules set the question. The code decides the answer.

## North Star

Ship the smallest change that leaves the design simpler and no less capable. A reader must answer "where does this value come from" and "what can change it" in under 30 seconds.

## Core Sections

### Before you write

1. Name the data shape. Write the core types and trace every read and write path before you write logic.
2. If a feature adds a branch to an existing chain, or a second flag that must match the first, model the domain. Use a state machine, a discriminated union, a table or a registry.
3. Validate and parse where data crosses a boundary: CLI input, files, network, tool output. Trust the types inside.
4. Put business rules in pure functions. Keep the wiring thin.
5. When the work crosses a function boundary, write the call sites first. Derive the signature from the usage.

### Size of the change

1. Delete before you add. Remove dead code, one-caller wrappers and redundant validators first.
2. Make the smallest change that solves the problem. A new signal that needs threading through many layers means a more direct path exists. Look for it.
3. Keep the call chain flat. If a question needs more than three files to answer, flatten it.
4. Put each decision in one place. Pass the result as a plain value.
5. Count the layers a reader must trace and the state a reader must hold. Collapse a layer that has one caller. Shrink state to the narrowest scope.

### Changing an API

1. List every caller. Migrate them all. Delete the old API in the same change.
2. Keep a compatibility layer only when the owner asks for one.
3. Update the type checks, lint rules and scripts to the new contract. Test files change only when the owner asked for test work; otherwise report a test that pins the old design and leave it untouched.

### Shared state and retries

1. Ask whether the actors need the same mutable object. If they do not, give each its own file, key or directory and merge at the read side.
2. Serialize only when one shared writer is a real invariant. Use a structural lock, not a convention.
3. For each operation that changes state, answer two questions. What happens if it runs twice? What happens if the last run stopped halfway? The end state must be the same.

### A new requirement in an old design

1. Read every affected file.
2. Ask what you would build if the requirement existed from the start. Build that, then deliver it in steps.
3. Update every reference: types, docs, examples.

### A decision with no precedent

1. Sketch two structurally different designs. A second variant of the first shape does not count.
2. Compare them by interface depth. Prefer the smaller public surface that hides more.
3. If the work keeps producing special cases that the design cannot absorb, scrap the design. Do not patch it.
4. Prefer a script that does or proves the work over a manual pass. Keep the script small.

### Comments

1. Keep a comment only for a non-obvious reason that the code cannot show.
2. Delete narration, banners and commented-out code.
3. If a comment says "do not remove" or "temporary", encode the constraint in a type or a check, or remove the comment.

## Anti-Patterns

- A wrapper with one caller and no second implementation.
- A new boolean that must stay in sync with an old one.
- A compatibility shim that nobody asked for.
- A lock added before asking whether the sharing is needed.
- A design that only works after the sixth special case.

## Examples

- Task: add a "paused" state to a job. Two booleans, `running` and `done`, already exist. Build one `status` union. Delete both booleans.
- Task: rename a public function. Migrate all callers and delete the old name in the same change.

## Self-Check

- Did I name the data shape before the logic?
- Did the diff delete something?
- Does any new layer reduce reader load somewhere else by at least as much as it adds?
- Is each decision in exactly one place?

## Known Gaps

- The rules do not rank design styles. The repository's own rules win when they conflict.
- Comment hygiene is advice. The harness enforces only added suppressions.

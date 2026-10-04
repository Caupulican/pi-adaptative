---
name: verification-skill
description: "Create or maintain a project-local verification skill that launches the real application, drives it as a user would, captures evidence and cleans up, with a feature map of what to prove. Use when a project has no scripted way to prove behavior, when asked to 'make a verify skill', 'script the check for this app', 'audit the verify skill', or when a feature map no longer matches the application."
---

# Verification Skill

## How to use the skill

Load this skill to give a project a repeatable way to prove behavior on the real application. Use the skill `skill-creator` for the package layout and the validator. The result is a project skill named `verify-<app>` that the next agent can read cold.

Freedom Dial: Low Freedom for the sections. High Freedom for the harness choice.

## North Star

An agent that has never seen the application can launch it, prove one feature, collect evidence and clean up, using only the verification skill.

## Core Sections

### Create

1. Learn the project from the repository. Ask the owner only for what you cannot observe.
   - Surface: web page, terminal program, desktop application, service, library.
   - Run: the documented start command, ports, environment, seed data.
   - Drive: existing harnesses the owner allows you to run first (a test suite only if the owner asked for tests). Then a browser for web, a pseudo-terminal or tmux for terminal programs, plain requests for services.
   - Observe: screenshots, transcripts, response bodies, logs, exit codes, stored data.
   - Isolate: can two instances run side by side? If not, say so in the skill.
2. If the project does not start, fix that first or report it exactly.
3. Write `verify-<app>/SKILL.md` with these sections, filled with real commands:
   - Launch: the command, the signal that it is ready, the teardown.
   - Doctor: one read-only check that says whether the instance is worth driving.
   - Drive: the recipe with real selectors, commands or routes. Prefer stable handles over coordinates.
   - Evidence: what to capture and where it goes. Exercise the real user path. Capture the action and the result. Check side effects such as files written. Verify what a dry-run mode really skips.
   - Cleanup: stop only what the run started. Never stop processes by name. Keep the evidence.
   - Helpers: every script is executable and its call is shown in the skill.
4. Seed a feature map: an index and one file per user-visible feature. Each file has sub-features, how a user reaches it, how to drive it, and the observable end state that proves it.
5. Run the skill once end to end on one mapped feature. Check that the evidence survives cleanup. A skill that never ran is a draft.

### Maintain

Pick one outcome and say which: clean, changed or blocked.

1. Fix the index: missing, extra, duplicate or dead entries.
2. Source pass: for each feature file, a read-only worker explains the feature from source and flags drift with file and line. Workers do not drive the application and do not edit.
3. Live pass: you drive every feature once. Run the doctor before the first drive and after any failed drive. Keep evidence through every cleanup. Remove the residue of failed attempts.
4. Triage each difference. Wrong description: fix the map. Working behavior that the harness cannot drive: fix the harness. Broken application behavior: report it to the owner and do not hide it in the documents.
5. A feature that you cannot reach is "unreachable" only with the missing prerequisite and the route you tried.
6. Edit only the verification skill. Do not edit product code in a maintenance run.

## Anti-Patterns

- A skill with placeholders left in it.
- A cleanup that deletes the evidence.
- A drive that uses an internal setter instead of the user path.
- A feature map that lists only the convenient entry point.

## Examples

- A command-line tool: launch builds the binary once. Each drive runs in its own terminal session. Evidence is the transcript and the exit code.
- A web service: launch starts it on a free port. The doctor checks the version and the port owner. Drive uses real requests. Evidence is the response body and the stored row.

## Self-Check

- Did I run the generated skill once?
- Does the evidence exist after cleanup?
- Does the feature map list every user-visible feature that I found?

## Known Gaps

- The skill does not choose the harness for an unusual platform.
- A generated skill needs the same upkeep as the code it checks.

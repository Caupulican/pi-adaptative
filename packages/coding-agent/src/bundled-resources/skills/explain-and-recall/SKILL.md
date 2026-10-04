---
name: explain-and-recall
description: "Methods for understanding and explaining code and history: trace how a subsystem works, find why code has its shape from blame, history and issue trails with graded confidence, teach a topic in small steps, and rebuild recent working context from session transcripts, memory and git into a short status brief. Use for 'how does X work', 'why was this built this way', 'where should this live', 'teach me', 'catch me up', 'where did I leave off', 'what was I working on', or a read-only investigation."
---

# Explain And Recall

## How to use the skill

Load this skill for a read-only question. Pick the method that fits: how, why, teach or recall. The output is an answer with evidence. Do not change code in these tasks.

Freedom Dial: Medium Freedom. Write the answer in the standing explanation style (skill `ste100-writing`).

## North Star

Give the shortest answer that lets the reader act or decide, with each claim tied to a file, a line, a commit or a record.

## Core Sections

### How: trace a subsystem

1. State your reading of the question in one sentence. If the scope is vague, pick the narrowest reasonable scope and say so.
2. Find the entry points and follow one real path from input to output. Note where state is stored and who owns it.
3. For a wide subsystem, split it into 2 to 4 slices and read each slice. A read-only worker can take a slice. Merge the results yourself.
4. Write the answer with these parts, and drop any part that does not apply: overview, key concepts, how it works, where things live, gotchas.
5. Give each statement a file and line. Do not describe code that you did not read.

### Why: find the reason for a shape

1. Anchor on code: the file, the lines and the symbols.
2. Collect the trail: blame for the last commits on the lines, the history of the file through renames, pull request or issue numbers in the commit messages.
3. Read the discussion for the commits that matter. Add other records only when they are available: tickets, documents, chat, error trackers.
4. Grade each conclusion. Say "documented" when a record states the reason. Say "likely" when records point to it. Say "unknown" when no record exists. A search that finds nothing is a result. Report it.
5. Do not invent a reason, a caller or an API.

### Teach: build understanding

1. Decide what the reader must be able to do after the answer, from the question and the conversation.
2. Start with a plain definition. Then tie it to the case in front of you.
3. Give the smallest complete answer first. Add depth when the reader asks.
4. For a flow with three or more parts, draw a series of diagrams. Each one adds one part. Use the skill `explain-diagram` for the drawing.

### Recall: rebuild working context

1. Lock the scope before you search: the time window (default 7 days), the topic, the workspace. Do not read other projects.
2. Read recent session transcripts of this workspace, newest first, only for the topic. Read the memory records for the topic. Check branches and commits with git.
3. For a named feature or area, also read the history of the code and any open issues, because the story is not only in your own sessions.
4. Verify each branch, commit or ticket you mention against its live state.
5. Write the brief in this order: capsule (at most 5 lines), threads (one line each with a status tag such as merged, open, in progress, planned), problems (at most 5, with failed attempts), next move (one concrete action).

## Anti-Patterns

- An explanation of what the code says line by line.
- A reason for a design that no record shows.
- A brief that lists work from the wrong project.
- A status for a branch that you did not check.

## Examples

- Question: "How do goals reach completion?" Trace the path from the goal tool to the completion check. Give file and line for each step. List the gotchas last.
- Request: "Catch me up on the importer." Scope: last 7 days, importer topic. Output: capsule, threads with tags, problems, next move.

## Self-Check

- Does each claim carry a file, a line, a commit or a record?
- Did I label each reason as documented, likely or unknown?
- Is the answer shorter than the evidence I read?

## Known Gaps

- The method does not read private records you cannot access. Say which source was missing.
- Session transcripts may be incomplete after compaction.

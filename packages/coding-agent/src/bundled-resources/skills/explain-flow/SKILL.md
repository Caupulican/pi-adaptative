---
name: explain-flow
description: "Explain a process, a design or a plan as a living diagram: stations joined by wires, on which work items travel, are worked on and change state on a loop, with what is built or planned drawn below at lower fidelity. Outputs a self-contained page that plays the loop and an MP4 or GIF through ffmpeg, in the owner's own theme. Reads Mermaid, Graphviz DOT and plan files and turns them into one. Use when the owner must understand or approve a design, a pipeline or a plan before it runs, asks for an animated diagram, a flow film, a living diagram or 'show me how it runs', or asks to make a Mermaid or DOT diagram look better."
effects: [external-write, external-binary]
---

# Explain With a Flow Film

## How to use the skill

A flow film shows how work moves: who starts it, where it waits, what is done to it, what it becomes, and what happens when it fails. Use it when a picture of motion answers the owner's question faster than prose or a still diagram. Use it before every request for the owner's approval of a plan or a design: the owner sees what will run, then decides.

The tool is [scripts/flow-film.mjs](scripts/flow-film.mjs). You write a spec (JSON); the tool checks it, draws it and renders it. The spec reference is [references/spec.md](references/spec.md). Label text follows the `ste100-writing` style at the owner's strictness (default 9): short noun phrases and verbs, one meaning per label.

Freedom Dial: High Freedom for which stations, what layout and what story. Low Freedom for fidelity (every station, wire and outcome comes from the real source), for the checks (the layout check and the contact sheet are not optional) and for identity (the owner's theme, never another product's look).

## North Star

The owner watches one loop and can say what the system does, where it can fail and what is not built yet, and every station, wire and outcome on screen is true to the real source.

## Core Sections

### The mechanism

A process is drawn as a circuit. Stations are joined by wires. Work items travel the wires, wait or are worked on inside stations, and end on a record or go back to where they came from. Everything repeats on one loop, so any frame can be drawn alone and the last frame meets the first. Parts that are built but not proven, or only planned, sit in their own bands below, drawn dashed and then dotted. At rest the picture is line and text; a state colour appears only where something happens.

Stations are a closed set, each shaped by what it does. Choose by function, not by look:

| Station | What it shows |
| --- | --- |
| `source` | The authors of work: one emitter per author. An item starts here and may come back here. |
| `queue` | Items wait or run side by side in slots, each with its progress. |
| `worker` | One item at a time, in named phases, with a mechanism: `scan` (read, measure), `stamp` (sign, approve), `turn` (build, transform), `braid` (merge, join), `focus` (review, judge). |
| `rail` | The record of what landed, newest first. A failure keeps its colour and can carry a mark. |
| `sweep` | A check that runs on a schedule. |
| `chain` | Named steps in order; as a list row it carries a tag and a name at the left. Modes: `step`, `fill`, `together`. |
| `tally` | A count shown as boxes, some crossed. |
| `note` | Words only. |

### Procedure

1. Read the real source first (code, config, the plan, the logs). List the stations, the wires and every outcome. Drop what the owner did not ask about.
2. State the arrival question in one sentence ("what happens to a change after it is pushed"). The film answers that question and nothing else.
3. Write the storyboard as journeys: who starts an item, where it goes, how long each stay lasts, and how it ends. Include one journey that fails if the real system can fail.
4. Write the spec. Place stations on the grid, declare a wire for every hop of every journey, give every worker the mechanism that matches its work.
5. Run `node scripts/flow-film.mjs check <spec.json>`. Fix every problem it names. It prints the storyboard as timed beats: read it against step 3.
6. Run `sheet` and view the contact sheet with the read tool. Look for words that touch, a wire that crosses words, more than one thing lit in a region with no reason, and a station whose mechanism does not match its work. Fix the spec and run it again.
7. Render: `html` for the page that plays the loop (Pause and speed controls, `?t=<seconds>` for one instant), `video` for an MP4 and with `--gif` a GIF.
8. Verify the result: `ffprobe` shows one video stream with the loop's duration; view the first frame and one frame mid-loop. Say which checks ran.
9. Reply with the file paths and a reading guide of one to three sentences.

### Start from a diagram or a plan

`node scripts/flow-film.mjs import <file> --out <spec.json>` reads Mermaid (`flowchart`, `graph`, `sequenceDiagram`, `stateDiagram`, alone or in a Markdown fence), Graphviz DOT, and a plan file (the object given to the `plan` tool: a title and steps with `id`, `do`, `uses`, `join`). Nodes become stations, edges become wires, and the paths become journeys shown in turn. The command prints what the source notation could not carry. The result is a starting point: check the station kinds, shorten the words, set real timings, then go on from step 5.

### Before the owner approves

When you ask the owner to approve a plan or a design, show its flow first. For a plan, write the same steps you will give the `plan` tool to a file, `import` it, and render the page. Say in the reply what the film does not show (cost, files touched, risks) and then ask the question in words. The film never replaces the question, and it never claims a part runs that is only planned: put that part in a `next` or `later` band.

### Theme

The film uses the owner's identity. Pass `--theme-file <the owner's active harness theme file>` so it follows the theme the owner runs, or give the spec a `theme` with the product's own eight colour roles and font. The built-in themes (`matrix`, `paper`) are the harness's own. When the owner shows a reference they like, take its mechanism (how it explains) and restyle it from the owner's system: with the product removed, the result must not read as the reference.

### Scratch location

Artifacts are discardable local files. Write them to `${PI_EXPLAINERS_DIR:-${TMPDIR:-/tmp}/pi-explainers}/<slug>/`, or to the location the owner names. Never place them in tracked docs, and never commit them unless the owner asks. A render longer than 15 seconds runs as a managed background run.

## Anti-Patterns

- Do not invent a station, a wire or an outcome to make the picture look complete. Mark an unknown "unknown".
- Do not show a planned part as running. Fidelity tiers exist to keep that line.
- Do not copy another product's palette, glyphs, words or layout. Reuse the mechanism only.
- Do not skip the contact sheet. A spec that passes the layout check can still read badly.
- Do not use colour alone to carry meaning: an outcome also has words or a mark.
- Do not put more than one idea in one film. Split a large system into a map and one film per part.

## Examples

- "Show me how a plan runs before I approve it": write the plan's steps to `plan.json`, run `import`, set each step's real station kind and mechanism, add the journey of a rejected check, run `check` and `sheet`, render the page with the owner's theme file, and ask for the go-ahead with the page path and what the film does not show.
- "Turn this Mermaid flowchart into something better": run `import` on the file, read the notes it prints, replace generic workers with the right mechanisms, shorten the labels, render, and report what the Mermaid source could not carry.
- "Explain our release pipeline as an animation for the site": read the pipeline config, list stages and gates, storyboard one release that passes and one that fails a gate, put the stages that are not built yet in a `later` band, render an MP4 and a GIF, and report the `ffprobe` result.

## Self-Check

- Does every station, wire, phase and outcome come from the source I read, with unknowns marked "unknown"?
- Did `check` pass, and did I read its storyboard against my own?
- Did I view the contact sheet and fix what touched, crossed or misled?
- Is every part that is not proven or not built in a `next` or `later` band?
- Does the film use the owner's theme and no other product's look?
- Did I say which renderer ran, show the paths, and state what the film does not show?

## Known Gaps

- A PNG, a contact sheet and a video need `ffmpeg` built with librsvg (and libx264 for MP4). Without it the tool still writes the page and SVG frames, and says what is missing. The skill does not install tools.
- The video uses the fonts installed on the machine; the page uses the viewer's. Name a font the owner has when both must match.
- The importer lays a diagram out left to right in one band. A wide graph makes a wide canvas; a graph too wide for one picture must be split by hand.
- Mermaid diagram types other than flowchart, sequence and state are not read. Styling, notes and click handlers are reported, not carried.
- The host offers this skill to the main session only; a worker reports what it found and the main session makes the film.

---
name: explain-diagram
description: "Explain something as a diagram instead of prose: flowchart, sequence, state machine, architecture map, dependency graph, timeline, ER or concept map, as Mermaid, SVG or terminal ASCII. Use when the owner asks for a diagram, chart, picture, visual, map, 'draw it' or 'show me how it fits together', or when a structure or flow is clearer drawn than written."
effects: [external-write, external-binary]
---

# Explain With a Diagram

## How to use the skill

Draw the structure. Write only the text the picture cannot carry: a title, labels, a one-line reading guide. Label text follows the `ste100-writing` style at the owner's strictness (default 9): short noun phrases and verbs, one meaning per label.

Freedom Dial: High Freedom for layout and notation. Low Freedom for fidelity: every node, edge and label must come from the real source (code, config, data), never from memory.

## North Star

The owner reads the structure from the picture faster than from prose, and every node, edge and label in it is true to the real source.

## Core Sections

### Choose the form

| Content | Form |
| --- | --- |
| Steps, decisions, data flow | Mermaid `flowchart` |
| Messages between actors over time | Mermaid `sequenceDiagram` |
| Lifecycle, modes, transitions | Mermaid `stateDiagram-v2` |
| Entities and relations | Mermaid `erDiagram` or `classDiagram` |
| Schedule, phases | Mermaid `timeline` or `gantt` |
| Custom layout, annotated figure, anything Mermaid cannot place | Hand-written SVG |
| Owner is in a plain terminal and wants it inline, or the diagram has 10 nodes or fewer | ASCII in a fenced block |

### Procedure

1. Read the real source first. Collect the nodes and edges as a list. Drop anything the owner did not ask about.
2. Keep one idea per diagram: 12 nodes or fewer, a left-to-right or top-to-bottom main path, no crossing edges where avoidable. Split a large system into a map and one diagram per part.
3. Name every node with the exact term used in the source. Label every edge with a verb or the data it carries.
4. Write the file to the scratch location (below). Mermaid: `<slug>.mmd`. SVG: `<slug>.svg` with `viewBox`, `<title>`, `role="img"`, and inline styles only. No external references.
5. Verify with the renderers that exist on the machine, in this order, and say which one ran:
   - Mermaid: `mmdc -i <slug>.mmd -o <slug>.svg` (Mermaid CLI) when installed.
   - SVG: `xmllint --noout <slug>.svg`, then `rsvg-convert -o <slug>.png <slug>.svg` or `inkscape` when installed, then view the PNG with the read tool and check overlap, clipping and legibility.
   - If no renderer exists, say the diagram is unrendered. Do not install tools without owner approval.
6. Reply with the file path, the reading guide in 1-3 sentences, and the Mermaid source in a fenced block when the surface can render it.

### Scratch location

Artifacts are discardable local files. Write them to `${PI_EXPLAINERS_DIR:-${TMPDIR:-/tmp}/pi-explainers}/<slug>/`, or to the location the owner names. Never place them in tracked docs, and never commit them unless the owner asks.

## Anti-Patterns

- Do not invent components, arrows or labels to make the picture look complete. Mark unknowns "unknown".
- Do not use color alone to carry meaning; add a label or a line style.
- Do not paste a screenshot of text that should stay text.

## Examples

- "Show me how a request flows through the server": read the router and handler source, list the nodes and edges, draw a Mermaid `flowchart` with one node per handler named as in the code, and label each edge with the data it carries.
- "Draw the lifecycle of a job": read the state type and its transitions, then draw a Mermaid `stateDiagram-v2` with one state per enum member and one edge per transition in the code.
- A system with 30 components: draw one map of the parts, then one diagram per part with 12 nodes or fewer.

## Self-Check

- Does every node, edge and label come from the source I read, with unknowns marked "unknown"?
- Does each diagram hold one idea, 12 nodes or fewer, with every edge labeled?
- Is the file in the scratch location, with no external reference?
- Did I say which renderer ran, or say the diagram is unrendered?
- Does color never carry meaning alone?

## Known Gaps

- Verification depends on the renderers already on the machine. With no Mermaid CLI or SVG renderer, the diagram ships unrendered, and the skill does not install tools without owner approval.
- The skill does not draw facts it cannot read from a source; a structure that exists only in someone's head needs the owner to supply it.
- A single diagram does not carry a large system; it needs a map plus one diagram per part.

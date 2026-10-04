---
name: explain-html
description: "Explain something as a single-file interactive HTML page: an explorable explainer, live diagram, stepper, animated walkthrough, comparison table or small throwaway web app. Use when the owner asks for it 'in HTML', a web page, an interactive or animated explanation, a dashboard of findings, or a custom discardable artifact that would never be worth building by hand."
effects: [external-write, external-binary]
---

# Explain With an HTML Page

## How to use the skill

Build one self-contained `.html` file that teaches the topic. Interaction must carry meaning: a slider that changes the thing being explained, a stepper through a process, a toggle between two designs, a hover that reveals the source line. Decoration without meaning is a defect.

Page text follows the `ste100-writing` style at the owner's strictness (default 9). Freedom Dial: High Freedom for layout and motion. Low Freedom for facts: every number, name and claim comes from the real source or is labeled as an assumption.

## Contract

1. One file. Inline CSS and JS. No CDN, no web font, no network request at load, no tracker, no `eval`. The page works offline from `file://`.
2. Semantic HTML: one `h1`, landmarks (`header`, `main`), real `button` and `input` controls with labels, visible focus, full keyboard use.
3. Responsive from 320 px wide. Respect `prefers-color-scheme` and `prefers-reduced-motion` (replace motion with an instant state change, never remove the content).
4. Text contrast at WCAG AA or better. Color never carries meaning alone.
5. Size: 200 KB or less. If the topic needs data, embed the minimum as a JSON literal.
6. If the project already has a design system or tokens, use them. If not, choose one restrained palette and one type scale and apply them everywhere. Do not imitate another product's styling.
7. Structure: the answer first (one sentence), then the interactive core, then the detail. State what the page cannot show.

## Procedure

1. Read the real source. List the 3-5 facts the reader must leave with.
2. Pick the one interaction that makes those facts visible. Sketch the state it changes.
3. Write the file to `${PI_EXPLAINERS_DIR:-${TMPDIR:-/tmp}/pi-explainers}/<slug>/index.html`, or where the owner names. Never in tracked docs. Never commit unless asked.
4. Verify, and say what ran:
   - Network: `grep -nE "https?://|src=\"//" index.html` must show no load-time external reference (links in plain text are fine).
   - Parse: load it with `node` and a DOM parser if present, or with a headless browser (`chromium`, `google-chrome`, `playwright`) when installed; capture a screenshot at 360 px and 1280 px wide and view both with the read tool; check the console for errors.
   - Interaction: drive each control once and confirm the state change.
   - If no browser exists, say the page is unrendered. Do not install tools without owner approval.
5. Reply with the file path, what to try first, and any unverified part.

---
name: explain-html
description: "Explain something as a single-file interactive HTML page: an explorable explainer, live diagram, stepper, animated walkthrough, comparison table or small throwaway web app. Use when the owner asks for it 'in HTML', a web page, an interactive or animated explanation, a dashboard of findings, or a custom discardable artifact that would never be worth building by hand."
effects: [external-write, external-binary]
---

# Explain With an HTML Page

## How to use the skill

Build one self-contained `.html` file that teaches the topic. Interaction must carry meaning: a slider that changes the thing being explained, a stepper through a process, a toggle between two designs, a hover that reveals the source line. Decoration without meaning is a defect.

Page text follows the `ste100-writing` style at the owner's strictness (default 9). Freedom Dial: High Freedom for layout and motion. Low Freedom for facts: every number, name and claim comes from the real source or is labeled as an assumption.

## North Star

The reader leaves the page with the 3-5 facts it was built to teach, because one interaction makes those facts visible, and the page works offline from one file.

## Core Sections

### Contract

1. One file. Inline CSS and JS. No CDN, no web font, no network request at load, no tracker, no `eval`. The page works offline from `file://`.
2. Semantic HTML: one `h1`, landmarks (`header`, `main`), real `button` and `input` controls with labels, visible focus, full keyboard use.
3. Responsive from 320 px wide. Respect `prefers-color-scheme` and `prefers-reduced-motion` (replace motion with an instant state change, never remove the content).
4. Text contrast at WCAG AA or better. Color never carries meaning alone.
5. Size: 200 KB or less. If the topic needs data, embed the minimum as a JSON literal.
6. If the project already has a design system or tokens, use them. If not, choose one restrained palette and one type scale and apply them everywhere. Do not imitate another product's styling.
7. Structure: the answer first (one sentence), then the interactive core, then the detail. State what the page cannot show.

### Procedure

1. Read the real source. List the 3-5 facts the reader must leave with.
2. Pick the one interaction that makes those facts visible. Sketch the state it changes.
3. Write the file to `${PI_EXPLAINERS_DIR:-${TMPDIR:-/tmp}/pi-explainers}/<slug>/index.html`, or where the owner names. Never in tracked docs. Never commit unless asked.
4. Verify, and say what ran:
   - Network: `grep -nE "https?://|src=\"//" index.html` must show no load-time external reference (links in plain text are fine).
   - Parse: load it with `node` and a DOM parser if present, or with a headless browser (`chromium`, `google-chrome`, `playwright`) when installed; capture a screenshot at 360 px and 1280 px wide and view both with the read tool; check the console for errors.
   - Interaction: drive each control once and confirm the state change.
   - If no browser exists, say the page is unrendered. Do not install tools without owner approval.
5. Reply with the file path, what to try first, and any unverified part.

## Anti-Patterns

- Decoration or motion that carries no meaning.
- A load-time request to a CDN, web font, tracker or any other network resource.
- A number, name or claim that does not come from the real source and is not labeled as an assumption.
- Removing content for `prefers-reduced-motion` instead of replacing motion with an instant state change.
- Color as the only carrier of meaning.
- Imitating another product's styling.

## Examples

- Compare two cache designs: a toggle switches the page between them, and the hit and miss counts shown come from the measured data embedded as a JSON literal.
- Explain a retry policy: a slider sets the attempt number, and the page shows the delay the source code computes for that attempt.
- Walk through a request pipeline: a stepper moves through each stage, and a hover on a stage reveals the source line that implements it.

## Self-Check

- Is it one file under 200 KB that works offline from `file://`, with no load-time external reference?
- Does the one interaction change the thing being explained?
- Does every fact come from the source or carry an assumption label?
- Is it usable by keyboard, readable at 320 px, at WCAG AA contrast, and correct under reduced motion?
- Did I say which checks ran (network grep, parse or browser, screenshots, interaction), or say the page is unrendered?

## Known Gaps

- Rendering and interaction checks depend on a DOM parser or headless browser already on the machine; without one the page ships unrendered, and the skill does not install tools without owner approval.
- The page states what it cannot show; topics that need live data or a network service at load are outside a single offline file.
- Data above the 200 KB bound does not fit; the page embeds only the minimum the facts need.

---
name: ste100-writing
description: "Controlled-language writing in the style of ASD-STE100 (Simplified Technical English) on a 1-10 strictness dial; the harness default is 9. Use when the owner asks for a plain, simple, clear or ASD-STE100 explanation, a rewrite for readability, or a stated strictness such as '80% STE'. Also the standing style for explanations, analyses, reviews and summaries."
---

# STE100 Writing

## How to use the skill

Write owner-facing explanations, analyses, reviews and summaries in ASD-STE100 style at strictness 9 of 10 unless the owner names another level or turns the style off. Strictness is the owner's dial: "80% of the way" means 8, "plain English" means 5, "no STE" means off. The output is STE-style. It is not certified: the official specification and its dictionary are not bundled, so never claim compliance.

Freedom Dial: Low Freedom for exact technical content (code, commands, identifiers, paths, numbers, error text, quotes stay verbatim). High Freedom for wording.

## North Star

The reader understands the text on the first read, at the strictness the owner set, with every fact, caveat, number and technical name kept exact.

## Core Sections

### Rules at strictness 10

1. One topic per sentence. Procedure sentences: 20 words or fewer. Descriptive sentences: 25 words or fewer.
2. Paragraphs: one topic, 6 sentences or fewer, topic sentence first.
3. Active voice. Use the passive only when the actor is unknown or does not matter.
4. Simple tenses only: present for facts, past for events, future with "will". No perfect or progressive forms.
5. One word, one meaning, one part of speech. Use the short common word: "use" not "utilize", "start" not "initiate", "make sure" not "ensure", "about" not "approximately".
6. Keep every article (a, an, the) and demonstrative (this, that). Never drop them to save space.
7. Noun clusters of 3 words or fewer. Break longer ones with "of" or a verb.
8. No idioms, slang, humor, figures of speech, contractions, or phrasal verbs with two meanings.
9. Name the condition with "if". Name the result of an action in its own sentence.
10. Procedures: one instruction per sentence, imperative mood, in execution order. Put WARNING and CAUTION before the step they protect. Put NOTE after.
11. Write numbers as digits with units. Use vertical lists for 3 or more parallel items.
12. Repeat the exact term for a thing. Do not swap synonyms for variety.

### The dial

| Level | Rule set |
| --- | --- |
| 10 | All rules. No exception except exact technical names. |
| 9 (default) | All rules. Technical names, code, commands, quotes and error text stay exact. One sentence may pass the length limit if a split would lose precision. |
| 8 | Rules 1-9 hold. Lists, tenses and word choice may follow the topic. |
| 7 | Length limits grow to 25 (procedure) and 30 (description). Contractions allowed in chat. |
| 6 | Active voice, one topic per sentence, no idioms. |
| 5 | Plain English: short sentences, common words, no jargon without a definition. |
| 3 | Active voice and short sentences only. |
| 1 | Off. |

### Procedure

1. Settle the level: owner statement, else 9.
2. Write the content first: facts, then order, then wording.
3. Check the draft against the rules for that level. For a file, run `node <BASE>/scripts/ste-lint.mjs <file> --level <n>`; `<BASE>` is the skill base directory. The linter is a heuristic. It reports long sentences, likely passive voice, progressive forms, contractions and long noun clusters. A clean run does not prove style compliance. Fix flagged lines or keep them when the exact technical wording needs it.
4. Keep terse status replies terse. This style applies to explanations, not to one-line acknowledgements.

## Anti-Patterns

- Do not simplify by removing facts, caveats or numbers.
- Do not change code, commands, identifiers, paths or quoted text.
- Do not claim certification or full compliance.

## Examples

- Strictness 9: "The cache is utilized in order to approximately halve the latency that is being experienced" becomes "The cache cuts the latency by about 50%."
- A procedure at strictness 10: "Stop the service. Then delete the lock file." becomes two steps: "1. Stop the service. 2. Delete the lock file." A WARNING about data loss goes before step 2.
- The owner says "80% STE": use level 8. The owner says "no STE": write without this style.
- An error message quoted in the text stays verbatim, even when it breaks a rule.

## Self-Check

- Did I use the level the owner named, or 9?
- Are every fact, caveat, number and technical name still present and exact?
- Do sentence lengths, voice, tenses and noun clusters fit the rules for that level?
- For a file, did I run `ste-lint.mjs` and either fix or justify each flagged line?
- Did I avoid any claim of certification or compliance?

## Known Gaps

- The official ASD-STE100 specification and its controlled dictionary are not bundled. The skill cannot check approved words or meanings, so the output is STE-style and never certified.
- `ste-lint.mjs` is a heuristic: it flags long sentences, likely passive voice, progressive and perfect forms, contractions and long noun clusters, and it skips headings, tables, quotes and fenced code. It does not check word meanings, articles, paragraph structure or procedure order, and a clean run does not prove compliance.
- The style applies to explanations; it does not govern terse status replies or one-line acknowledgements.

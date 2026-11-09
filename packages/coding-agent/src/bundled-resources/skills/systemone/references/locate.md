# Locate

Use `action: "locate"` to find where something lives or which file defines it when the exact token is not known:

```json
{"action":"locate","locate":{"target":"where the shell operation gate decides a command's edge class","queries":["operation gate","classifyOperation","edge class"],"paths":["packages/coding-agent/src"],"limit":5}}
```

You choose 1 to 8 literal or regex queries (smart case) and may scope with `paths`. The host searches, orders files by how many queries they match, and builds a short card for the best 24 (the file's leading comment, the names it declares, a few lines around its best hit). System One answers one closed question per card, "is this the code the target asks about?", and the host returns `path:line  p=…  matched line`, highest probability first, plus the count of the rest.

- Prefer several distinct queries (names, verbs, nouns from the target) over one broad pattern: files are chosen by lexical coverage first, and a file outside the best 24 is never judged ("N further matching files were not judged").
- Probabilities are coarse. A right file often scores below the 0.90 acceptance floor, so the list is topped up to three with the best candidates below it, labeled `(below floor)`. Rely on the order, not the number.
- A ranking is not proof: read the file before editing it. If System One is unavailable the result is the lexical ranking marked `unjudged`, never a claim that nothing exists.
- When the exact token or path is already known, use `grep` or `find` instead.

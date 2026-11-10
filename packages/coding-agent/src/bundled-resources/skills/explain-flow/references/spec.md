# Flow spec reference

A flow spec is one JSON object. Positions are in grid units (`unit` pixels). A station's `at` is `[column, row]` from the top left of its band, under the band's header. The tool refuses a spec it cannot draw truthfully and names every problem at once.

## Top level

| Field | Meaning |
| --- | --- |
| `title` | The film's name: the page title. |
| `size` | `[width, height]` in pixels, both even. Default `[1280, 800]`. |
| `unit` | Pixels per grid unit, 4 to 24. Default 10. Text is 1.75 units high. |
| `loop` | Seconds in one round, 2 to 120. Every journey runs once per round. |
| `rounds` | Whole rounds in one period, 1 to 12. Default 1. The film's period is `loop × rounds`, at most 120 seconds. |
| `fps` | Frames per second of a video, 10 to 60. Default 30. |
| `speed` | How fast an item travels a wire, in pixels per second. Default 440. A step's `travel` overrides it. |
| `theme` | A built-in name (`matrix`, `paper`) or an object with the roles `bg`, `line`, `text`, `dim`, `work`, `ok`, `fail`, `info` as `#rrggbb` and an optional `font` (a CSS font-family list). |
| `footer` | Words at the left over the loop bar: what one item stands for. |
| `clock` | Words at the right over the loop bar: what one round stands for. |
| `bands` | The horizontal bands, top to bottom. |
| `nodes` | The stations. |
| `wires` | The wires. |
| `runs` | The journeys. |

The last 6 rows of the canvas hold the loop bar; the bands must leave them free.

## Bands

`{ "id", "tier", "title", "note", "height" }`. `tier` is `live` (solid: what runs and is proven), `next` (dashed: built, not proven) or `later` (dotted: planned). `height` is in rows and includes the 5 rows of the band's header.

## Stations

Every station has `id` (lowercase letters, digits, hyphens), `kind`, `band`, `at`, and optional words: `label` (its name, bold), `note` (after the name), `value` (a quantity, in the `info` colour, under the name), `sub` (up to 4 lines under the body).

| Kind | Own fields | Size in units | Ports |
| --- | --- | --- | --- |
| `source` | `count` 1 to 8 (default 3), `pitch` rows between emitters (default 6) | 8 wide, 3 high per emitter | emitter `id:N` leaves at its right and takes a returning item at its left |
| `queue` | `slots` 1 to 6 (default 3) | 7 wide, 4 per slot plus 1 | `in`, `out`, `top`, `bottom` |
| `worker` | `mechanism`: `scan` (default), `stamp`, `turn`, `braid`, `focus` | 11 by 7 | `in`, `out`, `top`, `bottom` |
| `trial` | `count` candidates, 2 to 12 (default 8); `keep`: `highest` (default) or `lowest`; `stem`: 1 to 3 letters that name the candidates (default `c`: `c1`, `c2`, …); `scores`: one list per round with one number from 0 to 1 per candidate | 5.5 plus 3.25 per candidate less 0.75 wide, 9.5 high | `in`, `out`, `top`, `bottom` |
| `rail` | `dots` 3 to 16 (default 7), `okText`, `failText`: what it says after an `ok` or a `fail` landing | 6 per dot plus 2, 2 high | `in` |
| `sweep` | `period` seconds for one pass (rounded so whole passes fit the loop) | 14 by 4 | `in`, `out`, `top`, `bottom` |
| `chain` | `items` (up to 8), `pulse` seconds for one pass, `mode`: `step` (one lit at a time), `fill` (they stay lit until the pass ends), `together`; `tag` and `lead` (columns kept at the left for the tag, name and note) make it a list row | chips sized to their words, 3 high | `in`, `out`, `top`, `bottom` |
| `tally` | `boxes` 1 to 12, `crossed`, `text`; or `per`: `round` for one box per round, with `marks` (a word under each box, as `v{round}`) | 2.2 per box plus the words | none |
| `note` | `lines` (up to 6): each a text, or `{ "text", "when" }` to light the line while a station is busy; `size`: `text` (default), `lede` or `title` | the words | none |
| `table` | `columns`: up to 4 header words (none: no header); `rows`: 1 to 8, each `{ "cells", "when" }`; `numbered`: `true` adds a column of row numbers | the cells, one line per row | none |
| `series` | one of `of` (a trial's id) or `values` (one number per round); `w` and `h`, the plot in units (30 by 12; 16 by 8 to 80 by 30); `axis`: what is measured; `base` with `baseWords`: a level to compare with; `floor`, `ceiling`: the scale | the plot plus 5 rows | none |

A worker keeps two rows under its body for what it says about the item it holds (its lane, then its phase); its `sub` lines start after them. A trial keeps one row (its phase, then the kept candidate and its score). A rail whose landings carry a `mark` keeps one row under its line for the marks; a wire cannot meet such a rail from below. `top` and `bottom` ports sit 2.5 units in from the left edge, and the station's words on that side start after the wire.

## Wires

`{ "from", "to", "id", "route", "via", "lane", "bend", "label" }`.

- `from` and `to` name a station: `"fleet"`, an emitter `"steps:2"`, or a port `"verify.bottom"`. A wire leaves by `out` and arrives by `in` unless a port is named.
- `route`: `curve` (default; straight when both ends are level), `elbow` (level, across, level; `bend` 0.05 to 0.95 sets where it turns), `loop` (out, along the row `lane`, and into the target: for a way back or a wire that passes other stations).
- `via`: a list of `[column, row]` corners the wire passes, in place of a route.
- `label`: words on the wire. `id`: needed only when two wires join the same two stations.

A wire takes the tier of the band its start is in.

## Journeys

`{ "id", "from", "start", "tone", "steps" }`. `from` is where the item appears, `start` the second of the loop it leaves. `tone` is its colour role (default `work`). A journey must end inside the loop.

Each step is one hop along a declared wire and what happens on arrival:

| Field | Meaning |
| --- | --- |
| `to` | The station (or emitter) the item travels to. A wire from where it is to there must exist. |
| `wire` | The wire's `id`, when more than one joins the two stations. |
| `travel` | Seconds on the wire; by default the wire's length over `speed`, at least 0.4. |
| `work` | Seconds inside a `queue`, a `worker` or a `trial` (default 1.2). A trial shows three phases in that time: it makes its candidates, scores them, and keeps one. Give it 3 seconds or more. |
| `lane`, `laneTone` | A line under a worker while it holds the item, and its colour role (default `text`). |
| `phases` | Up to 6 names the worker shows in turn while it works. A trial has three phases (`propose`, `score`, `keep`); three names here rename them. |
| `result` | `ok` or `fail`. At a worker, `fail` turns the item to the `fail` colour for the rest of its journey and shows `text`; `ok` gives it a passed mark. At a rail, it colours the dot that lands. |
| `text` | What a worker says when the step fails. |
| `mark` | At a rail: a short word under the dot that lands. |
| `carry` | Words that travel with the item on this hop. |
| `tone` | The item's colour role from this step on. |

A journey ends when it reaches a `rail` (the item becomes the newest dot), a `source` emitter (the emitter lights), or after its last stay (the item fades inside the station). A queue holds as many items as it has slots, and a worker or a trial one; the tool refuses a spec that asks for more.

## Linked views

A line of a `note` and a row of a `table` can follow a station: `"when": "<station id>"`. It lights while that station is busy: a `queue`, a `worker` or a `trial` while it holds an item, a `source` while its emitter pulses, a `rail` while the ring of a landing shows. A lit line gets a soft wash and brighter ink, so the same beat shows in the circuit and in words. A `sweep`, a `chain`, a `tally`, a `note` and a `table` cannot be named.

```json
{ "id": "steps", "kind": "table", "band": "views", "at": [0, 4], "label": "One round", "numbered": true,
  "rows": [
    { "cells": ["propose 8 edits"], "when": "editor" },
    { "cells": ["score each edit"], "when": "candidates" }
  ] }
```

A table with `numbered` and one column is a list of ordered steps. A table with `columns` is a small table of facts: its first column is the row's name. Keep cells short: a column is as wide as its widest cell.

A note's `size` gives a film a title and a closing sentence: `title` is bold, `lede` is a little larger than the text. Use one of each at most.

## Trials

A `trial` is the station where several candidates are made, each is scored, and one is kept. While it holds an item, its candidates light in turn, then a bar rises over each to its score, then the kept candidate turns to the `ok` colour and the others go quiet. The row under the station names the phase, then the kept candidate and its score. After the item leaves, that outcome stays in a quiet tone until the next item arrives.

Give `scores` when the numbers are known: one list per round, one number per candidate. Without `scores` the tool makes them from the station's `id`, the round and the candidate, so a frame is always drawn the same; they go from 0.15 to 0.95 and rise a little with each round. Say in the reply that such scores are an illustration, not a measurement.

After a stay at a trial, the words of the journey may hold `{kept}`: the name of the candidate that trial kept in that round. A step's `carry` and a rail `mark` take it.

```json
{ "to": "versions", "result": "ok", "mark": "v{round}", "carry": "{kept} kept" }
```

## Rounds

`rounds` runs the whole circuit more than once. The same journeys run again in each round, in the same order. `loop` stays the seconds of one round, so the film's period is `loop × rounds` and a period is at most 120 seconds.

A rail keeps the record of the period. It shows what landed in this round so far, then what landed in the rounds before it in this period, newest first. Nothing from before the period began stays. The first round starts with an empty rail and the record grows.

Words may hold a round token. `{round}` is the round's number, starting at 1. A whole offset after `+` or `-` shifts it.

```json
"clock": "round {round} of 3"
```

Two instruments show what the rounds add up to. A `series` is one measure with one point per round. With `of` it reads a trial: the kept score of each round is a point, the other candidates are quiet dots, and a step line shows the best kept score so far. With `values` it joins the numbers the spec gives. A round's point appears when that round reaches its number, so the plot grows through the period; only the newest point says its value. A series has one scale: two measures are two series. A `tally` with `"per": "round"` has one box per round: the rounds that are over are crossed and the round in hand is lit.

A rail dot's `mark` is a token too. It takes the round the item landed in, so the record reads `v3 v2 v1`. A station's words, the `footer`, the `clock`, a `mark` and a step's `carry` may hold a token: when `rounds` is over 1 the tool draws them for the round it is in. A band `title` and a wire `label` belong to the still picture and keep their words. Text with a token is measured by its widest form, so it fits in every round.

## Commands

```
node flow-film.mjs check  <spec.json>
node flow-film.mjs frame  <spec.json> --at <seconds> --out <file.svg|file.png>
node flow-film.mjs sheet  <spec.json> --out <file.png> [--count 8] [--columns 3] [--width 960]
node flow-film.mjs html   <spec.json> --out <file.html>
node flow-film.mjs video  <spec.json> --out <file.mp4> [--fps 30] [--loops 1] [--gif <file.gif>] [--gif-width 800]
node flow-film.mjs import <diagram>   --out <spec.json> [--title <words>]
```

`sheet` spreads its frames over the whole period and `video` renders the period, times `--loops`; `frame --at` takes any second of the period.

Every command but `import` also takes `--theme <built-in name>` or `--theme-file <harness theme file>`. A harness theme file gives `bg` from `export.pageBg`, `line` from `colors.borderMuted`, `text` from `colors.text`, `dim` from `colors.dim`, `work` from `colors.warning`, `ok` from `colors.success`, `fail` from `colors.error` and `info` from `colors.mdLink`.

## Layout rules the check enforces

- A station with its words fits inside its band and the canvas.
- Two stations keep a clear strip between everything they draw. Two lines of words side by side need 2 units between them.
- A wire never runs through words, nor through a station it does not end at.
- A queue never holds more items than it has slots, and a worker never more than one.
- Every hop of every journey has exactly one wire under it.

# Text tool-call protocol grammar (the "phone" language)

The single source of truth for R38 (SPEAK primer + LISTEN parser) and R45
(calibration). ONE grammar, two consumers: the primer generator emits it to
the model, the parser recognizes it coming back. `text-protocol.ts` holds this
as code; this file is the human-readable spec it must match. If the two ever
disagree, the code's fixtures win and this file is corrected.

Design constraints: unambiguous to parse with a bounded scanner (no regex
soup, no nesting ambiguity), cheap to emit, and forgiving of the whitespace a
weak model adds. The envelope is line-orientable but not line-dependent.

## 1. Envelope grammar (EBNF)

```ebnf
call        = open-tag , ws? , args-json , ws? , close-tag ;
open-tag    = "<pi:call" , ws , 'name="' , tool-name , '"' , ws? , ">" ;
close-tag   = "</pi:call>" ;
tool-name   = ident ;                         (* must match a known tool *)
args-json   = json-object ;                   (* strict JSON, RFC 8259 *)
ident       = (letter | "_") , { letter | digit | "_" } ;
ws          = { " " | "\t" | "\n" | "\r" } ;
```

- `args-json` is a COMPLETE JSON object (`{...}`), UTF-8, double-quoted keys.
  It is NOT the harness's job to be a lenient JSON parser here — malformed
  inner JSON is a LISTEN failure that flows into the R31 repair pipeline
  (which owns JSON tolerance), not a grammar concern.
- One `<pi:call>...</pi:call>` per tool invocation. Multiple calls in one
  turn = multiple envelopes; the parser extracts each independently in
  document order.
- Text outside envelopes is prose (reasoning, explanation) and is preserved
  as the assistant's text content — never discarded, never parsed as a call.
- The tag prefix `pi:` is deliberate: it is vanishingly unlikely to collide
  with prose or code the model quotes, which keeps extraction unambiguous.

Why `<pi:call name="X">{...}</pi:call>` and not bare JSON or `X({...})`:
- an explicit open/close pair lets the scanner find exact boundaries even
  when args-json contains `}` inside strings (scan to `</pi:call>`, then
  parse the interior as JSON) — no brace-counting heuristics;
- `name=` as an attribute (not the JSON) means a malformed args body still
  tells us WHICH tool was intended, so the R31 bounce/repair note can be
  tool-specific;
- it is visually distinct from the code models love to emit, so calibration
  (R45) can tell "spoke the protocol" from "wrote about the protocol".

## 2. Recognized inbound variants (LISTEN tolerance)

The parser accepts, in priority order, and normalizes all to the canonical
form above. Recognizing more than we emit is deliberate: open models arrive
pre-trained on other stacks' conventions.

1. Canonical `<pi:call name="X"> {json} </pi:call>`.
2. `<tool_call>{"name":"X","arguments":{...}}</tool_call>` (common OSS
   convention; `arguments` may itself be a JSON STRING — that is exactly
   R31 mode 2, handed straight to the repairer).
3. Fenced block tagged `tool`/`tool_call`/`json`:
   ```` ```tool\n{"name":"X","arguments":{...}}\n``` ````
4. XML function-call convention:
   `<function name="X"><param name="k">value</param></function>`.
   The scanner requires an explicit `</function>` close tag. Each `param`
   becomes a string-valued argument; R31 owns string-to-number, string-to-bool,
   and JSON-string coercion after parsing. Nested `<function>` bodies,
   duplicate param names, or non-whitespace text inside the function body are
   ambiguous and are refused rather than guessed.
Everything else is prose. Ambiguous text is NEVER guessed into a call
(doctrine: no heuristic soup). Unknown `tool-name` → a text-protocol bounce with
an "unknown tool" note listing valid names.

## 3. Schema -> primer projection (how the dictionary is generated)

The primer is GENERATED from the live `Tool[]`, never hand-written, so adding
a tool updates the dictionary for free. Projection rules per tool:

- one line: `tool-name(arg:type[?], ...) - <one-line purpose from schema
  description>`;
- `?` suffix marks Optional; enums render as `a|b|c`; arrays as `type[]`;
  nested objects as `{k:type,...}`;
- types collapse to the five the model needs: `string`, `number`, `bool`,
  `T[]`, `{...}`. No JSON-Schema keywords leak into the primer;
- required-args-first ordering; default values shown as `=default` when the
  schema declares one;
- two worked examples per primer TOTAL (not per tool): one simplest call,
  one call with an array arg (the shape open models most often break),
  chosen from the actual tool set.

The primer header (fixed text):

```
To use a tool, reply with EXACTLY this and nothing else around it:
<pi:call name="TOOL">{ "arg": value }</pi:call>
Rules: arguments is ONE JSON object. Arrays are JSON arrays [ ], never
quoted strings. Omit optional args you do not need - do not send null.
Put any reasoning BEFORE the tag, not inside it.
```

## 4. The dictionary for pi's core tools (generated 2026-07-06)

Verbatim projection of the real schemas (`bash.ts`, `read.ts`, `edit.ts`,
`write.ts`, `ls.ts`, `grep.ts`, `find.ts`). This is what a text-only model
sees; regenerate whenever a tool schema changes (a test asserts this table
matches the projection).

```
bash(command:string, timeout:number?) - run a bash command
read(path:string, offset:number?, limit:number?, lineNumbers:bool?, tail:number?, filter:none|minimal|aggressive?) - read a file
edit(path:string, edits:{oldText:string,newText:string}[]) - apply targeted text replacements to a file
write(path:string, content:string) - write (create/overwrite) a file
ls(path:string?, limit:number?, metadata:bool?) - list a directory
grep(pattern:string, path:string?, glob:string?, ignoreCase:bool?, literal:bool?, context:number?, limit:number?) - search file contents
find(pattern:string, path:string?, limit:number?, ignoreCase:bool?) - find files by glob
```

Worked examples (the two shipped in the primer):

```
Read a file:
<pi:call name="read">{ "path": "src/index.ts" }</pi:call>

Replace text (note edits is a JSON ARRAY of objects):
<pi:call name="edit">{ "path": "src/app.ts", "edits": [ { "oldText": "foo", "newText": "bar" } ] }</pi:call>
```

The `edit` example is deliberate: `edits` is the array field open models most
often send as a stringified array (`"[{...}]"`) or a bare object (`{...}`) —
showing the correct shape here, and repairing+teaching it via R31/R40 when
they still get it wrong, is the whole loop in one arg.

## 5. Parser output contract

`parseTextToolCalls(text, knownTools) -> { calls: ToolCallBlock[], text:
string }` where:
- `calls` are canonical toolCall blocks (name + parsed-or-raw args), each
  tagged `origin: "text-protocol"` so R35 telemetry attributes them and R31
  knows the args came through the phone;
- `text` is the input with every recognized envelope removed (the surviving
  prose);
- args that fail JSON parse are passed to R31 as a raw string under the named
  tool (repairer owns tolerance); the parser itself never invents args.

## 6. Calibration trials (R45) use this grammar

The trial tool is `echo(data:string)` (harness-provided, side-effect-free).
Calibration asks the model to `echo` a known token via the protocol and
checks the parser round-trips it. Grammar variants tried on failure are the
parser's supported variants in deterministic order: canonical `<pi:call>`,
`<tool_call>`, fenced JSON/tool blocks, then XML `<function>`. The variant that
first round-trips is persisted per model (R46).

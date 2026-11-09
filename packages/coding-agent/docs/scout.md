# FastContext scout

Pi can delegate broad repository exploration to a bounded read-only scout through the `context_scout` tool. The scout runs a fresh subagent with only `read`, `grep`, and `find`, then returns a short summary plus validated `file:line` citations. Treat scout output like other tool output: use it as evidence, then read the cited ranges yourself before editing.

## Citations and their exits

The final answer is a short summary followed by one citation per line. Two forms are accepted:

- `path/to/file.ts:START` or `path/to/file.ts:START-END`: a cited line or range.
- `path/to/file.ts:START-END | <first cited line, verbatim>`: the same range, followed by the first line of the cited range copied exactly after ` | `.

A citation path is one whitespace-free token, and its line numbers are integers. A line whose token names nothing and has neither a path separator nor a file extension, such as `label:3 | text`, is summary text, not a citation. Any other token that names a file is a citation, including an extensionless file such as `Makefile:12`. A path-shaped token (with a separator or an extension) that names nothing is a citation dropped as `missing_file`.

Each citation is checked against the file. The cited path resolves to its real path, following symlinks, and the scout's envelope is applied to that real path before anything is read. A session without an envelope (yolo) applies no envelope. With a snippet, the snippet must sit on the cited first line; if it sits on exactly one other line where the cited span fits, the citation moves to that line and keeps its span length.

A citation that fails is dropped and counted in `Dropped invalid citations`. Its exit reason:

| Exit | Meaning |
| --- | --- |
| `missing_file` | Nothing exists at the cited path. |
| `unreadable` | The scout cannot read the cited path as text: a directory or other non-regular file, a file over 1 MiB, or a read error. A path outside the envelope is also `unreadable`, whether or not anything exists there, so its existence is not revealed. Reported in `Unreadable cited files`. |
| `out_of_range` | The range is not valid (start below 1, or end before start), or it runs past the end of the file. |
| `snippet_not_found` | The snippet appears on no line of the file. |
| `ambiguous` | The snippet fits more than one line, and the cited line does not match it. |

When more than half of the citations are dropped, the result is marked unreliable.

## Install the reference local model

One-step path: run `/models suggest`, choose `FastContext-1.0-4B`, let pi pull and probe it, then confirm the scout role. The assignment writes `scout.model` and sets `scout.enabled = true` only after the `scout_auto` exam passes.

Manual fallback: pull the verified Q4 GGUF tag:

```bash
ollama pull hf.co/KikoCis/FastContext-1.0-4B-longctx-imatrix-GGUF:fastcontext4b.Q4_K_M.imx.gguf
```

The Hugging Face repository also exposes `fastcontext4b.IQ3_M.imx.gguf`; use the Q4 tag above unless you need the smaller IQ3 quant.

After pulling manually:

1. Start pi in the target repo.
2. Run `/models` and confirm the Ollama model appears.
3. Run `/fitness` against the model before assigning it to `scout.model` or a router tier.
4. Only assign it if the tool-calls and research-lane probe surfaces pass. Pi's model-adoption gates refuse all-lanes-failed probes automatically.

Enable the tool with settings after the probe passes:

```json
{
  "scout": {
    "enabled": true,
    "model": "ollama/hf.co/KikoCis/FastContext-1.0-4B-longctx-imatrix-GGUF:fastcontext4b.Q4_K_M.imx.gguf"
  }
}
```

`"model": "auto"` looks for an installed model whose provider/name/id contains `fastcontext`, then requires a host-local `/fitness` report that passes both `research` and `toolCall`. If no model resolves, the model is unprobed, or the required lanes failed, `context_scout` returns `scout unavailable: <cause>` instead of failing the main turn. An explicit `scout.model` pattern is a user choice and resolves without this auto-selection proof gate; scout output is still validated at runtime through citation checks.

## 10 GB reference profile

A practical 10 GB RAM layout:

- FastContext Q4 weights: about 2.5 GB.
- 32K-64K KV cache: about 1-2 GB.
- Pi process: about 0.5 GB.
- Main model: cloud-hosted, or a local Qwen3-4B-Instruct-2507 Q4 model (about 2.5 GB more).

Expected peak for scout + pi is roughly 5-6 GB; adding a local 4B main model still fits on a 10 GB machine. Pi warns when a chosen local model's installed size exceeds about 90% of RAM.

## Qwen3 chat-template caveat

Ollama derives the chat template from the GGUF. Verify tool calling with `/fitness` before trusting the scout. If the probe shows tool-call failures, create a Modelfile with an explicit Qwen3 template and probe that model instead:

```modelfile
FROM hf.co/KikoCis/FastContext-1.0-4B-longctx-imatrix-GGUF:fastcontext4b.Q4_K_M.imx.gguf
TEMPLATE """{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}<|im_start|>assistant
"""
PARAMETER temperature 0
```

Then:

```bash
ollama create fastcontext-qwen3-tools -f Modelfile
```

Probe `ollama/fastcontext-qwen3-tools` with `/fitness` before assigning it.

## Router cheap-tier recipe

FastContext is a scout, not a solver. With `modelRouter.fitnessGate` enabled, a FastContext-shaped report that passes `research` + `toolCall` but fails `worker` remains eligible for the cheap tier and is structurally excluded from medium/expensive solver tiers. Mutating turns must still escalate out of the cheap tier before write/edit/bash changes; keep the medium or expensive tier on a solver model.

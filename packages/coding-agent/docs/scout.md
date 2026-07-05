# FastContext scout

Pi can delegate broad repository exploration to a bounded read-only scout through the `context_scout` tool. The scout runs a fresh subagent with only `read`, `grep`, and `find`, then returns a short summary plus validated `file:line` citations. Treat scout output like other tool output: use it as evidence, then read the cited ranges yourself before editing.

## Install the reference local model

Pull the verified Q4 GGUF tag:

```bash
ollama pull hf.co/KikoCis/FastContext-1.0-4B-longctx-imatrix-GGUF:fastcontext4b.Q4_K_M.imx.gguf
```

The Hugging Face repository also exposes `fastcontext4b.IQ3_M.imx.gguf`; use the Q4 tag above unless you need the smaller IQ3 quant.

After pulling:

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

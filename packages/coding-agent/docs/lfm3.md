# LFM3 local models

Use the integrated `pi lfm3` subcommand to install and evaluate Liquid AI's LFM3 Ollama models. It
manages the Ollama runtime and model setup independently from the interactive session. The package
also exposes `pi-lfm3` as a convenience alias in npm-installed environments; standalone Pi releases
use `pi lfm3`.

## Setup

Install all four supported model variants:

```bash
pi lfm3 setup
```

Limit setup to one model when disk, memory, or evaluation time is constrained:

```bash
pi lfm3 setup --model text
pi lfm3 setup --model vision
pi lfm3 setup --model audio
pi lfm3 setup --model omni
```

The default exact Ollama tags are:

| Variant | Ollama tag | Upstream model capability | Pi media command |
| --- | --- | --- | --- |
| Text | `lfm3:1.7b-q4_K_M` | Text → text | Use as a local text model after setup |
| Vision | `lfm3-vl:2b-q4_K_M` | Text, image, and video → text | `describe` accepts an image |
| Audio | `lfm3-audio:2b-q4_K_M` | Text or audio → text, speech, or both | `transcribe`, `speak`, and audio `ask` |
| Omni | `lfm3-omni:2b-q4_K_M` | Text, image, video, or audio → text or speech | `ask` accepts image and audio |

These are explicit quantized tags, not moving `latest` aliases. Ollama's current library pages
display 256K context for the text tag and 125K for the other three. Those rounded labels are not
exact token limits. The Audio model card specifies 32K context, which differs from Ollama's display;
the installed Ollama/runtime metadata and successful host-local sizing determine the usable budget.
Pi does not assume the entire advertised context fits available memory.

The video capability shown above is part of the upstream Vision and Omni model descriptions. Pi's
media commands and setup fitness path do not currently accept video input.

## Local media commands

Run setup first, then use the installed model through Pi's bounded loopback Ollama endpoint:

```bash
pi lfm3 describe --model vision --image picture.png [--prompt "Describe the image."]
pi lfm3 transcribe --model audio --input recording.wav
pi lfm3 speak --model audio --text "Hello from a local model." --output reply.wav
pi lfm3 ask --model omni --image picture.png --audio recording.wav --prompt "Describe the image and audio."
```

`describe` defaults to the vision model and a generic image prompt. `ask` defaults to Omni; its
`--image` and `--audio` inputs can be used separately or together. `transcribe` prints text to
stdout. `speak` writes WAV audio to the requested path and refuses to overwrite an existing file.
Media files are read locally and sent only to the loopback Ollama endpoint. Setup sends the
model-generated text evidence to configured remote System One for judgment. Each call has a 120
second timeout; media input is bounded to 32 MiB total and 16 items. The current CLI accepts at most
one image and one audio file per call.

The command requires the Pi-managed Ollama runtime and the requested model to be installed. If any
Ollama server is already running, the command refuses to use or stop it because it cannot establish
ownership. Stop the Pi-managed server from its owning Pi session with `/models stop`, then retry.
The media command starts and stops its own Pi-managed server for the request.

Setup media checks use native Ollama image/audio requests and Pi-provided generic held-out images.
The vision check uses a red image; Omni combines a separate blue image with audio. Audio speech and
transcription checks share a generated reference utterance; failed synthesis blocks dependent audio
checks. A successful round trip does not independently establish transcription accuracy on
held-out recorded audio.

## Evaluation and activation

Setup evaluates candidates on the current host. Every selected model must pass all its advertised
modality checks for setup to complete. Existing model fitness and tool-calling gates are recorded
separately: a model can be media-ready and usable through its native media command even if it is
not qualified for the general coding-agent pool. Trials use a temporary local-only candidate scope
so newly installed models can be evaluated without changing saved model favorites or the enabled
pool. Request additional trials with `--trials N`:

```bash
pi lfm3 setup --trials 3
```

Inspect installed models and their recorded setup state with:

```bash
pi lfm3 status
```

Activation is opt-in. Every selected model must be media-ready, and at least one selected model
must also pass all router and executor fitness lanes plus task-scale tool calling. Activation uses
only that general-agent-ready subset; a text, vision, or audio specialist that fails the general
agent gates remains installed and registered for its native media command. The primary model must
also pass compaction/digest fitness and support the effective ICM history-summary reasoning level
(default `low`); it is moved to the front of the enabled pool. Modality trial results are judged by
System One. For example:

```bash
pi lfm3 setup --activate
```

Activation adds the qualified subset to model favorites and the enabled model pool. It sets the
primary as the Ollama default, compaction model, and history-summary model; sets foreground and
router-lane thinking to off; enables System One; and enables automatic fitness-gated routing with
the cheap, medium, and expensive pins cleared. The executor and learning model are pinned to the
qualified primary. External summary-model egress is disabled; System One's separate remote judgment
and admission path remains enabled. Fresh workers inherit the qualified foreground model; existing
provider-order preferences are retained. The pool and policies are committed together in one global
settings write; conflicting active profile settings refuse activation. Without `--activate`, setup
does not change the interactive model pool. `status` retains bounded attempts with media, fitness,
tool, and failure evidence.

Setup requires an available configured System One provider for readiness and modality judgments.
Ollama inference is local, but the evaluation and coordination path remains remote.

Activation establishes general-agent eligibility for the tested surfaces, not that a model is fit
for every host workload. Use Pi's existing `/fitness` and task tools to inspect capabilities before
assigning a model to a role or router lane.

## Runtime and coordination

Model inference runs locally through Ollama after the runtime and weights are installed. Initial
runtime/model installation needs network access unless the matching runtime and tag are already
cached. Local inference does not make Pi's coordination offline: remote System One judgments still
use their configured provider and require its network/authentication path.

The supported minimum Ollama version is 0.40.13, which includes the required Linux and Windows
support. Pi manages its runtime separately from a system-wide Ollama installation.

## References

- [Liquid AI LFM3 model family](https://huggingface.co/blog/LiquidAI/lfm3)
- [Ollama LFM3 text tags](https://ollama.com/library/lfm3/tags)
- [Ollama LFM3-VL tags](https://ollama.com/library/lfm3-vl/tags)
- [Ollama LFM3-Audio tags](https://ollama.com/library/lfm3-audio/tags)
- [Ollama LFM3-Omni tags](https://ollama.com/library/lfm3-omni/tags)
- [LFM3-Audio model card](https://huggingface.co/LiquidAI/LFM3-Audio-2B)

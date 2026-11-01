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

Setup fitness uses native Ollama image/audio requests and Pi-provided generic held-out images. The
vision check uses a red image; Omni combines a separate blue image with audio. Audio speech and
transcription checks share a generated reference utterance; if speech generation fails,
transcription is blocked. These checks do not independently establish transcription accuracy on
held-out recorded audio.

## Evaluation and activation

Setup evaluates candidates on the current host. Request additional trials with `--trials N`:

```bash
pi lfm3 setup --trials 3
```

Inspect installed models and their recorded setup state with:

```bash
pi lfm3 status
```

Activation is opt-in and requires every selected model to pass the router/executor fitness lanes,
task-scale tool calling, and the selected model's modality trials. Modality trial results are judged
by System One. For example, selecting all models means all four must pass before activation can
apply:

```bash
pi lfm3 setup --activate
```

Activation enables the local runtime, sets the first selected model as the Ollama default, disables
thinking, and enables the manual fitness-gated router with its tiers and executor set to that model.
It applies only after all selected models pass; there is no partial activation by passing subset.
The validated model pool and routing policy are committed together in one global settings write.
`status` retains bounded setup attempts with errors and fitness evidence to diagnose the result.

Setup requires an available configured System One provider for readiness and modality judgments.
Ollama inference is local, but the evaluation and coordination path remains remote.

Activation does not establish that tool use, audio, or vision is fit for every host workload. Use
Pi's existing `/fitness` and task tools to inspect capabilities before assigning a model to a role or
router lane.

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

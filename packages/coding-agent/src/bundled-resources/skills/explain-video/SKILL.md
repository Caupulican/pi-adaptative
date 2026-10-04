---
name: explain-video
description: "Produce a bespoke narrated explainer video on any topic, in the style of 3Blue1Brown: script, storyboard, animated scenes, voice narration (ElevenLabs when the owner supplies a key, otherwise a local TTS), captions, final MP4. Use when the owner asks for a video, animation, '3b1b style' explainer, narrated walkthrough or screencast-style explanation."
effects: [external-write, network, external-binary, secret]
---

# Explain With a Video

## How to use the skill

A video is the most expensive explanation format. Use it when the owner asks for one. Build it in stages and stop at the first failing stage with the real cause. Narration text follows the `ste100-writing` style at the owner's strictness (default 9): short spoken sentences, one idea each.

Freedom Dial: High Freedom for visual metaphors and pacing. Low Freedom for facts, credentials and external calls.

## Style contract (3b1b-derived logic, own styling)

- One idea per scene. Build the picture piece by piece in step with the narration. Show a transformation, not a slide.
- Intuition first, then the formal statement, then a check on a concrete example.
- Fixed meaning per color and shape for the whole video. Dark background, high contrast, large type.
- Narration paces at about 150 words per minute. Pauses go after each new idea. Default length 2-5 minutes; a longer video needs a scene list the owner approved.
- Do not copy another creator's assets, music, voice or code. Reuse the method, not the styling.

## Pipeline

1. Survey tools. Run `ffmpeg -version`, `ffprobe -version`, `python3 -c "import manim"`, `node --version`, and check for a local TTS (`piper`, `kokoro`, `espeak-ng`, or the OS speech tool). Report what exists. Installing anything needs owner approval; propose the exact commands and stop.
2. Script. Write `script.md`: scenes, each with narration text and a visual note. Read the real source for every claim.
3. Storyboard. One line per scene: start state, the transformation, end state, expected duration from word count.
4. Narration. Generate audio per scene (below). Measure each scene with `ffprobe -show_entries format=duration`. Scene length comes from the measured audio, never the reverse.
5. Visuals. Preferred engine: Manim when installed. Otherwise render frames from an HTML canvas or SVG sequence with a headless browser, or draw with a script and assemble with `ffmpeg`. One script per scene so a failed scene reruns alone.
6. Assemble. Mux each scene's video with its audio, concatenate with `ffmpeg`, burn in or sidecar captions from the script text (`.srt`).
7. Verify. `ffprobe` shows one video and one audio stream and a duration within 2 percent of the audio total. Extract one frame per scene (`ffmpeg -ss <t> -frames:v 1`) and view them with the read tool. Say which checks ran.
8. Deliver the MP4, `script.md`, captions and scene sources to `${PI_EXPLAINERS_DIR:-${TMPDIR:-/tmp}/pi-explainers}/<slug>/`, or where the owner names. Never in tracked docs. Never commit unless asked.

Renders longer than 15 seconds run as managed background runs with an event-driven terminal signal; never poll.

## Narration and credentials

This skill declares `effects` (external writes, network, external binaries, secrets), so the host offers it to the main session only. A worker never sees it: a worker reports what it found and the main session produces the video.

- ElevenLabs: only when the owner asks for it and has supplied a key. Read the key from the `ELEVENLABS_API_KEY` environment variable or activate it model-blind through `secret_store`. Never ask for the key in conversation, never put it in tool arguments, logs, files or the script, never echo it. Request: `POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id>` with header `xi-api-key` and JSON `{"text": ..., "model_id": ...}`; take a current `model_id` and a `voice_id` from the account (`GET /v1/models`, `GET /v1/voices`). Narration text leaves the machine on this call. The owner's request for ElevenLabs is the authorization; do not send it to any other service.
- No key or no request for ElevenLabs: use a local TTS that is already installed. If none exists, produce the silent video with captions, say so, and propose the free local options.
- A failed API call is a blocker with the response status. Do not substitute silently.

## Do not

- Do not fabricate results, durations or checks. Report what ran.
- Do not exceed the owner's grant: no installs, publishing or uploads without approval.

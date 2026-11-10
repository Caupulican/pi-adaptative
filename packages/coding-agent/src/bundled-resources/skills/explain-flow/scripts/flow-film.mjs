#!/usr/bin/env node
/**
 * The flow film tool: turns a flow spec (JSON) into a living diagram.
 *
 *   node flow-film.mjs check <spec.json>                      the storyboard, or every problem of the spec
 *   node flow-film.mjs frame <spec.json> --at 3.5 --out f.png one instant, as .svg or .png
 *   node flow-film.mjs sheet <spec.json> --out sheet.png      a contact sheet of the loop, to review by eye
 *   node flow-film.mjs html  <spec.json> --out flow.html      a self-contained page that plays the loop
 *   node flow-film.mjs video <spec.json> --out flow.mp4       the loop as H.264 (and --gif flow.gif)
 *   node flow-film.mjs import <diagram> --out spec.json       a Mermaid, Graphviz DOT or plan file as a flow spec
 *
 * Every command takes `--theme <name>` (a built-in theme) or `--theme-file <theme.json>` (a harness theme file, so the
 * film follows the theme the owner runs) in place of the spec's own theme.
 *
 * It needs Node only for `check`, `html` and an .svg frame. A .png, a sheet and a video are rasterized by `ffmpeg`
 * built with librsvg, which reads the frames from this process; nothing else is installed or fetched.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drawDefs, drawLive, drawStatic, frameSvg, svgOpen } from "./lib/draw.mjs";
import { specFromGraph } from "./lib/graph-layout.mjs";
import { readDiagram } from "./lib/read-diagram.mjs";
import { buildScene, SpecError, storyboard } from "./lib/scene.mjs";
import { stateAt } from "./lib/state.mjs";
import { themeFromHarness } from "./lib/theme.mjs";

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "lib");
/** The engine's modules in dependency order: a page gets them inlined as one script. */
const ENGINE_MODULES = ["theme.mjs", "geometry.mjs", "svg.mjs", "mechanisms.mjs", "scene.mjs", "state.mjs", "draw.mjs"];
const MAX_FRAMES = 7200;

class UsageError extends Error {}

function readArguments(argv) {
	const [command, specPath, ...rest] = argv;
	const options = {};
	for (let index = 0; index < rest.length; index += 2) {
		const name = rest[index];
		const value = rest[index + 1];
		if (!name?.startsWith("--") || value === undefined) throw new UsageError(`option ${name ?? ""} needs a value`);
		options[name.slice(2)] = value;
	}
	if (!command || !specPath) throw new UsageError("a command and a spec file are needed");
	return { command, specPath, options };
}

function numberOption(options, name, fallback, min, max) {
	if (options[name] === undefined) return fallback;
	const value = Number(options[name]);
	if (!Number.isFinite(value) || value < min || value > max)
		throw new UsageError(`--${name} must be a number from ${min} to ${max}`);
	return value;
}

function outputPath(options, extensions) {
	const out = options.out;
	if (!out) throw new UsageError("--out <file> is needed");
	if (!extensions.includes(extname(out).toLowerCase()))
		throw new UsageError(`--out must end in ${extensions.join(" or ")}`);
	const path = resolve(out);
	mkdirSync(dirname(path), { recursive: true });
	return path;
}

function loadSpec(specPath) {
	let text;
	try {
		text = readFileSync(resolve(specPath), "utf8");
	} catch (error) {
		throw new UsageError(`the spec cannot be read: ${error.message}`);
	}
	try {
		return JSON.parse(text.replace(/^﻿/, ""));
	} catch (error) {
		throw new UsageError(`the spec is not valid JSON: ${error.message}`);
	}
}

/** Why ffmpeg cannot rasterize frames here, or undefined when it can. */
function rasterizerProblem() {
	const probe = spawnSync("ffmpeg", ["-hide_banner", "-decoders"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) return "ffmpeg is not installed (or not on PATH)";
	if (!/\blibrsvg\b/.test(probe.stdout)) return "this ffmpeg is built without librsvg, so it cannot read SVG frames";
	return undefined;
}

function requireRasterizer() {
	const problem = rasterizerProblem();
	if (problem)
		throw new UsageError(
			`${problem}. The html command and an .svg frame need no ffmpeg; a video needs ffmpeg with librsvg (and libx264).`,
		);
}

/** Runs ffmpeg with `inputs` before the output arguments; what it reads on its standard input is written by `feed`. */
function runFfmpeg(inputs, outputArguments, feed) {
	const child = spawn("ffmpeg", ["-v", "error", "-y", ...inputs, ...outputArguments], { stdio: ["pipe", "ignore", "pipe"] });
	let complaint = "";
	child.stderr.on("data", (chunk) => {
		complaint += chunk;
	});
	const done = new Promise((resolveDone, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolveDone();
			else reject(new Error(`ffmpeg ended with code ${code}: ${complaint.trim().split("\n").slice(-3).join(" | ")}`));
		});
	});
	// A pipe ffmpeg closed early is reported by its exit, not by the write that hit it.
	child.stdin.on("error", () => {});
	const fed = (async () => {
		await feed(async (bytes) => {
			if (!child.stdin.write(bytes)) await new Promise((drained) => child.stdin.once("drain", drained));
		});
		child.stdin.end();
	})();
	return Promise.all([done, fed.catch(() => {})]);
}

/**
 * The input arguments and the feed for SVG documents on ffmpeg's standard input. Each document is padded to one byte
 * size, which is how ffmpeg's SVG pipe tells one frame from the next.
 */
function svgPipe(frames, fps) {
	const documents = frames.map((frame) => Buffer.from(frame, "utf8"));
	const size = Math.ceil(Math.max(...documents.map((document) => document.length)) / 1024) * 1024;
	return {
		inputs: ["-f", "svg_pipe", "-frame_size", String(size), "-framerate", String(fps), "-i", "pipe:0"],
		feed: async (write) => {
			for (const document of documents)
				await write(Buffer.concat([document, Buffer.alloc(size - document.length, 0x20)]));
		},
	};
}

/** Rasterizes whole frames (SVG documents) into what `outputArguments` name. */
function rasterize(frames, fps, outputArguments) {
	const pipe = svgPipe(frames, fps);
	return runFfmpeg(pipe.inputs, outputArguments, pipe.feed);
}

const X264 = ["-an", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

async function commandFrame(scene, options) {
	const out = outputPath(options, [".svg", ".png"]);
	const svg = frameSvg(scene, numberOption(options, "at", 0, 0, 100000));
	if (extname(out).toLowerCase() === ".svg") writeFileSync(out, svg);
	else {
		requireRasterizer();
		await rasterize([svg], 1, ["-frames:v", "1", out]);
	}
	return out;
}

async function commandSheet(scene, options) {
	requireRasterizer();
	const out = outputPath(options, [".png", ".jpg"]);
	const count = numberOption(options, "count", 8, 2, 24);
	const columns = numberOption(options, "columns", count <= 4 ? 2 : count <= 9 ? 3 : 4, 1, 6);
	const frames = Array.from({ length: count }, (_, index) => frameSvg(scene, (scene.period * index) / count));
	const rows = Math.ceil(count / columns);
	const width = Math.round(numberOption(options, "width", 960, 240, 1920) / 2) * 2;
	await rasterize(frames, 1, [
		"-vf",
		`scale=${width}:-2,tile=${columns}x${rows}:padding=8:margin=8:color=0x808080`,
		"-frames:v",
		"1",
		out,
	]);
	return out;
}

async function commandVideo(scene, options) {
	requireRasterizer();
	const out = outputPath(options, [".mp4"]);
	const fps = numberOption(options, "fps", scene.fps, 10, 60);
	const loops = numberOption(options, "loops", 1, 1, 20);
	const count = Math.round(scene.period * fps * loops);
	if (count > MAX_FRAMES) throw new UsageError(`${count} frames is past the ${MAX_FRAMES} frame bound; lower --fps or --loops`);
	// The part that never changes is drawn once and every instant is laid over it, so a frame costs only what moves.
	const still = join(mkdtempSync(join(tmpdir(), "flow-film-")), "still.png");
	try {
		await rasterize([`${svgOpen(scene)}${drawStatic(scene)}</svg>`], 1, ["-frames:v", "1", still]);
		const live = svgPipe(
			Array.from({ length: count }, (_, index) => `${svgOpen(scene)}${drawDefs(scene)}${drawLive(scene, stateAt(scene, index / fps))}</svg>`),
			fps,
		);
		await runFfmpeg(
			["-loop", "1", "-framerate", String(fps), "-i", still, ...live.inputs],
			["-filter_complex", "[0:v][1:v]overlay=shortest=1:format=auto", ...X264, out],
			live.feed,
		);
	} finally {
		rmSync(dirname(still), { recursive: true, force: true });
	}
	const written = [out];
	if (options.gif) {
		const gif = resolve(options.gif);
		mkdirSync(dirname(gif), { recursive: true });
		const width = Math.round(numberOption(options, "gif-width", 800, 160, 1920) / 2) * 2;
		const made = spawnSync(
			"ffmpeg",
			["-v", "error", "-y", "-i", out, "-vf", `fps=15,scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, gif],
			{ encoding: "utf8" },
		);
		if (made.status !== 0) throw new Error(`the gif was not written: ${made.stderr.trim().split("\n").at(-1)}`);
		written.push(gif);
	}
	return written.join("\n");
}

/** The engine's modules as one classic script: imports dropped, exports made plain declarations. */
function inlineEngine() {
	return ENGINE_MODULES.map((name) =>
		readFileSync(join(LIB_DIR, name), "utf8")
			.replace(/^import\s[\s\S]*?from\s+"[^"]+";\n/gm, "")
			.replace(/^export\s+/gm, ""),
	).join("\n");
}

function commandHtml(scene, spec, options) {
	const out = outputPath(options, [".html"]);
	const { theme } = scene;
	const font = theme.font.replace(/"/g, "'");
	const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${scene.title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>
<style>
html, body { margin: 0; background: ${theme.bg}; color: ${theme.dim}; font-family: ${font}; }
main { max-width: ${scene.width}px; margin: 0 auto; }
#stage svg { display: block; width: 100%; height: auto; }
#controls { display: flex; justify-content: flex-end; gap: ${scene.unit}px; padding: ${scene.unit}px ${scene.unit * 4}px ${scene.unit * 3}px; }
button { font: inherit; font-size: 13px; color: ${theme.dim}; background: none; border: 1px solid ${theme.line}; border-radius: ${scene.unit * 0.5}px; padding: 6px 12px; cursor: pointer; }
button[aria-pressed="true"] { color: ${theme.text}; border-color: ${theme.text}; }
button:focus-visible { outline: 2px solid ${theme.info}; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<div id="stage" role="img" aria-label="${scene.title.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>
<div id="controls">
<button id="play" type="button" aria-pressed="false">Pause</button>
<button data-speed="1" type="button" aria-pressed="true">1×</button>
<button data-speed="0.5" type="button" aria-pressed="false">½×</button>
<button data-speed="0.25" type="button" aria-pressed="false">¼×</button>
</div>
</main>
<script>
"use strict";
${inlineEngine()}
const scene = buildScene(${JSON.stringify(spec).replace(/</g, "\\u003c")});
const stage = document.getElementById("stage");
stage.innerHTML = svgOpen(scene) + drawDefs(scene) + drawStatic(scene) + '<g id="live"></g></svg>';
const live = stage.querySelector("#live");
const asked = new URLSearchParams(location.search).get("t");
// A page asked for one instant, or a reader who asked for less motion, gets a still that plays on request.
let playing = asked === null && !matchMedia("(prefers-reduced-motion: reduce)").matches;
let clock = asked === null ? 0 : Number(asked) || 0;
let speed = 1;
let last;
const play = document.getElementById("play");
function show() {
	play.textContent = playing ? "Pause" : "Play";
	live.innerHTML = drawLive(scene, stateAt(scene, clock));
}
function tick(now) {
	if (playing && last !== undefined) clock += ((now - last) / 1000) * speed;
	last = now;
	show();
	requestAnimationFrame(tick);
}
play.addEventListener("click", () => {
	playing = !playing;
});
for (const button of document.querySelectorAll("[data-speed]"))
	button.addEventListener("click", () => {
		speed = Number(button.dataset.speed);
		for (const other of document.querySelectorAll("[data-speed]"))
			other.setAttribute("aria-pressed", String(other === button));
	});
addEventListener("keydown", (event) => {
	if (event.code !== "Space" || event.target instanceof HTMLButtonElement) return;
	event.preventDefault();
	playing = !playing;
});
requestAnimationFrame(tick);
</script>
</body>
</html>
`;
	writeFileSync(out, page);
	return out;
}

function commandCheck(scene) {
	const lefts = new Set(scene.nodes.map((node) => Math.round(node.shape.box.x)));
	return [
		`${scene.title}: ${scene.width}x${scene.height}, a ${scene.loop} s loop at ${scene.fps} fps`,
		`${scene.rounds} round(s) of ${scene.loop} s`,
		`${scene.bands.length} band(s), ${scene.nodes.length} station(s) on ${lefts.size} left edge(s), ${scene.wires.length} wire(s), ${scene.runs.length} journey(s)`,
		"Storyboard:",
		...storyboard(scene).map((beat) => `  ${beat}`),
	].join("\n");
}

/** The spec with the theme the caller asked for on the command line in place of its own. */
function withTheme(spec, options) {
	if (options["theme-file"]) {
		const problems = [];
		const theme = themeFromHarness(loadSpec(options["theme-file"]), problems);
		if (problems.length > 0) throw new UsageError(problems.join("; "));
		return { ...spec, theme };
	}
	return options.theme ? { ...spec, theme: options.theme } : spec;
}

/**
 * Reads a diagram in another notation (Mermaid, Graphviz DOT, a harness plan) and writes the flow spec it becomes. The
 * spec is a starting point: what the diagram's notation could not carry, and what the layout check finds, is printed.
 */
function commandImport(sourcePath, options) {
	const out = outputPath(options, [".json"]);
	let source;
	try {
		source = readFileSync(resolve(sourcePath), "utf8");
	} catch (error) {
		throw new UsageError(`the diagram cannot be read: ${error.message}`);
	}
	let converted;
	try {
		converted = specFromGraph(readDiagram(source.replace(/^\uFEFF/, ""), basename(sourcePath)), { title: options.title, theme: options.theme });
	} catch (error) {
		throw new UsageError(error.message);
	}
	writeFileSync(out, `${JSON.stringify(converted.spec, null, "\t")}\n`);
	const lines = [out, ...converted.notes.map((note) => `note: ${note}`)];
	try {
		buildScene(converted.spec);
	} catch (error) {
		if (!(error instanceof SpecError)) throw error;
		lines.push("The converted spec needs these fixes before it renders:", ...error.problems.map((problem) => `- ${problem}`));
	}
	return lines.join("\n");
}

async function main() {
	const { command, specPath, options } = readArguments(process.argv.slice(2));
	if (command === "import") return commandImport(specPath, options);
	const spec = withTheme(loadSpec(specPath), options);
	const scene = buildScene(spec);
	switch (command) {
		case "check":
			return commandCheck(scene);
		case "frame":
			return commandFrame(scene, options);
		case "sheet":
			return commandSheet(scene, options);
		case "video":
			return commandVideo(scene, options);
		case "html":
			return commandHtml(scene, spec, options);
		default:
			throw new UsageError(`unknown command "${command}"`);
	}
}

main().then(
	(result) => console.log(result),
	(error) => {
		if (error instanceof SpecError) console.error(error.message);
		else if (error instanceof UsageError)
			console.error(`Error: ${error.message}\nUsage: node flow-film.mjs <check|frame|sheet|html|video|import> <spec.json or diagram> [--out file] [--at seconds] [--fps n] [--loops n] [--gif file] [--theme name] [--theme-file file] [--title words]`);
		else console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);

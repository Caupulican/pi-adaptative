#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_MODELS = [
	"ollama/qwen3:1.7b",
	"ollama/gemma3:1b",
	"ollama/hf.co/openbmb/MiniCPM5-1B-GGUF:Q8_0",
	"openai-codex/gpt-5.5",
];
const EXPECTED_VERDICTS = new Map([
	["ollama/qwen3:1.7b", "native"],
	["ollama/gemma3:1b", "text-protocol"],
	["ollama/hf.co/openbmb/MiniCPM5-1B-GGUF:Q8_0", "text-protocol"],
]);
const EXPECTED_VARIANTS = new Map([["ollama/hf.co/openbmb/MiniCPM5-1B-GGUF:Q8_0", "function-xml"]]);
const PROBE_ONLY_MODELS = new Set(["openai-codex/gpt-5.5"]);
const TIMEOUT_MS = 180_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
	console.log(`Usage: node scripts/accept-text-protocol-live.mjs [--model <provider/model>]... [--keep-sessions]\n\nRuns C10-style scratch-session live acceptance. Bare model names are treated as ollama/<model>.\nDefault models: ${DEFAULT_MODELS.join(", ")}\nRequires local Ollama with requested Ollama models already pulled and auth for non-Ollama providers.`);
}

function parseArgs(argv) {
	const models = [];
	let keepSessions = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			usage();
			process.exit(0);
		}
		if (arg === "--keep-sessions") {
			keepSessions = true;
			continue;
		}
		if (arg === "--model" && argv[index + 1]) {
			models.push(argv[++index]);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { models: models.length ? models : DEFAULT_MODELS, keepSessions };
}

function writeJson(child, value) {
	child.stdin.write(`${JSON.stringify(value)}\n`);
}

function parseModelRef(input) {
	if (input.includes("/")) {
		const [provider, ...modelParts] = input.split("/");
		return { provider, model: modelParts.join("/"), ref: input };
	}
	return { provider: "ollama", model: input, ref: `ollama/${input}` };
}

async function readJsonIfExists(filePath) {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
}

async function hydrateAgentDir(agentDir) {
	await copyFile(path.join(homedir(), ".pi", "agent", "models.json"), path.join(agentDir, "models.json"));
	const auth = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "auth.json"));
	auth.ollama ??= { type: "api_key", key: "ollama" };
	await writeFile(path.join(agentDir, "auth.json"), JSON.stringify(auth), "utf8");
}

function makeLineReader(stream, onLine) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) onLine(line);
		}
	});
}

function parseJsonLine(line) {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(state, predicate, description, timeoutMs = TIMEOUT_MS, startIndex = 0) {
	for (const event of state.events.slice(startIndex)) {
		if (predicate(event)) return Promise.resolve(event);
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ${description}`));
		}, timeoutMs);
		function listener(event) {
			if (!predicate(event)) return;
			cleanup();
			resolve(event);
		}
		function cleanup() {
			clearTimeout(timeout);
			state.listeners.delete(listener);
		}
		state.listeners.add(listener);
	});
}

function isReadToolResultEvent(event) {
	return event.type === "message_end" && event.message?.role === "toolResult" && event.message.toolName === "read";
}

function eventIsError(event) {
	if (event.type === "tool_execution_end") return event.isError;
	return event.message?.isError;
}

function eventResultJson(event) {
	if (event.type === "tool_execution_end") return JSON.stringify(event.result);
	return JSON.stringify(event.message?.content);
}

async function waitForIdle(child, state, targetRef) {
	for (let attempt = 0; attempt < 60; attempt++) {
		const id = `idle-${targetRef}-${Date.now()}-${attempt}`;
		const startIndex = state.events.length;
		writeJson(child, { id, type: "get_state" });
		const response = await waitForEvent(
			state,
			(event) => event.id === id && event.type === "response" && event.command === "get_state",
			`get_state response for ${targetRef}`,
			30_000,
			startIndex,
		);
		if (!response.success) throw new Error(response.error || `get_state failed for ${targetRef}`);
		if (!response.data?.isStreaming) return;
		await delay(1_000);
	}
	throw new Error(`Timed out waiting for idle state for ${targetRef}`);
}

async function runModel(modelRef, keepSessions) {
	const target = parseModelRef(modelRef);
	const scratch = await mkdtemp(path.join(tmpdir(), `pi-c10-toolproto-${target.ref.replace(/[^a-zA-Z0-9_.-]/g, "-")}-`));
	const sessionDir = path.join(scratch, "sessions");
	const agentDir = path.join(scratch, "agent");
	await mkdir(agentDir, { recursive: true });
	await hydrateAgentDir(agentDir);
	const state = { events: [], listeners: new Set(), stderr: "" };
	let markerPath;
	const child = spawn(
		path.join(root, "pi-test.sh"),
		[
			"--mode",
			"rpc",
			"--provider",
			target.provider,
			"--model",
			target.model,
			"--session-dir",
			sessionDir,
			"--system-prompt",
			"",
			"--no-extensions",
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_SESSION_DIR: sessionDir,
				PI_ADAPTATIVE_CODING_AGENT_DIR: agentDir,
				PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR: sessionDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	makeLineReader(child.stdout, (line) => {
		const event = parseJsonLine(line);
		if (!event) return;
		state.events.push(event);
		for (const listener of [...state.listeners]) listener(event);
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		state.stderr += chunk;
		process.stderr.write(chunk);
	});

	try {
		writeJson(child, { id: `probe-${target.ref}`, type: "tool_probe", model: target.ref });
		const probeResponse = await waitForEvent(
			state,
			(event) => event.id === `probe-${target.ref}` && event.type === "response" && event.command === "tool_probe",
			`tool_probe response for ${target.ref}`,
		);
		if (!probeResponse.success) throw new Error(probeResponse.error || `tool_probe failed for ${target.ref}`);
		const probe = probeResponse.data.results.find((entry) => entry.model === target.ref);
		if (!probe) throw new Error(`tool_probe did not return ${target.ref}`);
		const expectedVerdict = EXPECTED_VERDICTS.get(target.ref);
		if (expectedVerdict && probe.verdict !== expectedVerdict) {
			throw new Error(`${target.ref} expected ${expectedVerdict} probe verdict, got ${probe.verdict}`);
		}
		if (probe.verdict === "none" && !PROBE_ONLY_MODELS.has(target.ref)) {
			throw new Error(`${target.ref} failed tool probe: ${probe.diagnostic || "none"}`);
		}
		if (probe.verdict === "native" && probe.nativeGrade !== "task") {
			throw new Error(`${target.ref} returned native without task native grade: ${probe.nativeGrade || "-"}`);
		}
		if (probe.verdict === "text-protocol" && !probe.variant) {
			throw new Error(`${target.ref} returned text-protocol without a calibrated variant`);
		}
		if (probe.verdict === "text-protocol" && probe.nativeGrade === "task") {
			throw new Error(`${target.ref} calibrated text-protocol even though native task probe passed`);
		}
		const expectedVariant = EXPECTED_VARIANTS.get(target.ref);
		if (expectedVariant && probe.variant !== expectedVariant) {
			throw new Error(`${target.ref} expected ${expectedVariant} variant, got ${probe.variant || "-"}`);
		}
		if (PROBE_ONLY_MODELS.has(target.ref)) {
			return {
				model: target.ref,
				verdict: probe.verdict,
				variant: probe.variant || "-",
				nativeGrade: probe.nativeGrade || "-",
				marker: "probe-only",
				sessionDir,
			};
		}

		const marker = `xok-${Math.random().toString(36).slice(2, 10)}`;
		markerPath = path.join(tmpdir(), `x-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`);
		await writeFile(markerPath, marker, "utf8");
		const prompts = [`Read the file ${markerPath} and tell me exactly what it contains.`];
		let toolEvent;
		for (const [index, message] of prompts.entries()) {
			const promptId = `prompt-${target.ref}-${index + 1}`;
			const promptStartIndex = state.events.length;
			writeJson(child, { id: promptId, type: "prompt", message });
			const promptResponse = await waitForEvent(
				state,
				(event) => event.id === promptId && event.type === "response" && event.command === "prompt",
				`prompt preflight response for ${target.ref}`,
				60_000,
				promptStartIndex,
			);
			if (!promptResponse.success) throw new Error(promptResponse.error || `prompt failed for ${target.ref}`);
			let turnEvent;
			try {
				turnEvent = await waitForEvent(
					state,
					(event) =>
						(event.type === "tool_execution_end" && event.toolName === "read") ||
						isReadToolResultEvent(event) ||
						(event.type === "message_end" &&
							event.message?.role === "assistant" &&
							event.message.stopReason !== "toolUse") ||
						event.type === "agent_end",
					`read tool execution or turn end for ${target.ref}`,
					120_000,
					promptStartIndex,
				);
			} catch {
				await waitForIdle(child, state, target.ref);
				continue;
			}
			if (turnEvent.type === "tool_execution_end" || isReadToolResultEvent(turnEvent)) {
				toolEvent = turnEvent;
				break;
			}
			await waitForIdle(child, state, target.ref);
		}
		if (!toolEvent) throw new Error(`read tool execution for ${target.ref} did not occur`);
		const resultJson = eventResultJson(toolEvent);
		if (eventIsError(toolEvent)) throw new Error(`read tool failed for ${target.ref}: ${resultJson}`);
		if (!resultJson.includes(marker)) {
			throw new Error(`read result for ${target.ref} did not include marker ${marker}: ${resultJson}`);
		}
		return {
			model: target.ref,
			verdict: probe.verdict,
			variant: probe.variant || "-",
			nativeGrade: probe.nativeGrade || "-",
			marker,
			sessionDir,
		};
	} finally {
		child.stdin.end();
		child.kill("SIGTERM");
		if (!keepSessions) {
			await rm(scratch, { recursive: true, force: true });
			if (markerPath) await unlink(markerPath).catch(() => undefined);
		}
	}
}

async function main() {
	const { models, keepSessions } = parseArgs(process.argv.slice(2));
	const results = [];
	for (const model of models) results.push(await runModel(model, keepSessions));
	console.log("model | verdict | variant | nativeGrade | marker");
	console.log("--- | --- | --- | --- | ---");
	for (const result of results) {
		console.log(`${result.model} | ${result.verdict} | ${result.variant} | ${result.nativeGrade} | ${result.marker}`);
	}
	if (keepSessions) {
		for (const result of results) console.log(`session ${result.model}: ${result.sessionDir}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

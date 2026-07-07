#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_MODELS = ["qwen3:1.7b", "gemma3:1b"];
const EXPECTED_VERDICTS = new Map([
	["qwen3:1.7b", "native"],
	["gemma3:1b", "text-protocol"],
]);
const TIMEOUT_MS = 180_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
	console.log(`Usage: node scripts/accept-text-protocol-live.mjs [--model <ollama-model>]... [--keep-sessions]\n\nRuns C10-style scratch-session live acceptance against local Ollama models.\nDefault models: ${DEFAULT_MODELS.join(", ")}\nRequires local Ollama with the requested models already pulled.`);
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

function waitForEvent(state, predicate, description, timeoutMs = TIMEOUT_MS) {
	for (const event of state.events) {
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

async function runModel(model, keepSessions) {
	const scratch = await mkdtemp(path.join(tmpdir(), `pi-c10-toolproto-${model.replace(/[^a-zA-Z0-9_.-]/g, "-")}-`));
	const sessionDir = path.join(scratch, "sessions");
	const agentDir = path.join(scratch, "agent");
	await mkdir(agentDir, { recursive: true });
	await copyFile(path.join(homedir(), ".pi", "agent", "models.json"), path.join(agentDir, "models.json"));
	await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }), "utf8");
	const state = { events: [], listeners: new Set(), stderr: "" };
	const child = spawn(
		path.join(root, "pi-test.sh"),
		["--mode", "rpc", "--provider", "ollama", "--model", model, "--session-dir", sessionDir, "--no-extensions"],
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
		writeJson(child, { id: `probe-${model}`, type: "tool_probe", model: `ollama/${model}` });
		const probeResponse = await waitForEvent(
			state,
			(event) => event.id === `probe-${model}` && event.type === "response" && event.command === "tool_probe",
			`tool_probe response for ${model}`,
		);
		if (!probeResponse.success) throw new Error(probeResponse.error || `tool_probe failed for ${model}`);
		const probe = probeResponse.data.results.find((entry) => entry.model === `ollama/${model}`);
		if (!probe) throw new Error(`tool_probe did not return ollama/${model}`);
		if (probe.verdict === "none") throw new Error(`ollama/${model} failed tool probe: ${probe.diagnostic || "none"}`);
		const expectedVerdict = EXPECTED_VERDICTS.get(model);
		if (expectedVerdict && probe.verdict !== expectedVerdict) {
			throw new Error(`ollama/${model} expected ${expectedVerdict} probe verdict, got ${probe.verdict}`);
		}
		if (probe.verdict === "text-protocol" && !probe.variant) {
			throw new Error(`ollama/${model} returned text-protocol without a calibrated variant`);
		}

		const marker = "piliveok";
		const markerPath = path.join(tmpdir(), "pi-text-protocol-live-marker.txt");
		await writeFile(markerPath, marker, "utf8");
		const prompt =
			probe.verdict === "text-protocol"
				? `Output exactly this text and nothing else: <pi:call name="read">{"path":"${markerPath}"}</pi:call>`
				: `Use the read tool to read exactly: ${markerPath}. Do not answer without using the read tool.`;
		writeJson(child, {
			id: `prompt-${model}`,
			type: "prompt",
			message: prompt,
		});
		const promptResponse = await waitForEvent(
			state,
			(event) => event.id === `prompt-${model}` && event.type === "response" && event.command === "prompt",
			`prompt preflight response for ${model}`,
			60_000,
		);
		if (!promptResponse.success) throw new Error(promptResponse.error || `prompt failed for ${model}`);
		const toolEvent = await waitForEvent(
			state,
			(event) => event.type === "tool_execution_end" && event.toolName === "read",
			`read tool execution for ${model}`,
		);
		if (toolEvent.isError) throw new Error(`read tool failed for ${model}: ${JSON.stringify(toolEvent.result)}`);
		if (!JSON.stringify(toolEvent.result).includes(marker)) {
			throw new Error(`read result for ${model} did not include marker ${marker}: ${JSON.stringify(toolEvent.result)}`);
		}
		return { model, verdict: probe.verdict, variant: probe.variant || "-", marker, sessionDir };
	} finally {
		child.stdin.end();
		child.kill("SIGTERM");
		if (!keepSessions) await rm(scratch, { recursive: true, force: true });
	}
}

async function main() {
	const { models, keepSessions } = parseArgs(process.argv.slice(2));
	const results = [];
	for (const model of models) results.push(await runModel(model, keepSessions));
	console.log("model | verdict | variant | marker");
	console.log("--- | --- | --- | ---");
	for (const result of results) {
		console.log(`${result.model} | ${result.verdict} | ${result.variant} | ${result.marker}`);
	}
	if (keepSessions) {
		for (const result of results) console.log(`session ${result.model}: ${result.sessionDir}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

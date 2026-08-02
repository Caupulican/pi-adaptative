#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	handleAcceptanceHelpFlag,
	readJsonIfExists,
	startPiAcceptanceRpc,
} from "./lib/live-acceptance-rpc.mjs";
import { acquireScriptWorkRun, removeScriptWorkRun } from "./lib/work-directory.mjs";

const DEFAULT_MODEL = "ollama/qwen3:1.7b";
const TIMEOUT_MS = Number(process.env.PI_ACCEPT_COLD_TIMEOUT_MS ?? 900_000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
	console.log(`Usage: node scripts/accept-local-cold-start-live.mjs [--model <ollama/model>] [--store <ollama-models-dir>] [--keep-session]\n\nStarts a fresh isolated Ollama serve on a random loopback port with STOCK pi stall settings, unloads the requested model, then runs one real read-tool turn through pi RPC. The turn fails if a stream stall appears.\n\nDefault model: ${DEFAULT_MODEL}\nDefault store: PI_ACCEPT_OLLAMA_MODELS, else the pi-owned store when it contains the model, else ~/.ollama/models`);
}

function agentDirFromEnv() {
	return process.env.PI_CODING_AGENT_DIR || process.env.PI_ADAPTATIVE_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

function resolveOllamaBin() {
	if (process.env.OLLAMA_BIN) return process.env.OLLAMA_BIN;
	for (const candidate of [
		path.join(agentDirFromEnv(), "runtimes", "ollama", "bin", "ollama"),
		path.join(homedir(), ".local", "share", "ollama-dist", "bin", "ollama"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return "ollama";
}

function manifestPathFor(storeDir, model) {
	const [name, tag = "latest"] = model.split(":");
	if (name.startsWith("hf.co/")) return path.join(storeDir, "manifests", ...name.split("/"), tag);
	return path.join(storeDir, "manifests", "registry.ollama.ai", "library", name, tag);
}

function defaultStoreFor(model) {
	if (process.env.PI_ACCEPT_OLLAMA_MODELS) return process.env.PI_ACCEPT_OLLAMA_MODELS;
	const owned = path.join(agentDirFromEnv(), "models", "ollama");
	if (existsSync(manifestPathFor(owned, model))) return owned;
	return path.join(homedir(), ".ollama", "models");
}

function parseArgs(argv) {
	let modelRef = DEFAULT_MODEL;
	let explicitStoreDir;
	let keepSession = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (handleAcceptanceHelpFlag(arg, usage)) continue;
		if (arg === "--model" && argv[index + 1]) {
			modelRef = argv[++index];
			continue;
		}
		if (arg === "--store" && argv[index + 1]) {
			explicitStoreDir = argv[++index];
			continue;
		}
		if (arg === "--keep-session") {
			keepSession = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!modelRef.startsWith("ollama/")) throw new Error("Cold-start acceptance currently requires an ollama/<model> ref");
	const model = modelRef.slice("ollama/".length);
	return { modelRef, model, storeDir: explicitStoreDir ?? defaultStoreFor(model), keepSession };
}

async function freePort() {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => {
				if (address && typeof address === "object") resolve(address.port);
				else reject(new Error("Could not allocate a loopback port"));
			});
		});
	});
}

async function waitForOllama(baseUrl, model) {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) });
			if (response.ok) {
				const data = await response.json().catch(() => ({}));
				const names = (data.models ?? []).map((entry) => entry.name).filter(Boolean);
				if (names.includes(model)) return;
				throw new Error(`${model} is not present in ${baseUrl}; installed models: ${names.join(", ") || "(none)"}`);
			}
		} catch (error) {
			if (attempt === 119) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
}

async function unloadModel(baseUrl, model) {
	await fetch(`${baseUrl}/api/generate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: 0, options: { num_predict: 0 } }),
		signal: AbortSignal.timeout(60_000),
	}).catch(() => undefined);
}

async function hydrateAgentDir(agentDir, baseUrl, model) {
	const modelsConfig = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "models.json"));
	modelsConfig.providers ??= {};
	modelsConfig.providers.ollama = {
		baseUrl: `${baseUrl}/v1`,
		api: "openai-completions",
		apiKey: "ollama",
		models: [
			{
				id: model,
				name: model,
				contextWindow: 8192,
				maxTokens: 2048,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify(modelsConfig, null, 2), "utf8");
	const auth = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "auth.json"));
	auth.ollama ??= { type: "api_key", key: "ollama" };
	await writeFile(path.join(agentDir, "auth.json"), JSON.stringify(auth, null, 2), "utf8");
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({}, null, 2), "utf8");
}

function eventText(event) {
	return JSON.stringify(event);
}

function isToolReadSuccess(event, marker) {
	if (event.type === "tool_execution_end" && event.toolName === "read" && !event.isError) {
		return eventText(event).includes(marker);
	}
	if (event.type === "message_end" && event.message?.role === "toolResult" && event.message.toolName === "read") {
		return !event.message.isError && eventText(event).includes(marker);
	}
	return false;
}

async function runPiTurn({ agentDir, sessionDir, model, markerPath, marker }) {
	const rpc = startPiAcceptanceRpc({
		root,
		provider: "ollama",
		model,
		agentDir,
		sessionDir,
		timeoutMs: TIMEOUT_MS,
	});
	try {
		const promptStartIndex = rpc.checkpoint();
		rpc.send({
			id: "cold-turn",
			type: "prompt",
			message: `Read the file ${markerPath} and tell me exactly what it contains.`,
		});
		const promptResponse = await rpc.waitForEvent(
			(event) => event.id === "cold-turn" && event.type === "response" && event.command === "prompt",
			"prompt preflight response",
			60_000,
			promptStartIndex,
		);
		if (!promptResponse.success) throw new Error(promptResponse.error || "prompt preflight failed");
		await rpc.waitForEvent(
			(event) => event.type === "agent_end" || isToolReadSuccess(event, marker),
			"cold tool turn",
			TIMEOUT_MS,
			promptStartIndex,
		);
		let successfulRead = false;
		for (let index = promptStartIndex; index < rpc.events.length; index++) {
			const event = rpc.events[index];
			if (eventText(event).includes("stream stalled")) throw new Error("Cold-start turn hit a stream stall");
			if (isToolReadSuccess(event, marker)) successfulRead = true;
		}
		if (!successfulRead) throw new Error("Cold-start turn completed without a successful read tool result");
	} finally {
		rpc.close();
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const ollamaBin = resolveOllamaBin();
	const serve = spawn(ollamaBin, ["serve"], {
		env: {
			...process.env,
			OLLAMA_HOST: `127.0.0.1:${port}`,
			OLLAMA_MODELS: args.storeDir,
			OLLAMA_KEEP_ALIVE: "30m",
			OLLAMA_NUM_PARALLEL: "1",
		},
		stdio: ["ignore", "ignore", "inherit"],
	});
	const serveStart = Promise.race([
		new Promise((resolve) => setTimeout(resolve, 200)),
		new Promise((_, reject) => serve.once("error", reject)),
	]);
	await serveStart;
	const workRun = acquireScriptWorkRun("acceptance", "local-cold-start");
	const scratch = workRun.path;
	const agentDir = path.join(scratch, "agent");
	const sessionDir = path.join(scratch, "sessions");
	const markerPath = path.join(scratch, "marker.txt");
	const marker = `cold-ok-${Math.random().toString(36).slice(2, 10)}`;
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(sessionDir, { recursive: true });
		await waitForOllama(baseUrl, args.model);
		await unloadModel(baseUrl, args.model);
		await hydrateAgentDir(agentDir, baseUrl, args.model);
		await writeFile(markerPath, marker, "utf8");
		await runPiTurn({ agentDir, sessionDir, model: args.model, markerPath, marker });
		console.log(`cold-start ok | ${args.modelRef} | store ${args.storeDir} | session ${args.keepSession ? sessionDir : "removed"}`);
	} finally {
		serve.kill("SIGTERM");
		if (args.keepSession) workRun.release();
		else removeScriptWorkRun(workRun);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

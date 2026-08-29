import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { OllamaRuntime } from "../../packages/coding-agent/src/core/models/local-runtime.ts";
import { readJsonIfExists } from "./live-acceptance-rpc.mjs";

export function acceptanceAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || process.env.PI_ADAPTATIVE_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

function manifestPathFor(storeDir, model) {
	const [name, tag = "latest"] = model.split(":");
	if (name.startsWith("hf.co/")) return path.join(storeDir, "manifests", ...name.split("/"), tag);
	return path.join(storeDir, "manifests", "registry.ollama.ai", "library", name, tag);
}

export function defaultAcceptanceOllamaStore(model, agentDir = acceptanceAgentDir()) {
	if (process.env.PI_ACCEPT_OLLAMA_MODELS) return process.env.PI_ACCEPT_OLLAMA_MODELS;
	const owned = path.join(agentDir, "models", "ollama");
	if (existsSync(manifestPathFor(owned, model))) return owned;
	return path.join(homedir(), ".ollama", "models");
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

export async function startLowImpactAcceptanceOllama({ model, storeDir, agentDir = acceptanceAgentDir() }) {
	const selectedStore = storeDir ?? defaultAcceptanceOllamaStore(model, agentDir);
	if (!existsSync(selectedStore)) throw new Error(`Ollama model store does not exist: ${selectedStore}`);
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const runtime = new OllamaRuntime({ agentDir, baseUrl, profileMode: "low-impact" });
	const started = await runtime.startWithModelsStore(selectedStore);
	if (!started.started) {
		runtime.stop();
		throw new Error(`Could not start isolated low-impact Ollama: ${started.reason}`);
	}
	return { runtime, baseUrl, storeDir: selectedStore };
}

/**
 * Builds a models.json config that replaces any existing `providers.ollama` entry with exactly
 * one model pointed at `baseUrl`. Meant for an isolated scratch agent dir, not a real user
 * config: any other previously configured ollama models are discarded.
 */
export async function buildSingleOllamaModelsConfig(baseUrl, model, contextWindow) {
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
				contextWindow,
				maxTokens: 2048,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};
	return modelsConfig;
}

/**
 * Writes a scratch agent dir's models.json from `modelsConfig`, then auth.json (optionally
 * ensuring an ollama API-key entry so the provider above can authenticate) and an empty
 * settings.json.
 */
export async function writeScratchAgentConfig(agentDir, modelsConfig, { ensureOllamaAuth = false } = {}) {
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify(modelsConfig, null, 2), "utf8");
	const auth = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "auth.json"));
	if (ensureOllamaAuth) auth.ollama ??= { type: "api_key", key: "ollama" };
	await writeFile(path.join(agentDir, "auth.json"), JSON.stringify(auth, null, 2), "utf8");
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({}, null, 2), "utf8");
}

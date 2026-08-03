import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { OllamaRuntime } from "../../packages/coding-agent/src/core/models/local-runtime.ts";

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

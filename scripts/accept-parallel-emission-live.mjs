#!/usr/bin/env node
/**
 * Parallel tool-call emission acceptance probe.
 *
 * Drives one real turn through pi RPC with a task that has three obviously independent reads
 * (three tiny fixture files, one question about all of them), then reports how the assistant
 * actually chose to emit its tool calls: how many assistant messages the turn produced, how many
 * tool calls in total, how many of those messages carried more than one call, and the largest
 * batch seen in a single message.
 *
 * This is a MEASUREMENT, not a judgment. The harness executes independent tool calls
 * concurrently regardless of how many arrive per assistant message; whether a given model
 * actually chooses to emit more than one call per message depends on the model, not just the
 * teaching in the system prompt/tool descriptions. A small local model (the default here is
 * registered at pi's "minimal" tool-capability tier — see hydrateOllamaAgentDir) may never batch
 * no matter how good that teaching is. This script therefore reports the harness+model pair's
 * observed behavior; it does not, and must not, assert that batching happened. Exit code stays 0
 * by default — see PI_ACCEPT_MIN_BATCH below for an opt-in threshold gate.
 *
 * Degrades cleanly when no local model server is reachable (no Ollama binary, no models store,
 * or the requested model was never pulled): prints "skipped: ..." and exits 0 rather than
 * failing or hanging. Every wait in this script is bounded.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	handleAcceptanceHelpFlag,
	readJsonIfExists,
	startPiAcceptanceRpc,
} from "./lib/live-acceptance-rpc.mjs";
import { successfulToolResults } from "./lib/live-tool-results.mjs";
import { acquireScriptWorkRun, removeScriptWorkRun } from "./lib/work-directory.mjs";
import { startLowImpactAcceptanceOllama } from "./lib/ollama-acceptance-runtime.mjs";

const DEFAULT_MODEL = "ollama/qwen3:1.7b";
const TIMEOUT_MS = Number(process.env.PI_ACCEPT_PARALLEL_TIMEOUT_MS ?? 300_000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
	console.log(`Usage: node scripts/accept-parallel-emission-live.mjs [--model <provider/model>]

Runs one real pi RPC turn asking the model to read 3 tiny independent fixture files and answer
one question about them, then reports how many tool calls the assistant emitted per message.
Informational only (always exits 0) unless PI_ACCEPT_MIN_BATCH is set.

Default model: ${DEFAULT_MODEL} (bare names are treated as ollama/<model>)
A non-ollama model is only prepared by copying this machine's already-configured
~/.pi/agent/models.json + auth.json into an isolated scratch agent dir — no new provider
plumbing is added here; the model must already work with plain pi usage.

Env:
  PI_ACCEPT_MIN_BATCH        integer; if set, exit non-zero when the observed maxBatchSize < N
  PI_ACCEPT_PARALLEL_TIMEOUT_MS  bounded timeout for the probe turn (default 300000)

Skips cleanly (prints "skipped: ..." and exits 0) when no local Ollama binary/models
store/pulled model is available for the default/ollama path.`);
}

function parseArgs(argv) {
	let modelRef = DEFAULT_MODEL;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (handleAcceptanceHelpFlag(arg, usage)) continue;
		if (arg === "--model" && argv[index + 1]) {
			modelRef = argv[++index];
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { modelRef };
}

function parseModelRef(input) {
	if (input.includes("/")) {
		const [provider, ...modelParts] = input.split("/");
		return { provider, model: modelParts.join("/"), ref: input };
	}
	return { provider: "ollama", model: input, ref: `ollama/${input}` };
}

async function waitForOllamaModel(baseUrl, model, { attempts = 20, intervalMs = 500 } = {}) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
		if (response?.ok) {
			const data = await response.json().catch(() => ({}));
			const names = (data.models ?? []).map((entry) => entry.name).filter(Boolean);
			if (names.includes(model)) return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`${model} is not present at ${baseUrl}`);
}

async function prepareOllamaTarget(model) {
	const managed = await startLowImpactAcceptanceOllama({ model });
	try {
		await waitForOllamaModel(managed.baseUrl, model);
	} catch (error) {
		managed.runtime.stop();
		throw error;
	}
	return managed;
}

async function hydrateOllamaAgentDir(agentDir, baseUrl, model) {
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
				// This is pi's OWN capability-classification metadata, not Ollama's real serving
				// context — neither this script nor Ollama's default serve is asked to actually
				// handle 8192 tokens. It must stay >= MODEL_CAPABILITY_MINIMAL_MIN_CONTEXT (8192,
				// core/model-capability.ts) or the harness classifies the model as "chat" class and
				// restricts it to goal-lifecycle tools only (no read/write/edit/bash at all) — a
				// registered 4096 (below the threshold) was verified to reproduce exactly that,
				// including against the pre-existing accept-local-cold-start-live.mjs.
				contextWindow: 8_192,
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

/** Non-ollama models: reuse whatever this machine already has configured; add no new plumbing. */
async function hydratePassthroughAgentDir(agentDir) {
	const modelsConfig = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "models.json"));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify(modelsConfig, null, 2), "utf8");
	const auth = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "auth.json"));
	await writeFile(path.join(agentDir, "auth.json"), JSON.stringify(auth, null, 2), "utf8");
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({}, null, 2), "utf8");
}

async function writeFixtures(scratch) {
	const letters = ["a", "b", "c"];
	const files = letters.map((letter) => path.join(scratch, `fixture-${letter}.txt`));
	await Promise.all(
		files.map((file, index) => writeFile(file, `${letters[index]}-${Math.random().toString(36).slice(2, 8)}`, "utf8")),
	);
	return files;
}

/** Counts tool calls per assistant message across one turn's events. Pure observation — no gate. */
function summarizeAssistantMessages(events) {
	let assistantTurns = 0;
	let toolCalls = 0;
	let multiCallMessages = 0;
	let maxBatchSize = 0;
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		assistantTurns++;
		const count = (event.message.content ?? []).filter((block) => block.type === "toolCall").length;
		toolCalls += count;
		if (count > 1) multiCallMessages++;
		if (count > maxBatchSize) maxBatchSize = count;
	}
	return { assistantTurns, toolCalls, multiCallMessages, maxBatchSize };
}

async function runProbeTurn({ agentDir, sessionDir, provider, model, fixtures }) {
	const rpc = startPiAcceptanceRpc({ root, provider, model, agentDir, sessionDir, timeoutMs: TIMEOUT_MS });
	try {
		const startIndex = rpc.checkpoint();
		const prompt = `Read these 3 files, then reply with each file's exact contents on its own line:\n${fixtures.join("\n")}`;
		rpc.send({ id: "parallel-emission-turn", type: "prompt", message: prompt });
		const promptResponse = await rpc.waitForEvent(
			(event) => event.id === "parallel-emission-turn" && event.type === "response" && event.command === "prompt",
			"prompt preflight response",
			60_000,
			startIndex,
		);
		if (!promptResponse.success) throw new Error(promptResponse.error || "prompt preflight failed");
		await rpc.waitForEvent((event) => event.type === "agent_end", "parallel-emission turn", TIMEOUT_MS, startIndex);
		const turnEvents = rpc.events.slice(startIndex);
		const readFailure = turnEvents.find(
			(event) => event.type === "tool_execution_end" && event.toolName === "read" && event.isError,
		);
		if (readFailure) {
			// A read against our own controlled fixture failing is a probe bug, not a model-behavior
			// measurement — surface it as a real error rather than folding it into a benign-looking count.
			throw new Error(`read tool failed against a fixture file: ${JSON.stringify(readFailure.result)}`);
		}
		const readSuccessCount = successfulToolResults(turnEvents, "read").length;
		return { metrics: summarizeAssistantMessages(turnEvents), readSuccessCount };
	} finally {
		rpc.close();
	}
}

async function main() {
	const { modelRef } = parseArgs(process.argv.slice(2));
	const parsed = parseModelRef(modelRef);

	let managed;
	if (parsed.provider === "ollama") {
		try {
			managed = await prepareOllamaTarget(parsed.model);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.log(`skipped: no model server reachable (${detail})`);
			return;
		}
	}

	const workRun = acquireScriptWorkRun("acceptance", "parallel-emission");
	const scratch = workRun.path;
	const agentDir = path.join(scratch, "agent");
	const sessionDir = path.join(scratch, "sessions");
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(sessionDir, { recursive: true });
		if (managed) await hydrateOllamaAgentDir(agentDir, managed.baseUrl, parsed.model);
		else await hydratePassthroughAgentDir(agentDir);

		const fixtures = await writeFixtures(scratch);
		const { metrics, readSuccessCount } = await runProbeTurn({
			agentDir,
			sessionDir,
			provider: parsed.provider,
			model: parsed.model,
			fixtures,
		});

		console.log(
			`parallel-emission probe (informational, not a batching guarantee) | model=${parsed.ref} | ` +
				`readSuccesses=${readSuccessCount}/${fixtures.length} | assistantTurns=${metrics.assistantTurns} ` +
				`toolCalls=${metrics.toolCalls} multiCallMessages=${metrics.multiCallMessages} maxBatchSize=${metrics.maxBatchSize}`,
		);
		console.log(JSON.stringify(metrics));

		const minBatchRaw = process.env.PI_ACCEPT_MIN_BATCH;
		if (minBatchRaw !== undefined) {
			const minBatch = Number.parseInt(minBatchRaw.trim(), 10);
			if (Number.isInteger(minBatch) && metrics.maxBatchSize < minBatch) {
				console.error(`maxBatchSize ${metrics.maxBatchSize} is below PI_ACCEPT_MIN_BATCH ${minBatch}`);
				process.exitCode = 1;
			}
		}
	} finally {
		removeScriptWorkRun(workRun);
		if (managed) managed.runtime.stop();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

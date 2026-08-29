#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planManagedOllamaModel } from "../packages/coding-agent/src/core/models/managed-ollama-model.ts";
import {
	handleAcceptanceHelpFlag,
	parseModelRef,
	readJsonIfExists,
	startPiAcceptanceRpc,
} from "./lib/live-acceptance-rpc.mjs";
import {
	assistantReportedToolMarker,
	failedToolResult,
	successfulToolResults,
	toolResultJson,
} from "./lib/live-tool-results.mjs";
import { acquireScriptWorkRun, removeScriptWorkRun } from "./lib/work-directory.mjs";
import { startLowImpactAcceptanceOllama } from "./lib/ollama-acceptance-runtime.mjs";

const MINICPM_PROVIDER = "pi-hf-transformers";
const MINICPM_MODEL_ID = "openbmb/MiniCPM5-1B";
const MINICPM_MODEL_REF = `${MINICPM_PROVIDER}/${MINICPM_MODEL_ID}`;
const BONSAI_4B_MODEL_REF = "ollama/hf.co/prism-ml/Bonsai-4B-gguf:Q1_0";
const DEFAULT_MODELS = [
	"ollama/qwen3:1.7b",
	BONSAI_4B_MODEL_REF,
	"ollama/gemma3:1b",
	MINICPM_MODEL_REF,
	"openai-codex/gpt-5.5",
];
const EXPECTED_VERDICTS = new Map([
	["ollama/qwen3:1.7b", "native"],
	[BONSAI_4B_MODEL_REF, "text-protocol"],
	["ollama/gemma3:1b", "text-protocol"],
	[MINICPM_MODEL_REF, "native"],
]);
const EXPECTED_NATIVE_GRADES = new Map([[BONSAI_4B_MODEL_REF, "absent"]]);
const EXPECTED_VARIANTS = new Map();
const PROBE_ONLY_MODELS = new Set(["openai-codex/gpt-5.5"]);
const TIMEOUT_MS = Number(process.env.PI_ACCEPT_LIVE_TIMEOUT_MS ?? 600_000);
const CPU_SAFE_STALL = { connectMs: 120_000, activeIdleMs: 180_000, quietIdleMs: 900_000 };
const PROFILE_PROMPT_TOKENS = 8_000;
const ADAPTIVE_STALL_CEILING_MS = 30 * 60_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
	console.log(`Usage: node scripts/accept-text-protocol-live.mjs [--model <provider/model>]... [--keep-sessions]\n\nRuns C10-style scratch-session live acceptance. Bare model names are treated as ollama/<model>.\nDefault models: ${DEFAULT_MODELS.join(", ")}\nRequires local Ollama with requested Ollama models already pulled, auth for non-Ollama providers, and the pi-managed MiniCPM Transformers sidecar for ${MINICPM_MODEL_ID} at PI_MINICPM_BASE_URL or http://127.0.0.1:18839/v1.`);
}

function parseArgs(argv) {
	const models = [];
	let keepSessions = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (handleAcceptanceHelpFlag(arg, usage)) continue;
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

function miniCpmBaseUrl() {
	return process.env.PI_MINICPM_BASE_URL || "http://127.0.0.1:18839/v1";
}

async function prepareOllamaAcceptanceTarget(target, runtime) {
	if (target.provider !== "ollama") return target;
	if (!runtime) throw new Error(`Missing managed Ollama runtime for ${target.ref}`);
	const shown = await runtime.show(target.model);
	if (!shown.ok) throw new Error(`Could not inspect ${target.ref}: ${shown.error}`);
	const numCtx = 4_096;
	const plan = planManagedOllamaModel({
		sourceRef: target.model,
		modelInfo: shown.info.modelInfo,
		numCtx,
	});
	if (!plan) throw new Error(`Could not create a managed acceptance profile for ${target.ref}`);
	const created = await runtime.createModel({ name: plan.name, ...plan.create });
	if (!created.ok) {
		throw new Error(`Could not create ${plan.name} for ${target.ref}: ${created.error}`);
	}
	return {
		...target,
		model: plan.name,
		ref: `ollama/${plan.name}`,
		expectationRef: target.ref,
		baseUrl: `${runtime.baseUrl}/v1`,
		contextWindow: numCtx,
	};
}

function ensureOllamaModel(modelsConfig, target) {
	if (target.provider !== "ollama") return;
	modelsConfig.providers ??= {};
	modelsConfig.providers.ollama ??= {
		baseUrl: target.baseUrl,
		api: "openai-completions",
		apiKey: "ollama",
		models: [],
	};
	const provider = modelsConfig.providers.ollama;
	provider.baseUrl = target.baseUrl;
	provider.api ??= "openai-completions";
	provider.apiKey ??= "ollama";
	provider.models ??= [];
	if (!provider.models.some((model) => model.id === target.model)) {
		provider.models.push({
			id: target.model,
			name: target.model,
			contextWindow: target.contextWindow ?? 32_768,
			maxTokens: Math.min(2_048, Math.max(512, Math.floor((target.contextWindow ?? 16_384) / 8))),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
}

function ensureMiniCpmFullBaseProvider(modelsConfig) {
	// Preserve the user's configured models. The full-base MiniCPM entry is scratch-only for this
	// acceptance run; it does not remove or replace existing Ollama/GGUF entries. MiniCPM is a
	// native tool-calling target here: the pi-managed sidecar translates its function dialect into
	// provider-native tool_calls so the shared validation/repair layer can handle malformed args.
	modelsConfig.providers ??= {};
	modelsConfig.providers[MINICPM_PROVIDER] ??= {
		baseUrl: miniCpmBaseUrl(),
		api: "openai-completions",
		apiKey: "pi-transformers",
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
		models: [],
	};
	const provider = modelsConfig.providers[MINICPM_PROVIDER];
	provider.baseUrl ??= miniCpmBaseUrl();
	provider.api ??= "openai-completions";
	provider.apiKey ??= "pi-transformers";
	provider.compat ??= {};
	provider.compat.supportsDeveloperRole ??= false;
	provider.compat.supportsReasoningEffort ??= false;
	provider.models ??= [];
	if (!provider.models.some((model) => model.id === MINICPM_MODEL_ID)) {
		provider.models.push({
			id: MINICPM_MODEL_ID,
			name: "MiniCPM5-1B (full base)",
			contextWindow: 131_072,
			maxTokens: 2048,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
}

async function perfProfileFor(modelRef) {
	const store = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "state", "model-adaptation.json"));
	for (const models of Object.values(store.hosts ?? {})) {
		const entry = models?.[modelRef];
		if (entry?.profile?.perf?.samples > 0) return entry.profile.perf;
	}
	return undefined;
}

function stallSettingsFromPerf(perf) {
	if (!perf?.prefillTokensPerSecond || perf.prefillTokensPerSecond <= 0) return CPU_SAFE_STALL;
	const expectedPrefillMs = (PROFILE_PROMPT_TOKENS / perf.prefillTokensPerSecond) * 1000;
	return {
		...CPU_SAFE_STALL,
		quietIdleMs: Math.min(
			ADAPTIVE_STALL_CEILING_MS,
			Math.max(CPU_SAFE_STALL.quietIdleMs, Math.ceil(expectedPrefillMs * 3)),
		),
	};
}

async function hydrateAgentDir(agentDir, target) {
	const modelsConfig = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "models.json"));
	ensureMiniCpmFullBaseProvider(modelsConfig);
	ensureOllamaModel(modelsConfig, target);
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify(modelsConfig, null, 2), "utf8");
	const auth = await readJsonIfExists(path.join(homedir(), ".pi", "agent", "auth.json"));
	auth.ollama ??= { type: "api_key", key: "ollama" };
	await writeFile(path.join(agentDir, "auth.json"), JSON.stringify(auth), "utf8");
	const stall = stallSettingsFromPerf(await perfProfileFor(target.ref));
	await writeFile(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ retry: { stall }, httpIdleTimeoutMs: 0 }, null, 2),
		"utf8",
	);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedAssistantDiagnostic(events) {
	const content = events
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.flatMap((event) => event.message.content ?? [])
		.map((block) => {
			if (block.type === "text") return { type: "text", text: block.text };
			if (block.type === "thinking") return { type: "thinking", thinking: block.thinking };
			if (block.type === "toolCall") return { type: "toolCall", name: block.name, arguments: block.arguments };
			return { type: block.type };
		});
	return JSON.stringify(content).slice(0, 2_000);
}

async function waitForIdle(rpc, targetRef) {
	for (let attempt = 0; attempt < 60; attempt++) {
		const id = `idle-${targetRef}-${Date.now()}-${attempt}`;
		const startIndex = rpc.checkpoint();
		rpc.send({ id, type: "get_state" });
		const response = await rpc.waitForEvent(
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

async function runPrompt(rpc, targetRef, index, message) {
	const promptId = `prompt-${targetRef}-${index}`;
	const startIndex = rpc.checkpoint();
	rpc.send({ id: promptId, type: "prompt", message });
	const promptResponse = await rpc.waitForEvent(
		(event) => event.id === promptId && event.type === "response" && event.command === "prompt",
		`prompt preflight response for ${targetRef}`,
		60_000,
		startIndex,
	);
	if (!promptResponse.success) throw new Error(promptResponse.error || `prompt failed for ${targetRef}`);
	try {
		await rpc.waitForEvent(
			(event) => event.type === "agent_end",
			`turn end for ${targetRef}`,
			TIMEOUT_MS,
			startIndex,
		);
	} catch {
		await waitForIdle(rpc, targetRef);
	}
	return rpc.events.slice(startIndex);
}

function requireSuccessfulTool(events, targetRef, toolName, minimum = 1, marker) {
	const failed = failedToolResult(events, toolName);
	if (failed) throw new Error(`${toolName} tool failed for ${targetRef}: ${toolResultJson(failed)}`);
	const successful = successfulToolResults(events, toolName);
	if (successful.length < minimum) {
		throw new Error(
			`${targetRef} executed ${successful.length}/${minimum} required successful ${toolName} calls; ` +
				`assistant output: ${boundedAssistantDiagnostic(events) || "(none)"}`,
		);
	}
	if (marker && !successful.some((event) => toolResultJson(event).includes(marker))) {
		throw new Error(`${toolName} result for ${targetRef} did not include marker ${marker}`);
	}
}

function requireAssistantToolMarker(events, targetRef, toolName, marker) {
	if (assistantReportedToolMarker(events, toolName, marker)) return;
	throw new Error(
		`${targetRef} did not use the successful ${toolName} result in its visible answer; ` +
			`assistant output: ${boundedAssistantDiagnostic(events) || "(none)"}`,
	);
}

async function runReadAcceptance(rpc, target, markerPath, marker) {
	const events = await runPrompt(
		rpc,
		target.ref,
		1,
		`Read the file ${markerPath} and tell me exactly what it contains.`,
	);
	requireSuccessfulTool(events, target.ref, "read", 1, marker);
	requireAssistantToolMarker(events, target.ref, "read", marker);
	return marker;
}

async function runPhoneFilesystemAcceptance(rpc, target, scratch) {
	const sourceMarker = `phone-read-${Math.random().toString(36).slice(2, 10)}`;
	const beforeMarker = `phone-before-${Math.random().toString(36).slice(2, 10)}`;
	const afterMarker = `phone-after-${Math.random().toString(36).slice(2, 10)}`;
	const shellMarker = `phone-shell-${Math.random().toString(36).slice(2, 10)}`;
	const sourcePath = path.join(scratch, "phone-source.txt");
	const targetPath = path.join(scratch, "phone-target.txt");
	await writeFile(sourcePath, sourceMarker, "utf8");

	const readEvents = await runPrompt(
		rpc,
		target.ref,
		1,
		`Use the read tool to read ${sourcePath}. Do not guess its contents.`,
	);
	requireSuccessfulTool(readEvents, target.ref, "read", 1, sourceMarker);
	requireAssistantToolMarker(readEvents, target.ref, "read", sourceMarker);

	const writeEvents = await runPrompt(
		rpc,
		target.ref,
		2,
		`Use the write tool to create ${targetPath} containing exactly ${beforeMarker}. Follow the tool's prepare/write sequence.`,
	);
	requireSuccessfulTool(writeEvents, target.ref, "write", 2);
	if ((await readFile(targetPath, "utf8")) !== beforeMarker) {
		throw new Error(`write workflow for ${target.ref} did not create the exact requested bytes`);
	}

	const editEvents = await runPrompt(
		rpc,
		target.ref,
		3,
		`Use the edit tool to replace exactly ${beforeMarker} with ${afterMarker} in ${targetPath}. Follow the tool's prepare/edit sequence.`,
	);
	requireSuccessfulTool(editEvents, target.ref, "edit", 2);
	if ((await readFile(targetPath, "utf8")) !== afterMarker) {
		throw new Error(`edit workflow for ${target.ref} did not produce the exact requested bytes`);
	}

	const shellCommand = `node -e "process.stdout.write('${shellMarker}')"`;
	const shellEvents = await runPrompt(
		rpc,
		target.ref,
		4,
		`Use the bash tool to run this exact cross-platform Node command: ${shellCommand}`,
	);
	requireSuccessfulTool(shellEvents, target.ref, "bash", 1, shellMarker);

	const finalReadEvents = await runPrompt(
		rpc,
		target.ref,
		5,
		`Use the read tool to verify the final contents of ${targetPath}.`,
	);
	requireSuccessfulTool(finalReadEvents, target.ref, "read", 1, afterMarker);
	requireAssistantToolMarker(finalReadEvents, target.ref, "read", afterMarker);
	return afterMarker;
}

async function runPreparedModel(target, keepSessions) {
	const expectationRef = target.expectationRef ?? target.ref;
	const workRun = acquireScriptWorkRun("acceptance", "text-protocol");
	const scratch = workRun.path;
	const sessionDir = path.join(scratch, "sessions");
	const agentDir = path.join(scratch, "agent");
	await mkdir(agentDir, { recursive: true });
	await hydrateAgentDir(agentDir, target);
	let markerPath;
	const rpc = startPiAcceptanceRpc({
		root,
		provider: target.provider,
		model: target.model,
		agentDir,
		sessionDir,
		timeoutMs: TIMEOUT_MS,
	});

	try {
		const probeStartIndex = rpc.checkpoint();
		rpc.send({ id: `probe-${target.ref}`, type: "tool_probe", model: target.ref });
		const probeResponse = await rpc.waitForEvent(
			(event) => event.id === `probe-${target.ref}` && event.type === "response" && event.command === "tool_probe",
			`tool_probe response for ${target.ref}`,
			TIMEOUT_MS,
			probeStartIndex,
		);
		if (!probeResponse.success) throw new Error(probeResponse.error || `tool_probe failed for ${target.ref}`);
		const probe = probeResponse.data.results.find((entry) => entry.model === target.ref);
		if (!probe) throw new Error(`tool_probe did not return ${target.ref}`);
		const expectedVerdict = EXPECTED_VERDICTS.get(expectationRef);
		if (expectedVerdict && probe.verdict !== expectedVerdict) {
			throw new Error(`${target.ref} expected ${expectedVerdict} probe verdict, got ${probe.verdict}`);
		}
		if (probe.verdict === "none" && !PROBE_ONLY_MODELS.has(expectationRef)) {
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
		const expectedNativeGrade = EXPECTED_NATIVE_GRADES.get(expectationRef);
		if (expectedNativeGrade && probe.nativeGrade !== expectedNativeGrade) {
			throw new Error(`${target.ref} expected native grade ${expectedNativeGrade}, got ${probe.nativeGrade || "-"}`);
		}
		const expectedVariant = EXPECTED_VARIANTS.get(expectationRef);
		if (expectedVariant && probe.variant !== expectedVariant) {
			throw new Error(`${target.ref} expected ${expectedVariant} variant, got ${probe.variant || "-"}`);
		}
		if (PROBE_ONLY_MODELS.has(expectationRef)) {
			return {
				model: expectationRef,
				verdict: probe.verdict,
				variant: probe.variant || "-",
				nativeGrade: probe.nativeGrade || "-",
				marker: "probe-only",
				sessionDir,
			};
		}

		let marker;
		if (probe.verdict === "text-protocol") {
			marker = await runPhoneFilesystemAcceptance(rpc, target, scratch);
		} else {
			marker = `xok-${Math.random().toString(36).slice(2, 10)}`;
			markerPath = path.join(scratch, `marker-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`);
			await writeFile(markerPath, marker, "utf8");
			await runReadAcceptance(rpc, target, markerPath, marker);
		}
		return {
			model: expectationRef,
			runtimeModel: target.ref,
			verdict: probe.verdict,
			variant: probe.variant || "-",
			nativeGrade: probe.nativeGrade || "-",
			marker,
			sessionDir,
		};
	} catch (error) {
		if (!keepSessions) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${detail}; preserved session: ${sessionDir}`);
	} finally {
		rpc.close();
		if (keepSessions) workRun.release();
		else removeScriptWorkRun(workRun);
	}
}

async function runModel(modelRef, keepSessions) {
	const parsed = parseModelRef(modelRef);
	if (parsed.provider !== "ollama") return runPreparedModel(parsed, keepSessions);
	const managed = await startLowImpactAcceptanceOllama({ model: parsed.model });
	try {
		const target = await prepareOllamaAcceptanceTarget(parsed, managed.runtime);
		return await runPreparedModel(target, keepSessions);
	} finally {
		managed.runtime.stop();
	}
}

async function main() {
	const { models, keepSessions } = parseArgs(process.argv.slice(2));
	const results = [];
	for (const model of models) results.push(await runModel(model, keepSessions));
	console.log("model | verdict | variant | nativeGrade | marker");
	console.log("--- | --- | --- | --- | ---");
	for (const result of results) {
		const runtime = result.runtimeModel && result.runtimeModel !== result.model ? ` (${result.runtimeModel})` : "";
		console.log(`${result.model}${runtime} | ${result.verdict} | ${result.variant} | ${result.nativeGrade} | ${result.marker}`);
	}
	if (keepSessions) {
		for (const result of results) console.log(`session ${result.model}: ${result.sessionDir}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

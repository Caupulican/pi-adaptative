/**
 * `/models` local-model lifecycle and `/fitness` probe/role-assignment flows
 * extracted from interactive-mode.
 *
 * `/models` is a USER-invoked local-model manager (list/add/remove/stop, never a
 * model-invokable tool); the fitness helpers probe a model on the current host
 * and land a shaped role. The server/selector flows share a `LocalModelHost`
 * seam, while `runFitnessAndAssign`/`assignFitnessRole` take narrow host shapes
 * matching their prototype-driven behaviour tests (fitness-probe-gate,
 * fitness-role-assignment), which keep exercising interactive-mode's thin
 * wrappers unchanged.
 */

import { existsSync, rmSync } from "node:fs";
import { totalmem } from "node:os";
import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai";
import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
	type TUI,
} from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { evaluateSurfaceFitness } from "../../core/model-router/fitness-gate.ts";
import {
	deriveLocalContextSizing,
	renderOllamaContextModelfile,
	sizedLocalModelRef,
} from "../../core/models/context-sizing.ts";
import { DEFAULT_MODEL_SUGGESTIONS } from "../../core/models/default-model-suggestions.ts";
import { FitnessStore } from "../../core/models/fitness-store.ts";
import { PrismLlamaCppRuntime, type PrismModelDescriptor } from "../../core/models/llamacpp-runtime.ts";
import {
	HF_TRANSFORMERS_PROVIDER,
	PRISM_LLAMACPP_PROVIDER,
	registerLocalModel,
	registerPrismLlamaCppModel,
	registerTransformersModel,
	unregisterLocalModel,
	unregisterPrismLlamaCppModel,
	unregisterTransformersModel,
} from "../../core/models/local-registration.ts";
import type { OllamaRuntime, TransformersRuntime } from "../../core/models/local-runtime.ts";
import { matchesInstalledLocalModel, normalizeModelSource } from "../../core/models/model-ref.ts";
import { NeedleRuntime } from "../../core/models/needle-runtime.ts";
import {
	derivePrismLlamaCppNumCtx,
	ensurePrismModelFilesThenServe,
	isPiManagedPrismLlamaCppModel,
	PRISM_LLAMACPP_DESCRIPTORS,
	PRISM_LLAMACPP_SERVE_PORT,
} from "../../core/models/prism-llamacpp-lifecycle.ts";
import { formatModelFitnessReport, isProbeAllFailed } from "../../core/research/model-fitness.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { type FitnessRole, FitnessRoleSelectorComponent } from "./components/fitness-role-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ModelSuggestionSelectorComponent } from "./components/model-suggestion-selector.ts";
import { getSelectListTheme } from "./theme/theme.ts";

type SelectorFactory = (done: () => void) => { component: Component; focus: Component };

const MODEL_ROUTER_THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const MODEL_ROUTER_THINKING_INHERIT_VALUE = "__inherit_model_router_thinking__";
const MODEL_ROUTER_THINKING_INHERIT_LABEL = "(inherit)";

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
	max: "Maximum reasoning depth for the hardest problems",
	ultra: "Maximum reasoning with reinforced proactive delegation",
};

const MODEL_ROUTER_THINKING_FALLBACK_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

type RouterThinkingLevel = ThinkingLevel | typeof MODEL_ROUTER_THINKING_INHERIT_VALUE;
type ModelRouterThinkingField =
	| "cheapThinking"
	| "mediumThinking"
	| "expensiveThinking"
	| "executorThinking"
	| "judgeThinking";

/** Narrow seam for persisting a probed model's role — matches the fitness-role test. */
export interface AssignRoleHost {
	readonly settingsManager: SettingsManager;
	showStatus(message: string): void;
}

/** Seam for the fitness probe + role-selector flow — matches the fitness-probe-gate test. */
export interface RunFitnessHost {
	readonly session: Pick<AgentSession, "runModelFitness"> & { modelRegistry?: ModelRegistry };
	readonly settingsManager: SettingsManager;
	readonly chatContainer: Container;
	readonly ui: TUI;
	showStatus(message: string): void;
	showError(message: string): void;
	showSelector(create: SelectorFactory): void;
}

/** Full seam for the `/models` server/selector flows. */
export interface LocalModelHost {
	readonly localRuntime: OllamaRuntime;
	readonly session: AgentSession;
	readonly settingsManager: SettingsManager;
	readonly ui: TUI;
	readonly chatContainer: Container;
	getTransformersRuntime(modelId: string, baseUrl?: string): TransformersRuntime;
	/**
	 * Seam for the pi-managed prism llama.cpp runtime (Bonsai-27B and future curated prism-ml
	 * models). Production (interactive-mode.ts's `localModelHost()`) always supplies this, wired
	 * through `AgentSession.getPrismLlamaCppRuntime()` -> `LocalRuntimeController`'s cached instance
	 * — the SAME instance the readiness gate uses, mirroring `getTransformersRuntime` above (cached
	 * for the session's lifetime, so `stop()`/`removePrismLlamaCppModel` reattach to the SAME
	 * instance that holds the running child process instead of each tracking an untracked one).
	 * Optional only so tests can inject a fake without needing the full session stack; the fallback
	 * below (a fresh, uncached instance) is a test convenience, never the production path.
	 */
	getPrismLlamaCppRuntime?(): PrismLlamaCppRuntime;
	/**
	 * Seam for the pi-managed needle runtime (see needle-runtime.ts) — optional so tests can inject a
	 * fake, falling back to a fresh instance otherwise. Unlike `getPrismLlamaCppRuntime` above, needle
	 * has no session-caching need: every invocation is a one-shot `runCommand` call with no persistent
	 * child process to reattach to (needle-runtime.ts's `dispose()` is a documented no-op), so a fresh
	 * instance per call is functionally identical to a cached one — `runtimeDir()`/`modelsDir()`/
	 * `checkpointPath()` are pure path derivations from `agentDir`, not in-memory state.
	 */
	getNeedleRuntime?(): NeedleRuntime;
	showStatus(message: string): void;
	showError(message: string): void;
	showSelector(create: SelectorFactory): void;
}

function getPrismLlamaCppRuntime(host: LocalModelHost): PrismLlamaCppRuntime {
	return host.getPrismLlamaCppRuntime?.() ?? new PrismLlamaCppRuntime({ agentDir: getAgentDir() });
}

function getNeedleRuntime(host: LocalModelHost): NeedleRuntime {
	return host.getNeedleRuntime?.() ?? new NeedleRuntime({ agentDir: getAgentDir() });
}

/**
 * Mirrors needle-runtime.ts's own (module-private, not exported) NEEDLE_SMOKE_TOOLS — the default
 * tool set for `/models needle <query>` when no tools-json is supplied, so an ad-hoc probe has the
 * same sensible starting point the install pipeline's own smoke test already exercises. Kept in
 * sync manually since the source constant isn't exported from the frozen runtime module.
 */
const NEEDLE_DEFAULT_TOOLS = [
	{
		name: "get_weather",
		description: "Get current weather for a city.",
		parameters: { location: { type: "string", description: "City name.", required: true } },
	},
];

class ModelRouterThinkingSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentLevel: RouterThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: RouterThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingOptions: SelectItem[] = [
			{
				value: MODEL_ROUTER_THINKING_INHERIT_VALUE,
				label: MODEL_ROUTER_THINKING_INHERIT_LABEL,
				description: "Use current session default for this tier.",
			},
			...availableLevels.map((level) => ({
				value: level,
				label: level,
				description: THINKING_LEVEL_DESCRIPTIONS[level],
			})),
		];

		this.addChild(new DynamicBorder());

		this.selectList = new SelectList(
			thinkingOptions,
			thinkingOptions.length,
			getSelectListTheme(),
			MODEL_ROUTER_THINKING_SELECT_LIST_LAYOUT,
		);

		const index = thinkingOptions.findIndex((item) => item.value === currentLevel);
		if (index !== -1) {
			this.selectList.setSelectedIndex(index);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as RouterThinkingLevel);
		};
		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}
}
/**
 * /models — USER-invoked local model lifecycle (never a model-invokable tool):
 * list/add/remove/stop per local-model-lifecycle-design.md. Removal is explicit-only with
 * full disclosure; a pasted install command is parsed for its ref, never executed.
 */
export async function handleModelsCommand(host: LocalModelHost, argsText: string): Promise<void> {
	const [action = "list", ...rest] = argsText.split(/\s+/).filter(Boolean);
	try {
		if (action === "suggest" || action === "suggestions") {
			showModelSuggestionSelector(host);
			return;
		}
		if (action === "stop") {
			const stopped = host.localRuntime.stop();
			let stoppedTransformers = 0;
			for (const model of host.session.modelRegistry
				.getAll()
				.filter((entry) => entry.provider === HF_TRANSFORMERS_PROVIDER)) {
				const serverUrl = model.baseUrl.replace(/\/v1\/?$/, "");
				if (host.getTransformersRuntime(model.id, serverUrl).stop().stopped) stoppedTransformers++;
			}
			// Only touch the prism runtime when a pi-managed prism model is actually registered —
			// never construct/stop it on a session that never used one. isPiManagedPrismLlamaCppModel
			// is the SAME discriminator the readiness gate uses, so this never reaches for a user's own
			// hand-configured llama-cpp entry (e.g. the built-in llama-cpp/local catalog model).
			const hasPiManagedPrismModel = host.session.modelRegistry
				.getAll()
				.some((entry) => isPiManagedPrismLlamaCppModel(entry));
			const stoppedPrism = hasPiManagedPrismModel && getPrismLlamaCppRuntime(host).stop().stopped;
			const stoppedAny = stopped.stopped || stoppedTransformers > 0 || stoppedPrism;
			host.showStatus(
				stoppedAny
					? `Pi-managed local model server stopped${stoppedTransformers > 0 ? ` (${stoppedTransformers} Transformers sidecar(s))` : ""}${stoppedPrism ? " (prism llama.cpp server)" : ""}; models remain installed.`
					: "No pi-managed server running (a system server, if any, is not pi's to stop).",
			);
			return;
		}

		if (action === "import") {
			const imported = host.localRuntime.importUserModels();
			host.showStatus(
				`Imported Ollama models from ${imported.sourceDir} into pi-owned store ${imported.targetDir}: ` +
					`${imported.manifestsImported} manifest(s), ${imported.blobsHardlinked} blob(s) hardlinked, ` +
					`${imported.blobsCopied} blob(s) copied, ${imported.blobsSkipped + imported.manifestsSkipped} existing file(s) skipped.`,
			);
			return;
		}

		if (action === "needle") {
			if (rest.length === 0) {
				host.showStatus("Usage: /models needle <query> [tools-json]");
				host.showStatus(
					`  tools-json defaults to the smoke-test tool set: ${JSON.stringify(NEEDLE_DEFAULT_TOOLS)}`,
				);
				return;
			}
			await runNeedleQuery(host, rest);
			return;
		}

		if (action === "add") {
			const rawRef = rest.join(" ");
			if (!rawRef) {
				host.showStatus(
					"Usage: /models add <ollama-tag | hf.co/org/repo[:quant] | curated HF full-base ref | huggingface URL | pasted install command>",
				);
				host.showStatus("Or start from a validated suggestion: /models suggest");
				return;
			}
			const source = normalizeModelSource(rawRef);
			if (source.type === "rejected") {
				host.showStatus(`Not added: ${source.reason}`);
				return;
			}
			if (source.type === "api") {
				host.showStatus(
					`${source.ref} is an API model — nothing to install. Configure auth for the provider, then probe it with /fitness ${source.ref}.`,
				);
				return;
			}
			if (source.type === "transformers") {
				await addTransformersModel(host, source.modelId);
				return;
			}
			if (source.type === "prism-llamacpp") {
				const descriptor = PRISM_LLAMACPP_DESCRIPTORS[source.modelId];
				if (!descriptor) {
					host.showStatus(`${source.modelId} has no curated prism llama.cpp descriptor — this is a wiring bug.`);
					return;
				}
				await addPrismLlamaCppModel(host, descriptor);
				return;
			}
			if (source.type === "needle") {
				await addNeedleModel(host);
				return;
			}
			await addLocalModel(host, source.pullRef);
			return;
		}

		if (action === "remove") {
			const ref = rest[0];
			const confirmed = rest[1] === "confirm";
			if (!ref) {
				host.showStatus("Usage: /models remove <ref> confirm");
				return;
			}
			const source = normalizeModelSource(ref);
			if (source.type === "transformers") {
				await removeTransformersModel(host, source.modelId, confirmed);
				return;
			}
			if (source.type === "prism-llamacpp") {
				await removePrismLlamaCppModel(host, source.modelId, confirmed);
				return;
			}
			if (source.type === "needle") {
				await removeNeedleModel(host, confirmed);
				return;
			}
			await removeLocalModel(host, ref, confirmed);
			return;
		}

		await listLocalModels(host);
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

function formatOllamaStore(store: { kind: string; path: string; modelCount: number } | undefined): string {
	if (!store) return "unknown store (0 model(s))";
	return `${store.path} [${store.kind}, ${store.modelCount} model(s)]`;
}

export async function ensureLocalServer(host: LocalModelHost): Promise<boolean> {
	const status = await host.localRuntime.detect();
	if (status.serverUp) {
		if (status.activeStore?.kind === "pi-owned") return true;
		host.showStatus(
			`Ollama is already running on ${status.serverUrl} with store ${formatOllamaStore(status.activeStore)}; ` +
				`pi's canonical store is ${status.ownedModelsDir} (${status.ownedStore.modelCount} model(s)). ` +
				"Stop the other serve or run /models import before adding models.",
		);
		return false;
	}
	if (!status.binaryPath) {
		for (const line of host.localRuntime.installGuide()) host.showStatus(line);
		return false;
	}
	host.showStatus(
		`Starting local model server (${status.binarySource} binary, owned storage: ${status.ownedModelsDir})…`,
	);
	const started = await host.localRuntime.start();
	if (!started.started) {
		host.showStatus(`Could not start the local server: ${started.reason}`);
		return false;
	}
	return true;
}

export async function listLocalModels(host: LocalModelHost): Promise<void> {
	const status = await host.localRuntime.detect();
	const models = status.serverUp ? await host.localRuntime.list() : [];
	const ollamaLines = status.serverUp
		? [
				`Ollama models (active store: ${formatOllamaStore(status.activeStore)}; pi-owned store: ${status.ownedModelsDir} with ${status.ownedStore.modelCount} model(s)):`,
				...(models.length === 0
					? ["  (none installed — /models add <ref>, /models import, or /models suggest for a validated roster)"]
					: []),
			]
		: [
				"Ollama models:",
				...(status.binaryPath
					? [
							`  server not running (binary: ${status.binarySource}). /models add starts it on demand; /fitness probes registered models.`,
						]
					: host.localRuntime.installGuide().map((line) => `  ${line}`)),
			];
	const fitness = FitnessStore.forAgentDir(getAgentDir()).getForHost();
	const transformersModels = host.session.modelRegistry
		.getAll()
		.filter((model) => model.provider === HF_TRANSFORMERS_PROVIDER);
	const transformersLines = await Promise.all(
		transformersModels.map(async (model) => {
			const serverUrl = model.baseUrl.replace(/\/v1\/?$/, "");
			const runtime = host.getTransformersRuntime(model.id, serverUrl);
			const runtimeStatus = await runtime.detect();
			const report = fitness.find((entry) => entry.model === `${HF_TRANSFORMERS_PROVIDER}/${model.id}`);
			const readiness = runtimeStatus.serverUp
				? "server running"
				: runtimeStatus.runtimeInstalled
					? "runtime installed"
					: "runtime missing";
			const probe = report
				? `probed ${report.at.slice(0, 10)}: digest ${report.report.digest?.succeeded ?? "?"}/${report.report.digest?.total ?? "?"}, tool-calls ${report.report.toolCall.succeeded}/${report.report.toolCall.total}${report.report.tokensPerSecond ? `, ~${report.report.tokensPerSecond} tok/s` : ""}`
				: `unprobed — run /fitness ${HF_TRANSFORMERS_PROVIDER}/${model.id}`;
			return `  - ${model.id} (${readiness}, cache: ${runtimeStatus.cacheDir}) · ${probe}`;
		}),
	);
	const lines = [
		...ollamaLines,
		...models.map((model) => {
			const report = fitness.find((entry) => entry.model === `ollama/${model.name}`);
			const gb = (model.sizeBytes / 1e9).toFixed(2);
			const probe = report
				? `probed ${report.at.slice(0, 10)}: digest ${report.report.digest?.succeeded ?? "?"}/${report.report.digest?.total ?? "?"}, tool-calls ${report.report.toolCall.succeeded}/${report.report.toolCall.total}${report.report.tokensPerSecond ? `, ~${report.report.tokensPerSecond} tok/s` : ""}`
				: `unprobed — run /fitness ollama/${model.name}`;
			return `  - ${model.name} (${gb} GB) · ${probe}`;
		}),
		...(transformersLines.length > 0 ? ["Pi-managed Transformers models:", ...transformersLines] : []),
		"Commands: /models import · /models add <ref> · /models remove <ref> confirm · /models stop",
	];
	for (const line of lines) host.showStatus(line);
}

export async function addLocalModel(host: LocalModelHost, pullRef: string, preselectRole?: FitnessRole): Promise<void> {
	if (!(await ensureLocalServer(host))) return;
	host.showStatus(`Pulling ${pullRef}… (weights land in pi's owned Ollama store)`);
	let lastShown = 0;
	const pulled = await host.localRuntime.pull(pullRef, (progress) => {
		const now = Date.now();
		if (now - lastShown > 2000) {
			lastShown = now;
			host.showStatus(`  ${pullRef}: ${progress}`);
		}
	});
	if (!pulled.ok) {
		host.showStatus(`Pull failed: ${pulled.error}`);
		return;
	}
	const installed = await host.localRuntime.list().catch(() => []);
	const installedEntry = installed.find((entry) => matchesInstalledLocalModel(pullRef, entry.name));
	const shown = await host.localRuntime.show(pullRef);
	const sizing =
		installedEntry && shown.ok
			? deriveLocalContextSizing({
					host: { totalMemBytes: totalmem() },
					model: { modelInfo: shown.info.modelInfo, weightsBytes: installedEntry.sizeBytes },
					runtime: { supportsKvQuantization: true },
				})
			: undefined;
	let registeredRef = pullRef;
	if (sizing) {
		const sizedRef = sizedLocalModelRef(pullRef, sizing.numCtx);
		const created = await host.localRuntime.createFromModelfile({
			name: sizedRef,
			modelfile: renderOllamaContextModelfile({ from: pullRef, numCtx: sizing.numCtx }),
		});
		if (!created.ok) {
			host.showStatus(`Pulled, but could not create sized context model: ${created.error}`);
			return;
		}
		registeredRef = sizedRef;
	}
	const registration = registerLocalModel({
		agentDir: getAgentDir(),
		ref: registeredRef,
		baseUrl: host.localRuntime.baseUrl,
		contextWindow: sizing?.numCtx,
		servedContextWindow: sizing?.numCtx,
	});
	if (!registration.ok) {
		host.showStatus(`Pulled, but not auto-registered: ${registration.reason}`);
		if (registration.manualSnippet) {
			host.showStatus(`Add this to ${registration.modelsJsonPath} yourself:\n${registration.manualSnippet}`);
		}
		return;
	}
	host.session.modelRegistry.refresh();
	host.showStatus(`${pullRef} installed and registered as ollama/${registeredRef}. Probing fitness…`);
	await runFitnessAndAssign(host, `ollama/${registeredRef}`, preselectRole);
}

export async function addTransformersModel(
	host: LocalModelHost,
	modelId: string,
	preselectRole?: FitnessRole,
): Promise<void> {
	const runtime = host.getTransformersRuntime(modelId);
	let status = await runtime.detect();
	if (!status.runtimeInstalled) {
		host.showStatus(`Installing isolated Transformers runtime for ${modelId} at ${status.venvDir}…`);
		const installed = await runtime.installManaged((progress) => host.showStatus(`  transformers: ${progress}`));
		if (!installed.ok) {
			host.showStatus(`Transformers runtime install failed: ${installed.error}`);
			return;
		}
		status = await runtime.detect();
	}
	if (!status.runtimeInstalled) {
		host.showStatus(`Transformers runtime is still unavailable at ${status.venvDir}.`);
		return;
	}

	const downloaded = await runtime.downloadModel((progress) => host.showStatus(`  ${modelId}: ${progress}`));
	if (!downloaded.ok) {
		host.showStatus(`Model download failed: ${downloaded.error}`);
		return;
	}

	const started = await runtime.start();
	if (!started.started && started.reason !== "already_running") {
		host.showStatus(`Could not start Transformers sidecar: ${started.reason}`);
		return;
	}

	const registration = registerTransformersModel({
		agentDir: getAgentDir(),
		modelId,
		baseUrl: runtime.baseUrl,
	});
	if (!registration.ok) {
		host.showStatus(`Installed, but not auto-registered: ${registration.reason}`);
		if (registration.manualSnippet) {
			host.showStatus(`Add this to ${registration.modelsJsonPath} yourself:\n${registration.manualSnippet}`);
		}
		return;
	}
	host.session.modelRegistry.refresh();
	host.showStatus(
		`${modelId} installed in pi-managed Transformers and registered as ${HF_TRANSFORMERS_PROVIDER}/${modelId}. Probing fitness…`,
	);
	await runFitnessAndAssign(host, `${HF_TRANSFORMERS_PROVIDER}/${modelId}`, preselectRole);
}

/**
 * Zero-setup pipeline for a curated prism llama.cpp model (Bonsai-27B): install the pinned prism
 * llama.cpp runtime (prebuilt release download, no compiler needed), ensure both GGUF files and
 * start llama-server (see `ensurePrismModelFilesThenServe`), register the model, then probe
 * fitness. Mirrors addTransformersModel's shape — each stage checks its own `{ ok }`/
 * `{ runtimeInstalled }` result and stops with an honest status message on failure; nothing
 * continues past a failed stage.
 */
export async function addPrismLlamaCppModel(
	host: LocalModelHost,
	descriptor: PrismModelDescriptor,
	preselectRole?: FitnessRole,
): Promise<void> {
	const runtime = getPrismLlamaCppRuntime(host);
	const modelId = descriptor.repo;

	let status = await runtime.detect();
	if (!status.runtimeInstalled) {
		host.showStatus(`Installing prism llama.cpp runtime for ${descriptor.displayName} at ${runtime.runtimeDir()}…`);
		const installed = await runtime.installManaged((progress) => host.showStatus(`  prism-llamacpp: ${progress}`));
		if (!installed.ok) {
			host.showStatus(`Prism llama.cpp runtime install failed: ${installed.error}`);
			return;
		}
		status = await runtime.detect();
	}
	if (!status.runtimeInstalled) {
		host.showStatus(`Prism llama.cpp runtime is still unavailable at ${runtime.runtimeDir()}.`);
		return;
	}

	const numCtx = derivePrismLlamaCppNumCtx(totalmem());
	const served = await ensurePrismModelFilesThenServe(
		runtime,
		descriptor,
		{ port: PRISM_LLAMACPP_SERVE_PORT, numCtx },
		(message) => host.showStatus(message),
	);
	if (!served.ok) {
		const label =
			served.stage === "model-download"
				? "Model download failed"
				: served.stage === "mmproj-download"
					? "Vision projector download failed"
					: "Could not start llama-server";
		host.showStatus(`${label}: ${served.error}`);
		return;
	}

	const registration = registerPrismLlamaCppModel({
		agentDir: getAgentDir(),
		modelId,
		baseUrl: served.baseUrl,
		contextWindow: numCtx,
		servedContextWindow: numCtx,
	});
	if (!registration.ok) {
		host.showStatus(`Served, but not auto-registered: ${registration.reason}`);
		if (registration.manualSnippet) {
			host.showStatus(`Add this to ${registration.modelsJsonPath} yourself:\n${registration.manualSnippet}`);
		}
		return;
	}
	host.session.modelRegistry.refresh();
	host.showStatus(
		`${descriptor.displayName} installed and registered as ${PRISM_LLAMACPP_PROVIDER}/${modelId}. Probing fitness…`,
	);
	await runFitnessAndAssign(host, `${PRISM_LLAMACPP_PROVIDER}/${modelId}`, preselectRole);
}

export async function removeLocalModel(host: LocalModelHost, ref: string, confirmed: boolean): Promise<void> {
	const status = await host.localRuntime.detect();
	if (!status.serverUp) {
		host.showStatus("Local server not running — start it (any /models action) before removing.");
		return;
	}
	const models = await host.localRuntime.list();
	const target = models.find((model) => matchesInstalledLocalModel(ref, model.name));
	if (!target) {
		host.showStatus(
			`${ref} is not installed. Installed: ${models.map((model) => model.name).join(", ") || "(none)"}`,
		);
		return;
	}
	if (!confirmed) {
		// EXPLICIT USER ACTION ONLY: full disclosure, then require the confirm token.
		const gb = (target.sizeBytes / 1e9).toFixed(2);
		host.showStatus(
			[
				`Removing ${ref} will delete:`,
				`  - model weights (${gb} GB) from ${status.managedByPi ? status.ownedModelsDir : "the system server's storage"}`,
				`  - the ollama/${ref} entry in models.json`,
				`  - its cached fitness report for this host`,
				`Run: /models remove ${ref} confirm`,
			].join("\n"),
		);
		return;
	}
	const removed = await host.localRuntime.remove(ref);
	if (!removed.ok) {
		host.showStatus(`Remove failed: ${removed.error}`);
		return;
	}
	unregisterLocalModel({ agentDir: getAgentDir(), ref });
	FitnessStore.forAgentDir(getAgentDir()).remove(`ollama/${ref}`);
	host.session.modelRegistry.refresh();
	host.showStatus(`${ref} removed: weights deleted, registration and fitness report dropped.`);
}

async function removeTransformersModel(host: LocalModelHost, modelId: string, confirmed: boolean): Promise<void> {
	const runtime = host.getTransformersRuntime(modelId);
	const status = await runtime.detect();
	if (!confirmed) {
		host.showStatus(
			[
				`Removing ${modelId} will delete:`,
				`  - the ${HF_TRANSFORMERS_PROVIDER}/${modelId} entry in models.json`,
				`  - its cached fitness report for this host`,
				`It will stop this session's Transformers sidecar if running. Cached weights remain under ${status.cacheDir}.`,
				`Run: /models remove hf.co/${modelId} confirm`,
			].join("\n"),
		);
		return;
	}
	runtime.stop();
	const registration = unregisterTransformersModel({ agentDir: getAgentDir(), modelId });
	if (!registration.ok) {
		host.showStatus(`Remove failed: ${registration.reason}`);
		return;
	}
	FitnessStore.forAgentDir(getAgentDir()).remove(`${HF_TRANSFORMERS_PROVIDER}/${modelId}`);
	host.session.modelRegistry.refresh();
	host.showStatus(
		`${modelId} registration and fitness report dropped; cached weights remain under ${status.cacheDir}.`,
	);
}

/**
 * Drop a pi-managed prism llama.cpp model's registration and fitness report. Production supplies a
 * session-cached runtime (see `LocalModelHost.getPrismLlamaCppRuntime`'s doc comment), the SAME
 * instance the readiness gate uses, so `stop()` here reliably reaches the tracked child whenever
 * THIS session is the one that started it — including a server started earlier in the session by
 * the readiness gate itself, not just by a prior `/models add`. Only a server started by a
 * DIFFERENT process/session (pi restarted, a different terminal) is out of reach; the status text
 * only carries that caveat, not a blanket "may not stop" disclaimer.
 */
async function removePrismLlamaCppModel(host: LocalModelHost, modelId: string, confirmed: boolean): Promise<void> {
	const runtime = getPrismLlamaCppRuntime(host);
	if (!confirmed) {
		host.showStatus(
			[
				`Removing ${modelId} will delete:`,
				`  - the ${PRISM_LLAMACPP_PROVIDER}/${modelId} entry in models.json`,
				`  - its cached fitness report for this host`,
				`Downloaded GGUF weights remain under ${runtime.modelsDir()}. Its llama-server will be stopped if ` +
					`this session started it; if it was started by a different pi process or session, it will keep ` +
					`serving on 127.0.0.1:${PRISM_LLAMACPP_SERVE_PORT} until stopped manually.`,
				`Run: /models remove hf.co/${modelId} confirm`,
			].join("\n"),
		);
		return;
	}
	const stopped = runtime.stop();
	const registration = unregisterPrismLlamaCppModel({ agentDir: getAgentDir(), modelId });
	if (!registration.ok) {
		host.showStatus(`Remove failed: ${registration.reason}`);
		return;
	}
	FitnessStore.forAgentDir(getAgentDir()).remove(`${PRISM_LLAMACPP_PROVIDER}/${modelId}`);
	host.session.modelRegistry.refresh();
	host.showStatus(
		`${modelId} registration and fitness report dropped; downloaded weights remain under ${runtime.modelsDir()}.` +
			(stopped.stopped
				? " Its llama-server was stopped."
				: ` No llama-server tracked by this session — if one is still running (started by a different pi process or session), stop it manually on port ${PRISM_LLAMACPP_SERVE_PORT}.`),
	);
}

/**
 * Zero-setup pipeline for needle (see needle-runtime.ts): a standalone 26M-parameter function-call
 * test bench, NOT a chat/executor/lane model — no OpenAI-compatible endpoint, no models.json
 * registration, no /fitness probe. Install the pinned needle clone+venv (menu pick = consent, same
 * doctrine as the Transformers/prism precedents), download and sha256-verify the pickle checkpoint
 * (never called implicitly by installManaged — see the module's SECURITY note: the checkpoint is a
 * pickle file, arbitrary code execution on load by construction, so this is deliberately a separate
 * consent-adjacent step, not folded into install), then run its own smoke test as the honest
 * post-install verification. Each stage checks its own `{ ok }` result and stops with a stage-tagged
 * status on failure; nothing continues past a failed stage.
 */
export async function addNeedleModel(host: LocalModelHost): Promise<void> {
	const runtime = getNeedleRuntime(host);

	let status = await runtime.detect();
	if (!status.installed) {
		host.showStatus(`Installing needle (function-call test bench) at ${runtime.runtimeDir()}…`);
		const installed = await runtime.installManaged((progress) => host.showStatus(`  needle: ${progress}`));
		if (!installed.ok) {
			host.showStatus(`needle install failed: ${installed.error}`);
			return;
		}
		status = await runtime.detect();
	}
	if (!status.installed) {
		host.showStatus(`needle is still unavailable at ${runtime.runtimeDir()}.`);
		return;
	}

	const downloaded = await runtime.downloadWeights((progress) => host.showStatus(`  ${progress}`));
	if (!downloaded.ok) {
		host.showStatus(`needle weights download failed: ${downloaded.error}`);
		return;
	}

	host.showStatus("Running needle smoke test (function-call probe)…");
	const smoke = await runtime.smokeTest();
	if (!smoke.ok || !smoke.call) {
		host.showStatus(
			`needle smoke test failed: ${smoke.error ?? "smoke test reported success but returned no parsed call"}`,
		);
		return;
	}
	host.showStatus(
		`needle installed and verified: smoke test called ${smoke.call.name}(${JSON.stringify(smoke.call.arguments)}) ` +
			`in ${smoke.latencyMs}ms. Use /models needle <query> [tools-json] to test it further — it is a standalone ` +
			"bench, not a chat/executor lane.",
	);
}

/**
 * Wipe pi's needle runtime (clone+venv) and downloaded checkpoint. Unlike the other /models remove
 * flows, there is no models.json entry or fitness report to drop (needle never registers as a model
 * — see the roster entry's rationale) and no server process to stop (every needle invocation is a
 * one-shot runCommand call — see needle-runtime.ts's `dispose()` doc comment); removal is purely
 * deleting the two pi-owned directories. needle-runtime.ts exposes no delete method of its own (its
 * public surface is detect/installManaged/downloadWeights/runFunctionCall/smokeTest/dispose), so
 * this deletes directly via the runtime's own path-derivation methods.
 */
async function removeNeedleModel(host: LocalModelHost, confirmed: boolean): Promise<void> {
	const runtime = getNeedleRuntime(host);
	const runtimeDir = runtime.runtimeDir();
	const modelsDir = runtime.modelsDir();
	if (!confirmed) {
		host.showStatus(
			[
				"Removing needle will delete:",
				`  - the pi-managed needle runtime (clone + venv) at ${runtimeDir}`,
				`  - the downloaded checkpoint at ${runtime.checkpointPath()}`,
				"needle has no models.json entry or fitness report — it is a standalone function-call test bench, " +
					"never registered as a chat/lane model.",
				"Run: /models remove hf.co/Cactus-Compute/needle confirm",
			].join("\n"),
		);
		return;
	}
	if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true });
	if (existsSync(modelsDir)) rmSync(modelsDir, { recursive: true, force: true });
	host.showStatus(`needle removed: deleted ${runtimeDir} and ${modelsDir}.`);
}

/**
 * `/models needle <query> [tools-json]` — the actual test surface for needle (see the roster
 * entry's rationale: there is no chat lane to probe it through). `tools-json`, when present, must be
 * the LAST whitespace-split token and start with `[`/`{` (compact JSON, no embedded spaces) —
 * anything else is treated as part of the query and the default smoke-test tool set is used. A fast
 * `detect()`-based pre-check gives friendly install guidance without spawning a doomed process;
 * `runFunctionCall`'s own not-installed/checkpoint-missing pre-flight is still the final honest
 * backstop if state changes between the check and the call.
 */
async function runNeedleQuery(host: LocalModelHost, args: string[]): Promise<void> {
	if (args.length === 0) {
		host.showStatus("Usage: /models needle <query> [tools-json]");
		return;
	}

	const runtime = getNeedleRuntime(host);
	const status = await runtime.detect();
	if (!status.installed) {
		host.showStatus(
			"needle is not installed. Run /models add hf.co/Cactus-Compute/needle first (or /models suggest).",
		);
		return;
	}
	if (!status.checkpointPresent) {
		host.showStatus(
			"needle is installed but its checkpoint hasn't been downloaded. Run /models add hf.co/Cactus-Compute/needle to fetch and verify it.",
		);
		return;
	}

	let tools: unknown = NEEDLE_DEFAULT_TOOLS;
	let toolsJsonParsed = false;
	const last = args[args.length - 1];
	if (last && (last.startsWith("[") || last.startsWith("{"))) {
		try {
			tools = JSON.parse(last);
			toolsJsonParsed = true;
		} catch {
			// Not valid JSON — treat the whole thing as the query, keep the default tools.
		}
	}
	const query = (toolsJsonParsed ? args.slice(0, -1) : args).join(" ");
	if (!query.trim()) {
		host.showStatus("Usage: /models needle <query> [tools-json]");
		return;
	}

	host.showStatus(`needle: running "${query}"…`);
	const startedAt = Date.now();
	const result = await runtime.runFunctionCall({ query, tools });
	const latencyMs = Date.now() - startedAt;
	if (!result.ok) {
		host.showStatus(`needle call failed (${latencyMs}ms): ${result.error}\nraw output:\n${result.rawOutput}`);
		return;
	}
	host.showStatus(`needle (${latencyMs}ms): ${result.call.name}(${JSON.stringify(result.call.arguments)})`);
}

/** /fitness with no args: pick a model from the configured registry, probe it, assign a role. */
/** Pick a validated suggestion → install it → probe on this host → land its shaped role. */
export function showModelSuggestionSelector(host: LocalModelHost): void {
	host.showSelector((done) => {
		const selector = new ModelSuggestionSelectorComponent(
			DEFAULT_MODEL_SUGGESTIONS,
			async (suggestion) => {
				done();
				// The shaped role rides along so the post-probe selector lands on it pre-selected;
				// non-tool-callers carry curator/judge/none, never executor, so this can't footgun.
				const source = normalizeModelSource(suggestion.pullRef);
				if (source.type === "transformers") {
					await addTransformersModel(host, source.modelId, suggestion.assignRole);
					return;
				}
				if (source.type === "prism-llamacpp") {
					const descriptor = PRISM_LLAMACPP_DESCRIPTORS[source.modelId];
					if (!descriptor) {
						host.showStatus(
							`Suggestion ${suggestion.name} maps to an unknown curated prism model "${source.modelId}" — wiring bug.`,
						);
						return;
					}
					await addPrismLlamaCppModel(host, descriptor, suggestion.assignRole);
					return;
				}
				if (source.type === "needle") {
					await addNeedleModel(host);
					return;
				}
				if (source.type === "local") {
					await addLocalModel(host, source.pullRef, suggestion.assignRole);
					return;
				}
				host.showStatus(
					`Suggestion ${suggestion.name} is not installable: ${source.type === "rejected" ? source.reason : source.ref}`,
				);
			},
			() => {
				done();
				host.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}

export function showFitnessModelSelector(host: LocalModelHost): void {
	host.showSelector((done) => {
		const selector = new ModelSelectorComponent(
			host.ui,
			host.session.model,
			host.settingsManager,
			host.session.modelRegistry,
			host.session.scopedModels,
			async (model) => {
				done();
				await runFitnessAndAssign(host, `${model.provider}/${model.id}`);
			},
			() => {
				done();
				host.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}

/** Resolve the routed model's supported thinking levels for a fitness-assignment flow, with a safe fallback. */
function getModelThinkingLevels(modelRegistry: ModelRegistry | undefined, modelRef: string): ThinkingLevel[] {
	if (!modelRegistry) {
		return [...MODEL_ROUTER_THINKING_FALLBACK_LEVELS];
	}
	const resolved = resolveCliModel({ cliModel: modelRef, modelRegistry });
	if (!resolved.model) {
		return [...MODEL_ROUTER_THINKING_FALLBACK_LEVELS];
	}
	return getSupportedThinkingLevels(resolved.model);
}

function getModelRouterThinkingField(role: FitnessRole): ModelRouterThinkingField | undefined {
	if (role === "router-cheap") {
		return "cheapThinking";
	}
	if (role === "router-medium") {
		return "mediumThinking";
	}
	if (role === "router-expensive") {
		return "expensiveThinking";
	}
	if (role === "executor") {
		return "executorThinking";
	}
	if (role === "judge") {
		return "judgeThinking";
	}
	return undefined;
}

function promptForModelRouterThinking(host: RunFitnessHost, modelRef: string, role: FitnessRole): void {
	const thinkingField = getModelRouterThinkingField(role);
	if (!thinkingField) {
		return;
	}

	const modelRegistry = host.session.modelRegistry;
	const availableLevels = getModelThinkingLevels(modelRegistry, modelRef);
	const settings = host.settingsManager.getModelRouterSettings();
	const configuredThinking = settings[thinkingField];
	const currentThinking =
		configuredThinking && availableLevels.includes(configuredThinking)
			? configuredThinking
			: MODEL_ROUTER_THINKING_INHERIT_VALUE;

	host.showSelector((done) => {
		const selector = new ModelRouterThinkingSelectorComponent(
			currentThinking,
			availableLevels,
			(level) => {
				done();
				host.settingsManager.setModelRouterSettings({
					...settings,
					[thinkingField]: level === MODEL_ROUTER_THINKING_INHERIT_VALUE ? undefined : level,
				});
			},
			() => {
				done();
				host.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}

/** Probe a model's fitness, show the report, then offer one-step role assignment. When the model
 * came from a validated suggestion, `preselectRole` lands its shaped role already highlighted. */
export async function runFitnessAndAssign(
	host: RunFitnessHost,
	modelRef: string,
	preselectRole?: FitnessRole,
): Promise<void> {
	host.showStatus(`Model fitness probe running on ${modelRef}… (6 surfaces; local models may take a few minutes)`);
	try {
		const outcome = await host.session.runModelFitness({ model: modelRef });
		if (!outcome.started) {
			host.showStatus(`Model fitness skipped: ${outcome.skipReason}`);
			return;
		}
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(new Text(formatModelFitnessReport(outcome.model, outcome.report), 1, 0));
		host.ui.requestRender();
		// Validate-before-load: zero successes on every probed surface means the model cannot
		// drive any of the harness's subagent contracts on this host — refuse adoption instead
		// of landing a role selector the user might reflexively confirm (this is the reported
		// bug: a 0/3-everywhere model still got set as judge model and saved to Model Router).
		if (isProbeAllFailed(outcome.report)) {
			host.showStatus(
				`${outcome.model} failed the fitness probe on all surfaces — not configured. Use /model to set it manually if you accept the risk.`,
			);
			return;
		}
		host.showSelector((done) => {
			const selector = new FitnessRoleSelectorComponent(
				outcome.model,
				(role) => {
					done();
					if (role === "scout") {
						const verdict = evaluateSurfaceFitness("scout_auto", outcome.report);
						if (!verdict.fit) {
							const reason = verdict.reason === "lane_failed" ? `failed ${verdict.lane}` : "was not probed";
							host.showStatus(
								`${outcome.model} not assigned as scout: ${reason} on the scout_auto fitness exam. Use the docs/scout.md Modelfile recipe, then rerun /fitness.`,
							);
							return;
						}
					}
					assignFitnessRole(host, outcome.model, role);
					promptForModelRouterThinking(host, outcome.model, role);
				},
				() => {
					done();
					host.ui.requestRender();
				},
				preselectRole,
			);
			return { component: selector, focus: selector };
		});
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

/** Persist a role assignment from the post-probe selector into the matching settings. */
export function assignFitnessRole(host: AssignRoleHost, modelRef: string, role: FitnessRole): void {
	if (role === "none") {
		host.showStatus(`Fitness result for ${modelRef} saved. Assign a role later from /settings.`);
		return;
	}
	if (role === "curator") {
		const current = host.settingsManager.getContextCurationSettings();
		host.settingsManager.setContextCurationSettings({ ...current, enabled: true, model: modelRef });
		host.showStatus(`Context curation enabled with ${modelRef} as the curator.`);
		return;
	}
	if (role === "executor") {
		const router = host.settingsManager.getModelRouterSettings();
		host.settingsManager.setModelRouterSettings({ ...router, executorModel: modelRef });
		const hint = router.enabled ? "" : " Model router is currently disabled — enable it in /settings → Model Router.";
		host.showStatus(`${modelRef} set as the toolkit executor (direct Level-0 hits route to it).${hint}`);
		return;
	}
	if (role === "scout") {
		host.settingsManager.setScoutSettings({ enabled: true, model: modelRef });
		host.showStatus(`${modelRef} set as the repository scout (context_scout enabled).`);
		return;
	}
	const router = host.settingsManager.getModelRouterSettings();
	const field =
		role === "router-cheap"
			? "cheapModel"
			: role === "router-medium"
				? "mediumModel"
				: role === "router-expensive"
					? "expensiveModel"
					: role === "judge"
						? "judgeModel"
						: "learningModel";
	host.settingsManager.setModelRouterSettings({ ...router, [field]: modelRef });
	const hint = router.enabled ? "" : " Model router is currently disabled — enable it in /settings → Model Router.";
	host.showStatus(`${modelRef} set as ${role.replace("router-", "router ")} model.${hint}`);
}

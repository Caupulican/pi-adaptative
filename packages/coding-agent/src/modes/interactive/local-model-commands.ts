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

import { existsSync, rmSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai";
import type { Api, Model } from "@caupulican/pi-ai/types";
import type { Component, Container, TUI } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
	HmoeWeights,
} from "../../core/expert-routing/vocabulary.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { evaluateSurfaceFitness } from "../../core/model-router/fitness-gate.ts";
import { DEFAULT_MODEL_SUGGESTIONS } from "../../core/models/default-model-suggestions.ts";
import type { FitnessRole } from "../../core/models/fitness-role.ts";
import { FitnessStore } from "../../core/models/fitness-store.ts";
import { toolExecutionFailure } from "../../core/models/fitness-tool-gate.ts";
import { PrismLlamaCppRuntime, type PrismModelDescriptor } from "../../core/models/llamacpp-runtime.ts";
import {
	HF_TRANSFORMERS_PROVIDER,
	PRISM_LLAMACPP_PROVIDER,
	registerPrismLlamaCppModel,
	registerTransformersModel,
	unregisterLocalModel,
	unregisterPrismLlamaCppModel,
	unregisterTransformersModel,
} from "../../core/models/local-registration.ts";
import type { OllamaRuntime, TransformersRuntime } from "../../core/models/local-runtime.ts";
import { matchesInstalledLocalModel, normalizeModelSource } from "../../core/models/model-ref.ts";
import { NeedleRuntime } from "../../core/models/needle-runtime.ts";
import { installOllamaModel } from "../../core/models/ollama-model-installation.ts";
import {
	derivePrismLlamaCppNumCtx,
	ensurePrismModelFilesThenServe,
	isPiManagedPrismLlamaCppModel,
	PRISM_LLAMACPP_DESCRIPTORS,
	PRISM_LLAMACPP_SERVE_PORT,
} from "../../core/models/prism-llamacpp-lifecycle.ts";
import { isProbeAllFailed } from "../../core/research/model-fitness.ts";
import type {
	ContextCurationSettings,
	ModelFavorite,
	ModelRouterPoolPreference,
	ModelRouterSelectionMode,
	ModelRouterSettings,
	ScoutSettings,
	SettingsScope,
} from "../../core/settings/settings-schema.ts";
import type { ToolProbeResult } from "../../core/tool-protocol-controller.ts";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { ThinkingLevel } from "../../kernel/index.ts";
import { plainLabel } from "../../presentation/plain-text.ts";
import { FitnessRoleSelectorComponent } from "./components/fitness-role-selector.ts";
import {
	MODEL_ROUTER_THINKING_INHERIT_VALUE,
	ModelRouterThinkingSelectorComponent,
} from "./components/model-router-thinking-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ModelSuggestionSelectorComponent } from "./components/model-suggestion-selector.ts";
import { formatOllamaStore, probeReport, removalDisclosure, reportRefusedRegistration } from "./local-model-notices.ts";
import { presentModelFitnessOutcome } from "./model-fitness-presentation.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface LocalModelCommandsSettingsSource {
	getContextCurationSettings(): { enabled: boolean; model?: string; maxJobsPerTurn: number };
	getModelFavorites(): ModelFavorite[];
	getModelRouterSettings(): {
		enabled: boolean;
		selectionMode: ModelRouterSelectionMode;
		poolPreference: ModelRouterPoolPreference;
		cheapModel?: string;
		mediumModel?: string;
		expensiveModel?: string;
		learningModel?: string;
		executorModel?: string;
		fitnessGate: boolean;
		cheapThinking?: ThinkingLevel;
		mediumThinking?: ThinkingLevel;
		expensiveThinking?: ThinkingLevel;
		executorThinking?: ThinkingLevel;
		hmoePreset?: HmoePreset;
		hmoeTeamStrategy?: HmoeTeamStrategy;
		hmoeIndependence?: HmoeIndependence;
		hmoePreference?: HmoePreference;
		hmoeWeights?: HmoeWeights;
	};
	setContextCurationSettings(settings: ContextCurationSettings, scope?: SettingsScope): void;
	setLocalRuntimeEnabled(
		runtime: "ollama" | "llamacpp" | "transformers",
		enabled: boolean,
		scope?: SettingsScope,
	): void;
	setModelRouterSettings(settings: ModelRouterSettings, scope?: SettingsScope): void;
	setScoutSettings(settings: ScoutSettings, scope?: SettingsScope): void;
	toggleModelFavorite(provider: string, modelId: string): void;
}

/** The model registry members this module uses, declared by the module itself; the composition root passes the ModelRegistry. */
export interface LocalModelCommandsModelSource {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
	refresh(): void;
}

type SelectorFactory = (done: () => void) => { component: Component; focus: Component };

const MODEL_ROUTER_THINKING_FALLBACK_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

type ModelRouterThinkingField = "cheapThinking" | "mediumThinking" | "expensiveThinking" | "executorThinking";

/** Narrow seam for persisting a probed model's role — matches the fitness-role test. */
export interface AssignRoleHost {
	readonly settingsManager: LocalModelCommandsSettingsSource;
	showStatus(message: string): void;
}

/** Seam for the fitness probe + role-selector flow — matches the fitness-probe-gate test. */
export interface RunFitnessHost {
	readonly session: Pick<AgentSession, "probeToolCalling" | "runModelFitness">;
	readonly modelRegistry?: LocalModelCommandsModelSource;
	readonly settingsManager: LocalModelCommandsSettingsSource;
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
	readonly modelRegistry: ModelRegistry;
	readonly settingsManager: LocalModelCommandsSettingsSource;
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

/**
 * /models — USER-invoked local model lifecycle (never a model-invokable tool):
 * list/add/remove/stop per local-model-lifecycle-design.md. Removal is explicit-only with
 * full disclosure; a pasted install command is parsed for its ref, never executed.
 */
export async function handleModelsCommand(host: LocalModelHost, argsText: string): Promise<void> {
	const words = interfaceText().localModels.models;
	const [action = "list", ...rest] = argsText.split(/\s+/).filter(Boolean);
	try {
		if (action === "suggest" || action === "suggestions") {
			showModelSuggestionSelector(host);
			return;
		}
		if (action === "stop") {
			const stopped = host.localRuntime.stop();
			let stoppedTransformers = 0;
			for (const model of host.modelRegistry
				.getAll()
				.filter((entry) => entry.provider === HF_TRANSFORMERS_PROVIDER)) {
				const serverUrl = model.baseUrl.replace(/\/v1\/?$/, "");
				if (host.getTransformersRuntime(model.id, serverUrl).stop().stopped) stoppedTransformers++;
			}
			// Only touch the prism runtime when a pi-managed prism model is actually registered —
			// never construct/stop it on a session that never used one. isPiManagedPrismLlamaCppModel
			// is the SAME discriminator the readiness gate uses, so this never reaches for a user's own
			// hand-configured llama-cpp entry (e.g. the built-in llama-cpp/local catalog model).
			const hasPiManagedPrismModel = host.modelRegistry
				.getAll()
				.some((entry) => isPiManagedPrismLlamaCppModel(entry));
			const stoppedPrism = hasPiManagedPrismModel && getPrismLlamaCppRuntime(host).stop().stopped;
			const stoppedAny = stopped.stopped || stoppedTransformers > 0 || stoppedPrism;
			host.showStatus(stoppedAny ? words.stopStopped(stoppedTransformers, stoppedPrism) : words.stopNone);
			return;
		}

		if (action === "import") {
			const imported = host.localRuntime.importUserModels();
			host.showStatus(
				words.imported({
					sourceDir: imported.sourceDir,
					targetDir: imported.targetDir,
					manifests: imported.manifestsImported,
					hardlinked: imported.blobsHardlinked,
					copied: imported.blobsCopied,
					skipped: imported.blobsSkipped + imported.manifestsSkipped,
				}),
			);
			return;
		}

		if (action === "needle") {
			if (rest.length === 0) {
				host.showStatus(words.needleUsage);
				host.showStatus(words.needleToolsHint);
				return;
			}
			await runNeedleQuery(host, rest);
			return;
		}

		if (action === "add") {
			const rawRef = rest.join(" ");
			if (!rawRef) {
				host.showStatus(words.addUsage);
				host.showStatus(words.addSuggestHint);
				return;
			}
			const source = normalizeModelSource(rawRef);
			if (source.type === "rejected") {
				host.showStatus(words.notAdded(source.reason));
				return;
			}
			if (source.type === "api") {
				host.showStatus(words.apiModel(source.ref));
				return;
			}
			if (source.type === "transformers") {
				await addTransformersModel(host, source.modelId);
				return;
			}
			if (source.type === "prism-llamacpp") {
				const descriptor = PRISM_LLAMACPP_DESCRIPTORS[source.modelId];
				if (!descriptor) {
					host.showStatus(words.descriptorMissing(source.modelId));
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

		async function handleRemovalAction(
			actionName: string,
			restArgs: string[],
			h: LocalModelHost,
			transformersOp: (host: LocalModelHost, id: string, confirmed: boolean) => Promise<void>,
			prismOp: (host: LocalModelHost, id: string, confirmed: boolean) => Promise<void>,
			needleOp: (host: LocalModelHost, confirmed: boolean) => Promise<void>,
			localOp: (host: LocalModelHost, ref: string, confirmed: boolean) => Promise<void>,
		) {
			const ref = restArgs[0];
			const confirmed = restArgs[1] === "confirm";
			if (!ref) {
				h.showStatus(words.removalUsage(actionName));
				return;
			}
			const source = normalizeModelSource(ref);
			if (source.type === "transformers") {
				await transformersOp(h, source.modelId, confirmed);
			} else if (source.type === "prism-llamacpp") {
				await prismOp(h, source.modelId, confirmed);
			} else if (source.type === "needle") {
				await needleOp(h, confirmed);
			} else {
				await localOp(h, ref, confirmed);
			}
		}

		if (action === "remove" || action === "unregister") {
			await handleRemovalAction(
				action,
				rest,
				host,
				removeTransformersModel,
				removePrismLlamaCppModel,
				removeNeedleModel,
				removeLocalModel,
			);
			return;
		}

		if (action === "uninstall" || action === "purge") {
			const ref = rest[0];
			const confirmed = rest[1] === "confirm";
			if (!ref) {
				host.showStatus(words.removalUsage(action));
				return;
			}
			const source = normalizeModelSource(ref);
			if (source.type === "transformers") {
				await uninstallTransformersModel(host, source.modelId, confirmed);
				return;
			}
			if (source.type === "prism-llamacpp") {
				await uninstallPrismLlamaCppModel(host, source.modelId, confirmed);
				return;
			}
			if (source.type === "needle") {
				await removeNeedleModel(host, confirmed);
				return;
			}
			await removeLocalModel(host, ref, confirmed);
			return;
		}

		if (action === "uninstall-runtime") {
			const runtime = rest[0];
			const confirmed = rest[1] === "confirm";
			if (!runtime) {
				host.showStatus(words.uninstallRuntimeUsage);
				return;
			}
			await uninstallRuntime(host, runtime, confirmed);
			return;
		}

		if (action === "enable" || action === "disable") {
			const runtime = rest[0];
			if (runtime !== "ollama" && runtime !== "llamacpp" && runtime !== "transformers") {
				host.showStatus(words.enableUsage(action));
				return;
			}
			host.settingsManager.setLocalRuntimeEnabled(runtime, action === "enable");
			host.showStatus(words.runtimeEnabled(runtime, action === "enable"));
			return;
		}

		await listLocalModels(host);
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

export async function ensureLocalServer(host: LocalModelHost): Promise<boolean> {
	const words = interfaceText().localModels.models;
	const status = await host.localRuntime.detect();
	if (status.serverUp) {
		if (status.managedByPi && status.activeStore?.kind === "pi-owned") return true;
		host.showStatus(words.serverAlreadyRunning(status.serverUrl));
		return false;
	}
	if (!status.binaryPath) {
		for (const line of host.localRuntime.installGuide()) host.showStatus(line);
		return false;
	}
	host.showStatus(words.startingServer(String(status.binarySource), String(status.ownedModelsDir)));
	const started = await host.localRuntime.start();
	if (!started.started) {
		harnessLog.debug("ui", "the local server did not start", { reason: started.reason });
		host.showStatus(words.startFailed(plainLabel(String(started.reason))));
		return false;
	}
	return true;
}

export async function listLocalModels(host: LocalModelHost): Promise<void> {
	const words = interfaceText().localModels.models;
	const status = await host.localRuntime.detect();
	const models = status.serverUp ? await host.localRuntime.list() : [];
	const ollamaLines = status.serverUp
		? [
				words.listHeader(
					formatOllamaStore(status.activeStore),
					status.ownedModelsDir,
					status.ownedStore.modelCount,
				),
				...(models.length === 0 ? [words.listNone] : []),
			]
		: [
				words.listHeaderDown,
				...(status.binaryPath
					? [words.listServerDown(String(status.binarySource))]
					: host.localRuntime.installGuide().map((line) => `  ${line}`)),
			];
	const fitness = FitnessStore.forAgentDir(getAgentDir()).getForHost();
	const transformersModels = host.modelRegistry
		.getAll()
		.filter((model) => model.provider === HF_TRANSFORMERS_PROVIDER);
	const transformersLines = await Promise.all(
		transformersModels.map(async (model) => {
			const serverUrl = model.baseUrl.replace(/\/v1\/?$/, "");
			const runtime = host.getTransformersRuntime(model.id, serverUrl);
			const runtimeStatus = await runtime.detect();
			const report = fitness.find((entry) => entry.model === `${HF_TRANSFORMERS_PROVIDER}/${model.id}`);
			const readiness = runtimeStatus.serverUp
				? words.readinessRunning
				: runtimeStatus.runtimeInstalled
					? words.readinessInstalled
					: words.readinessMissing;
			const probe = report
				? words.probed(probeReport(report))
				: words.unprobed(`${HF_TRANSFORMERS_PROVIDER}/${model.id}`);
			return words.transformersRow(model.id, readiness, runtimeStatus.cacheDir, probe);
		}),
	);
	const lines = [
		...ollamaLines,
		...models.map((model) => {
			const report = fitness.find((entry) => entry.model === `ollama/${model.name}`);
			const gb = (model.sizeBytes / 1e9).toFixed(2);
			const probe = report ? words.probed(probeReport(report)) : words.unprobed(`ollama/${model.name}`);
			return words.ollamaRow(model.name, gb, probe);
		}),
		...(transformersLines.length > 0 ? [words.transformersHeader, ...transformersLines] : []),
		words.listCommands,
	];
	for (const line of lines) host.showStatus(line);
}

export async function addLocalModel(host: LocalModelHost, pullRef: string, preselectRole?: FitnessRole): Promise<void> {
	const words = interfaceText().localModels.models;
	if (!(await ensureLocalServer(host))) return;
	host.showStatus(words.pulling(pullRef));
	let lastShown = 0;
	const result = await installOllamaModel({
		runtime: host.localRuntime,
		agentDir: getAgentDir(),
		sourceRef: pullRef,
		onProgress: (progress) => {
			const now = Date.now();
			if (now - lastShown > 2000) {
				lastShown = now;
				host.showStatus(words.progress(pullRef, String(progress)));
			}
		},
	});
	if (!result.ok) {
		harnessLog.debug("ui", "a local model install failed", { stage: result.stage, reason: result.reason });
		host.showStatus(words.installFailed(plainLabel(result.stage), result.reason));
		return;
	}
	host.modelRegistry.refresh();
	host.showStatus(words.installedRegistered(pullRef, result.modelRef));
	await runFitnessAndAssign(host, result.modelRef, preselectRole);
}

export async function addTransformersModel(
	host: LocalModelHost,
	modelId: string,
	preselectRole?: FitnessRole,
): Promise<void> {
	const words = interfaceText().localModels.models;
	const runtime = host.getTransformersRuntime(modelId);
	let status = await runtime.detect();
	if (!status.runtimeInstalled) {
		host.showStatus(words.installingTransformers(modelId, String(status.venvDir)));
		const installed = await runtime.installManaged((progress) =>
			host.showStatus(words.progress("transformers", progress)),
		);
		if (!installed.ok) {
			host.showStatus(words.transformersInstallFailed(String(installed.error)));
			return;
		}
		status = await runtime.detect();
	}
	if (!status.runtimeInstalled) {
		host.showStatus(words.transformersUnavailable(String(status.venvDir)));
		return;
	}

	const downloaded = await runtime.downloadModel((progress) =>
		host.showStatus(words.progress(modelId, String(progress))),
	);
	if (!downloaded.ok) {
		host.showStatus(words.downloadFailed(String(downloaded.error)));
		return;
	}

	const started = await runtime.start();
	if (!started.started && started.reason !== "already_running") {
		harnessLog.debug("ui", "the Transformers sidecar did not start", { reason: started.reason });
		host.showStatus(words.sidecarStartFailed(plainLabel(String(started.reason))));
		return;
	}

	const registration = registerTransformersModel({
		agentDir: getAgentDir(),
		modelId,
		baseUrl: runtime.baseUrl,
	});
	if (!registration.ok) {
		reportRefusedRegistration(host, registration, words.notAutoRegistered);
		return;
	}
	host.modelRegistry.refresh();
	host.showStatus(words.registeredAs(modelId, `${HF_TRANSFORMERS_PROVIDER}/${modelId}`));
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
	const words = interfaceText().localModels.models;
	const runtime = getPrismLlamaCppRuntime(host);
	const modelId = descriptor.repo;

	let status = await runtime.detect();
	if (!status.runtimeInstalled) {
		host.showStatus(words.installingPrism(descriptor.displayName, runtime.runtimeDir()));
		const installed = await runtime.installManaged((progress) =>
			host.showStatus(words.progress("prism-llamacpp", String(progress))),
		);
		if (!installed.ok) {
			host.showStatus(words.prismInstallFailed(String(installed.error)));
			return;
		}
		status = await runtime.detect();
	}
	if (!status.runtimeInstalled) {
		host.showStatus(words.prismUnavailable(runtime.runtimeDir()));
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
				? words.downloadFailedLabel
				: served.stage === "mmproj-download"
					? words.visionDownloadFailed
					: words.llamaServerStartFailed;
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
		reportRefusedRegistration(host, registration, words.servedNotRegistered);
		return;
	}
	host.modelRegistry.refresh();
	host.showStatus(words.registeredAs(descriptor.displayName, `${PRISM_LLAMACPP_PROVIDER}/${modelId}`));
	await runFitnessAndAssign(host, `${PRISM_LLAMACPP_PROVIDER}/${modelId}`, preselectRole);
}

export async function removeLocalModel(host: LocalModelHost, ref: string, confirmed: boolean): Promise<void> {
	const words = interfaceText().localModels.models;
	const status = await host.localRuntime.detect();
	if (!status.serverUp) {
		host.showStatus(words.localServerDown);
		return;
	}
	const models = await host.localRuntime.list();
	const target = models.find((model) => matchesInstalledLocalModel(ref, model.name));
	if (!target) {
		host.showStatus(words.notInstalled(ref, models.map((model) => model.name).join(", ") || words.noneInstalled));
		return;
	}
	if (!confirmed) {
		// EXPLICIT USER ACTION ONLY: full disclosure, then require the confirm token.
		const gb = (target.sizeBytes / 1e9).toFixed(2);
		host.showStatus(
			removalDisclosure(
				[
					words.removalTitle(ref),
					words.removalWeights(gb, status.managedByPi ? status.ownedModelsDir : words.systemStorage),
					words.removalRegistration(`ollama/${ref}`),
					words.removalFitness,
				],
				`/models remove ${ref} confirm`,
			),
		);
		return;
	}
	const removed = await host.localRuntime.remove(ref);
	if (!removed.ok) {
		host.showStatus(words.removeFailed(String(removed.error)));
		return;
	}
	unregisterLocalModel({ agentDir: getAgentDir(), ref });
	FitnessStore.forAgentDir(getAgentDir()).remove(`ollama/${ref}`);
	host.modelRegistry.refresh();
	host.showStatus(words.removed(ref));
}

async function performRegistrationDrop(
	host: LocalModelHost,
	modelId: string,
	provider: string,
	unregister: (args: { agentDir: string; modelId: string }) => { ok: boolean; reason?: string },
	successMessage: string,
) {
	const words = interfaceText().localModels.models;
	const registration = unregister({ agentDir: getAgentDir(), modelId });
	if (!registration.ok) {
		host.showStatus(words.removeFailed(String(registration.reason)));
		return;
	}
	FitnessStore.forAgentDir(getAgentDir()).remove(`${provider}/${modelId}`);
	host.modelRegistry.refresh();
	host.showStatus(successMessage);
}

async function removeTransformersModel(host: LocalModelHost, modelId: string, confirmed: boolean): Promise<void> {
	const words = interfaceText().localModels.models;
	const runtime = host.getTransformersRuntime(modelId);
	const status = await runtime.detect();
	if (!confirmed) {
		host.showStatus(
			removalDisclosure(
				[
					words.removalTitle(modelId),
					words.removalRegistration(`${HF_TRANSFORMERS_PROVIDER}/${modelId}`),
					words.removalFitness,
					`${words.stoppedSidecarNote} ${words.weightsRemain(status.cacheDir)}`,
				],
				`/models remove hf.co/${modelId} confirm`,
			),
		);
		return;
	}
	runtime.stop();
	await performRegistrationDrop(
		host,
		modelId,
		HF_TRANSFORMERS_PROVIDER,
		unregisterTransformersModel,
		words.droppedWeightsRemain(modelId, status.cacheDir),
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
	const words = interfaceText().localModels.models;
	const runtime = getPrismLlamaCppRuntime(host);
	if (!confirmed) {
		host.showStatus(
			removalDisclosure(
				[
					words.removalTitle(modelId),
					words.removalRegistration(`${PRISM_LLAMACPP_PROVIDER}/${modelId}`),
					words.removalFitness,
					`${words.ggufRemain(runtime.modelsDir())} ${words.prismServerNote(PRISM_LLAMACPP_SERVE_PORT)}`,
				],
				`/models remove hf.co/${modelId} confirm`,
			),
		);
		return;
	}
	const stopped = runtime.stop();
	await performRegistrationDrop(
		host,
		modelId,
		PRISM_LLAMACPP_PROVIDER,
		unregisterPrismLlamaCppModel,
		words.prismDropped(modelId, runtime.modelsDir(), stopped.stopped, PRISM_LLAMACPP_SERVE_PORT),
	);
}

async function uninstallTransformersModel(host: LocalModelHost, modelId: string, confirmed: boolean): Promise<void> {
	const words = interfaceText().localModels.models;
	const runtime = host.getTransformersRuntime(modelId);
	const status = await runtime.detect();
	const sanitized = modelId.replace(/\//g, "--");
	const candidates = [
		join(status.cacheDir, "hub", `models--${sanitized}`),
		join(status.cacheDir, `models--${sanitized}`),
	];
	const artifactDir = candidates.find((p) => existsSync(p));
	let sizeBytes = 0;
	if (artifactDir) {
		try {
			sizeBytes = statSync(artifactDir).size;
		} catch {}
	}
	const gb = (sizeBytes / 1e9).toFixed(2);
	if (!confirmed) {
		host.showStatus(
			removalDisclosure(
				[
					words.uninstallTitle(modelId),
					words.removalRegistration(`${HF_TRANSFORMERS_PROVIDER}/${modelId}`),
					words.removalFitness,
					artifactDir ? words.weightsAt(gb, artifactDir) : words.noWeights(status.cacheDir),
					words.stoppedSidecarNote,
				],
				`/models uninstall hf.co/${modelId} confirm`,
			),
		);
		return;
	}
	runtime.stop();
	if (artifactDir && existsSync(artifactDir)) {
		try {
			rmSync(artifactDir, { recursive: true, force: true });
		} catch (e) {
			host.showStatus(words.deleteWeightsFailed(e instanceof Error ? e.message : String(e)));
		}
	}
	await performRegistrationDrop(
		host,
		modelId,
		HF_TRANSFORMERS_PROVIDER,
		unregisterTransformersModel,
		words.uninstalled(modelId, gb),
	);
}

async function uninstallPrismLlamaCppModel(host: LocalModelHost, modelId: string, confirmed: boolean): Promise<void> {
	const words = interfaceText().localModels.models;
	const runtime = getPrismLlamaCppRuntime(host);
	const descriptor = PRISM_LLAMACPP_DESCRIPTORS[modelId];
	const modelFile = descriptor ? join(runtime.modelsDir(), descriptor.file) : undefined;
	const mmprojFile = descriptor?.mmprojFile ? join(runtime.modelsDir(), descriptor.mmprojFile) : undefined;
	let totalSize = 0;
	if (modelFile && existsSync(modelFile)) {
		try {
			totalSize += statSync(modelFile).size;
		} catch {}
	}
	if (mmprojFile && existsSync(mmprojFile)) {
		try {
			totalSize += statSync(mmprojFile).size;
		} catch {}
	}
	const gb = (totalSize / 1e9).toFixed(2);
	if (!confirmed) {
		host.showStatus(
			removalDisclosure(
				[
					words.uninstallTitle(modelId),
					words.removalRegistration(`${PRISM_LLAMACPP_PROVIDER}/${modelId}`),
					words.removalFitness,
					words.ggufAt(gb, runtime.modelsDir()),
					words.prismUninstallServerNote,
				],
				`/models uninstall hf.co/${modelId} confirm`,
			),
		);
		return;
	}
	const stopped = runtime.stop();
	if (modelFile && existsSync(modelFile)) {
		try {
			rmSync(modelFile, { force: true });
		} catch {}
	}
	if (mmprojFile && existsSync(mmprojFile)) {
		try {
			rmSync(mmprojFile, { force: true });
		} catch {}
	}
	await performRegistrationDrop(
		host,
		modelId,
		PRISM_LLAMACPP_PROVIDER,
		unregisterPrismLlamaCppModel,
		words.prismUninstalled(modelId, gb, stopped.stopped),
	);
}

async function uninstallRuntime(host: LocalModelHost, runtimeName: string, confirmed: boolean): Promise<void> {
	const words = interfaceText().localModels.models;
	if (runtimeName === "prism" || runtimeName === "llamacpp" || runtimeName === "prism-llamacpp") {
		const runtime = getPrismLlamaCppRuntime(host);
		const runtimeDir = runtime.runtimeDir();
		if (!existsSync(runtimeDir)) {
			host.showStatus(words.runtimeNotInstalled(runtimeDir));
			return;
		}
		if (!confirmed) {
			host.showStatus(
				removalDisclosure(
					[words.runtimeUninstallTitle, words.runtimeUninstallBinaries(runtimeDir)],
					"/models uninstall-runtime prism confirm",
				),
			);
			return;
		}
		runtime.stop();
		try {
			rmSync(runtimeDir, { recursive: true, force: true });
			host.showStatus(words.runtimeDeleted(runtimeDir));
		} catch (e) {
			host.showStatus(words.runtimeDeleteFailed(e instanceof Error ? e.message : String(e)));
		}
		return;
	}
	host.showStatus(words.unknownRuntime(runtimeName));
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
	const words = interfaceText().localModels.models;
	const runtime = getNeedleRuntime(host);

	let status = await runtime.detect();
	if (!status.installed) {
		host.showStatus(words.installingNeedle(runtime.runtimeDir()));
		const installed = await runtime.installManaged((progress) =>
			host.showStatus(words.progress("needle", String(progress))),
		);
		if (!installed.ok) {
			host.showStatus(words.needleInstallFailed(String(installed.error)));
			return;
		}
		status = await runtime.detect();
	}
	if (!status.installed) {
		host.showStatus(words.needleUnavailable(runtime.runtimeDir()));
		return;
	}

	const downloaded = await runtime.downloadWeights((progress) => host.showStatus(words.indented(String(progress))));
	if (!downloaded.ok) {
		host.showStatus(words.needleWeightsFailed(String(downloaded.error)));
		return;
	}

	host.showStatus(words.needleSmokeRunning);
	const smoke = await runtime.smokeTest();
	if (!smoke.ok || !smoke.call) {
		host.showStatus(words.needleSmokeFailed(smoke.error ?? words.needleSmokeNoCall));
		return;
	}
	host.showStatus(
		words.needleVerified({
			called: smoke.call.name,
			argumentsJson: JSON.stringify(smoke.call.arguments),
			latencyMs: smoke.latencyMs,
		}),
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
	const words = interfaceText().localModels.models;
	const runtime = getNeedleRuntime(host);
	const runtimeDir = runtime.runtimeDir();
	const modelsDir = runtime.modelsDir();
	if (!confirmed) {
		host.showStatus(
			removalDisclosure(
				[
					words.needleRemovalTitle,
					words.needleRuntimeLine(runtimeDir),
					words.needleCheckpointLine(runtime.checkpointPath()),
					words.needleNoRegistration,
				],
				"/models remove hf.co/Cactus-Compute/needle confirm",
			),
		);
		return;
	}
	if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true });
	if (existsSync(modelsDir)) rmSync(modelsDir, { recursive: true, force: true });
	host.showStatus(words.needleRemoved(runtimeDir, modelsDir));
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
	const words = interfaceText().localModels.models;
	if (args.length === 0) {
		host.showStatus(words.needleUsage);
		return;
	}

	const runtime = getNeedleRuntime(host);
	const status = await runtime.detect();
	if (!status.installed) {
		host.showStatus(words.needleNotInstalled);
		return;
	}
	if (!status.checkpointPresent) {
		host.showStatus(words.needleCheckpointMissing);
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
		host.showStatus(words.needleUsage);
		return;
	}

	host.showStatus(words.needleRunning(query));
	const startedAt = Date.now();
	const result = await runtime.runFunctionCall({ query, tools });
	const latencyMs = Date.now() - startedAt;
	if (!result.ok) {
		host.showStatus(words.needleCallFailed(latencyMs, result.error, result.rawOutput));
		return;
	}
	host.showStatus(words.needleCall(latencyMs, result.call.name, JSON.stringify(result.call.arguments)));
}

/** /fitness with no args: pick a model from the configured registry, probe it, assign a role. */
/** Pick a validated suggestion → install it → probe on this host → land its shaped role. */
export function showModelSuggestionSelector(host: LocalModelHost): void {
	const words = interfaceText().localModels.models;
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
						host.showStatus(words.suggestionUnknownPrism(suggestion.name, source.modelId));
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
					words.suggestionNotInstallable(suggestion.name, source.type === "rejected" ? source.reason : source.ref),
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
			host.modelRegistry,
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
function getModelThinkingLevels(
	modelRegistry: LocalModelCommandsModelSource | undefined,
	modelRef: string,
): ThinkingLevel[] {
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
	return undefined;
}

function promptForModelRouterThinking(host: RunFitnessHost, modelRef: string, role: FitnessRole): void {
	const thinkingField = getModelRouterThinkingField(role);
	if (!thinkingField) {
		return;
	}

	const modelRegistry = host.modelRegistry;
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
	const words = interfaceText().localModels.fitness;
	host.showStatus(words.probeRunning(modelRef));
	try {
		const outcome = await host.session.runModelFitness({ model: modelRef });
		if (!presentModelFitnessOutcome(host, outcome)) return;
		// Validate-before-load: zero successes on every probed surface means the model cannot
		// drive any of the harness's subagent contracts on this host — refuse adoption instead
		// of landing a role selector the user might reflexively confirm (this is the reported
		// bug: a 0/3-everywhere model still got set as judge model and saved to Model Router).
		if (isProbeAllFailed(outcome.report)) {
			host.showStatus(words.allSurfacesFailed(outcome.model));
			return;
		}
		let toolProbe: ToolProbeResult | undefined;
		if (preselectRole === undefined || roleRequiresToolExecution(preselectRole)) {
			host.showStatus(words.toolProbeRunning(outcome.model));
			try {
				const toolProbeReport = await host.session.probeToolCalling(outcome.model);
				toolProbe =
					toolProbeReport.results.find((result) => result.model === outcome.model) ??
					(toolProbeReport.results.length === 1 ? toolProbeReport.results[0] : undefined);
			} catch (error) {
				host.showStatus(
					words.toolProbeUnavailable(outcome.model, error instanceof Error ? error.message : String(error)),
				);
			}
		}
		host.showSelector((done) => {
			const selector = new FitnessRoleSelectorComponent(
				outcome.model,
				(role) => {
					done();
					const toolFailure = toolRoleFailure(role, toolProbe);
					if (toolFailure) {
						host.showStatus(words.notAssignedTool(outcome.model, role, toolFailure));
						return;
					}
					if (role === "scout") {
						const verdict = evaluateSurfaceFitness("scout_auto", outcome.report);
						if (!verdict.fit) {
							harnessLog.debug("ui", "a model was not assigned as scout", {
								model: outcome.model,
								reason: verdict.reason,
								lane: verdict.reason === "lane_failed" ? verdict.lane : undefined,
							});
							const reason =
								verdict.reason === "lane_failed" ? words.scoutLaneFailed(verdict.lane) : words.scoutNotProbed;
							host.showStatus(words.scoutRefused(outcome.model, reason));
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

function roleRequiresToolExecution(role: FitnessRole): boolean {
	return (
		role === "executor" ||
		role === "scout" ||
		role === "router-cheap" ||
		role === "router-medium" ||
		role === "router-expensive"
	);
}

function toolRoleFailure(role: FitnessRole, probe: ToolProbeResult | undefined): string | undefined {
	if (!roleRequiresToolExecution(role)) return undefined;
	return toolExecutionFailure(probe);
}

/** Persist a role assignment from the post-probe selector into the matching settings. */
export function assignFitnessRole(host: AssignRoleHost, modelRef: string, role: FitnessRole): void {
	const words = interfaceText().localModels.fitness;
	if (role === "none") {
		host.showStatus(words.roleNone(modelRef));
		return;
	}
	if (role === "curator") {
		const current = host.settingsManager.getContextCurationSettings();
		host.settingsManager.setContextCurationSettings({ ...current, enabled: true, model: modelRef });
		host.showStatus(words.roleCurator(modelRef));
		return;
	}
	if (role === "executor") {
		const router = host.settingsManager.getModelRouterSettings();
		host.settingsManager.setModelRouterSettings({ ...router, executorModel: modelRef });
		const hint = router.enabled ? "" : words.routerDisabledHint;
		host.showStatus(words.roleExecutor(modelRef, hint));
		return;
	}
	if (role === "scout") {
		host.settingsManager.setScoutSettings({ enabled: true, model: modelRef });
		host.showStatus(words.roleScout(modelRef));
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
					: "learningModel";
	host.settingsManager.setModelRouterSettings({ ...router, [field]: modelRef });
	const hint = router.enabled ? "" : words.routerDisabledHint;
	host.showStatus(words.roleSet(modelRef, role.replace("router-", "router "), hint));
}

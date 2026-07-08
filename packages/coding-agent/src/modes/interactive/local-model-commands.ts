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
import { DEFAULT_MODEL_SUGGESTIONS } from "../../core/models/default-model-suggestions.ts";
import { FitnessStore } from "../../core/models/fitness-store.ts";
import {
	HF_TRANSFORMERS_PROVIDER,
	registerLocalModel,
	registerTransformersModel,
	unregisterLocalModel,
	unregisterTransformersModel,
} from "../../core/models/local-registration.ts";
import type { OllamaRuntime, TransformersRuntime } from "../../core/models/local-runtime.ts";
import { matchesInstalledLocalModel, normalizeModelSource } from "../../core/models/model-ref.ts";
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
	showStatus(message: string): void;
	showError(message: string): void;
	showSelector(create: SelectorFactory): void;
}

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
			const stoppedAny = stopped.stopped || stoppedTransformers > 0;
			host.showStatus(
				stoppedAny
					? `Pi-managed local model server stopped${stoppedTransformers > 0 ? ` (${stoppedTransformers} Transformers sidecar(s))` : ""}; models remain installed.`
					: "No pi-managed server running (a system server, if any, is not pi's to stop).",
			);
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
			await removeLocalModel(host, ref, confirmed);
			return;
		}

		await listLocalModels(host);
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

export async function ensureLocalServer(host: LocalModelHost): Promise<boolean> {
	const status = await host.localRuntime.detect();
	if (status.serverUp) return true;
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
				`Ollama models (${status.managedByPi ? `pi-managed server, storage: ${status.ownedModelsDir}` : "system server — storage owned by the system daemon"}):`,
				...(models.length === 0
					? ["  (none installed — /models add <ref>, or /models suggest for a validated roster)"]
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
		"Commands: /models add <ref> · /models remove <ref> confirm · /models stop",
	];
	for (const line of lines) host.showStatus(line);
}

export async function addLocalModel(host: LocalModelHost, pullRef: string, preselectRole?: FitnessRole): Promise<void> {
	if (!(await ensureLocalServer(host))) return;
	host.showStatus(`Pulling ${pullRef}… (weights land in the server's model storage)`);
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
	const registration = registerLocalModel({
		agentDir: getAgentDir(),
		ref: pullRef,
		baseUrl: host.localRuntime.baseUrl,
	});
	if (!registration.ok) {
		host.showStatus(`Pulled, but not auto-registered: ${registration.reason}`);
		if (registration.manualSnippet) {
			host.showStatus(`Add this to ${registration.modelsJsonPath} yourself:\n${registration.manualSnippet}`);
		}
		return;
	}
	host.session.modelRegistry.refresh();
	host.showStatus(`${pullRef} installed and registered as ollama/${pullRef}. Probing fitness…`);
	await runFitnessAndAssign(host, `ollama/${pullRef}`, preselectRole);
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

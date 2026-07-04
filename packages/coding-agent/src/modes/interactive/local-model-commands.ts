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

import type { Component, Container, TUI } from "@caupulican/pi-tui";
import { Spacer, Text } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { DEFAULT_MODEL_SUGGESTIONS } from "../../core/models/default-model-suggestions.ts";
import { FitnessStore } from "../../core/models/fitness-store.ts";
import { registerLocalModel, unregisterLocalModel } from "../../core/models/local-registration.ts";
import type { OllamaRuntime } from "../../core/models/local-runtime.ts";
import { matchesInstalledLocalModel, normalizeModelSource } from "../../core/models/model-ref.ts";
import { formatModelFitnessReport, isProbeAllFailed } from "../../core/research/model-fitness.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { type FitnessRole, FitnessRoleSelectorComponent } from "./components/fitness-role-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ModelSuggestionSelectorComponent } from "./components/model-suggestion-selector.ts";

type SelectorFactory = (done: () => void) => { component: Component; focus: Component };

/** Narrow seam for persisting a probed model's role — matches the fitness-role test. */
export interface AssignRoleHost {
	readonly settingsManager: SettingsManager;
	showStatus(message: string): void;
}

/** Seam for the fitness probe + role-selector flow — matches the fitness-probe-gate test. */
export interface RunFitnessHost {
	readonly session: Pick<AgentSession, "runModelFitness">;
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
	showStatus(message: string): void;
	showError(message: string): void;
	showSelector(create: SelectorFactory): void;
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
			host.showStatus(
				stopped.stopped
					? "Pi-managed local model server stopped (models remain installed)."
					: "No pi-managed server running (a system server, if any, is not pi's to stop).",
			);
			return;
		}

		if (action === "add") {
			const rawRef = rest.join(" ");
			if (!rawRef) {
				host.showStatus(
					"Usage: /models add <ollama-tag | hf.co/org/repo[:quant] | huggingface URL | pasted install command>",
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
	if (!status.serverUp) {
		if (!status.binaryPath) {
			for (const line of host.localRuntime.installGuide()) host.showStatus(line);
			return;
		}
		host.showStatus(
			`Local server not running (binary: ${status.binarySource}). /models add starts it on demand; /fitness probes registered models.`,
		);
		return;
	}
	const models = await host.localRuntime.list();
	const fitness = FitnessStore.forAgentDir(getAgentDir()).getForHost();
	const lines = [
		`Local models (${status.managedByPi ? `pi-managed server, storage: ${status.ownedModelsDir}` : "system server — storage owned by the system daemon"}):`,
		...(models.length === 0
			? ["  (none installed — /models add <ref>, or /models suggest for a validated roster)"]
			: []),
		...models.map((model) => {
			const report = fitness.find((entry) => entry.model === `ollama/${model.name}`);
			const gb = (model.sizeBytes / 1e9).toFixed(2);
			const probe = report
				? `probed ${report.at.slice(0, 10)}: digest ${report.report.digest?.succeeded ?? "?"}/${report.report.digest?.total ?? "?"}, tool-calls ${report.report.toolCall.succeeded}/${report.report.toolCall.total}${report.report.tokensPerSecond ? `, ~${report.report.tokensPerSecond} tok/s` : ""}`
				: `unprobed — run /fitness ollama/${model.name}`;
			return `  - ${model.name} (${gb} GB) · ${probe}`;
		}),
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
				await addLocalModel(host, suggestion.pullRef, suggestion.assignRole);
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
					assignFitnessRole(host, outcome.model, role);
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

/**
 * Session-picker, tree/fork navigation, and model-selector flows extracted from
 * interactive-mode.
 *
 * Each entry opens a selector overlay (via `host.showSelector`) or renders a
 * session-info block, driving `AgentSession`/`AgentSessionRuntime` navigation and
 * the fork/resume/clone/goal-continuation paths. The interdependent selector
 * flows share one narrow `SessionFlowHost` seam; the three prototype-tested leaf
 * commands (`handleCloneCommand`, `handleGoalContinueCommand`,
 * `handleSessionCommand`) take their own minimal host shapes so their behaviour
 * tests keep exercising them through interactive-mode's thin wrappers unchanged.
 */

import { randomUUID } from "node:crypto";
import type { Api, Model } from "@caupulican/pi-ai";
import type { EditorComponent } from "@caupulican/pi-tui";
import { type Component, type Container, Loader, Spacer, type TUI } from "@caupulican/pi-tui";
import { sessionsDir } from "../../core/agent-paths.ts";
import type {
	AgentSession,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
} from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionCommandContext, ExtensionRunner } from "../../core/extensions/index.ts";
import { describeGoalAutoContinue } from "../../core/goals/goal-auto-continue-state.ts";
import {
	cancelPersistedGoal,
	clearPersistedGoal,
	editPersistedGoal,
	type GoalStateRevision,
	getGoalStateRevision,
	isSystemBlockedGoal,
	pausePersistedGoal,
	replaceGoal,
	resumeGoal,
	resumePersistedGoal,
} from "../../core/goals/goal-lifecycle.ts";
import { type GoalActionRefusal, refusedGoalActionText } from "../../core/goals/goal-refusal.ts";
import { type GoalState, isGoalExecutionActive } from "../../core/goals/goal-state.ts";
import { applyGoalAction, completeGoalManually } from "../../core/goals/goal-tool-core.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import {
	findExactModelReferenceMatch,
	resolveModelScope,
	resolveModelScopeWithDiagnostics,
} from "../../core/model-resolver.ts";
import { routerPoolModelRefs } from "../../core/model-router/candidate-pool.ts";
import { refuseHostedSession, SessionHostedError } from "../../core/orchestration/session-bundle-lifecycle.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import type { ModelFavorite } from "../../core/settings/settings-schema.ts";
import { parseTaskCommand } from "../../core/tasks/task-command.ts";
import {
	addTaskStep,
	clearTaskSteps,
	compactTaskSteps,
	createTaskStepsState,
	formatTaskSteps,
	type TaskStepsState,
	updateTaskStep,
} from "../../core/tasks/task-state.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { ThinkingLevel } from "../../kernel/index.ts";
import { SessionManager } from "../../kernel/node.ts";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import { keyText } from "../../presentation/keybinding-hints.ts";
import { plainLabel } from "../../presentation/plain-text.ts";
import { theme } from "../../presentation/theme-model.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import type { ExtensionUiHost } from "./extension-ui-host.ts";
import { handleNonFatalSessionReplacementError } from "./session-replacement-errors.ts";

export { handleSessionCommand, type SessionInfoCommandHost } from "./session-info-view.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface SessionFlowCommandsSettingsSource {
	getBranchSummarySkipPrompt(): boolean;
	getEnabledModels(): string[] | undefined;
	getModelFavorites(): ModelFavorite[];
	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	isProjectTrusted(): boolean;
	setProjectTrusted(trusted: boolean): void;
	setDefaultModelAndProvider(provider: string, modelId: string): void;
	setDefaultThinkingLevel(level: ThinkingLevel): void;
	setEnabledModels(patterns: string[] | undefined): void;
	toggleModelFavorite(provider: string, modelId: string): void;
}

/** Shared seam for the interdependent selector/navigation flows. */
export interface SessionFlowHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SessionFlowCommandsSettingsSource;
	readonly modelRegistry: ModelRegistry;
	readonly extensionRunner: ExtensionRunner;
	readonly runtimeHost: AgentSessionRuntime;
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly statusContainer: Container;
	readonly editor: EditorComponent;
	readonly defaultEditor: CustomEditor;
	readonly footer: FooterComponent;
	readonly extensionUiHost: ExtensionUiHost;
	readonly keybindings: KeybindingsManager;
	loadingAnimation: Loader | undefined;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showError(message: string): void;
	refreshAutonomyFooterStatus(): void;
	renderCurrentSessionState(): void;
	renderInitialMessages(options?: { forceHistoryLoad?: boolean }): Promise<void>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	updateEditorBorderColor(): void;
	updateAvailableProviderCount(): Promise<void>;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<Api>): Promise<void>;
	checkDaxnutsEasterEgg(model: { provider: string; id: string }): void;
	getModelCandidates(): Promise<Model<Api>[]>;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;
	/** Reloads settings, instructions and extensions; resolves false when a busy session declined. */
	reload(): Promise<boolean>;
}

function finishSelectorCancellation(host: Pick<SessionFlowHost, "ui">, done: () => void): void {
	done();
	host.ui.requestRender();
}

function finishSelectorError(host: Pick<SessionFlowHost, "showError">, done: () => void, error: unknown): void {
	done();
	host.showError(error instanceof Error ? error.message : String(error));
}

export async function showModelSelector(host: SessionFlowHost, initialSearchInput?: string): Promise<void> {
	try {
		await host.extensionRunner.emit({
			type: "model_selector_open",
			currentModel: host.session.model,
			scopedModels: host.session.scopedModels,
			initialSearchInput,
		});
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
		return;
	}

	host.showSelector((done) => {
		const selector = new ModelSelectorComponent(
			host.ui,
			host.session.model,
			host.settingsManager,
			host.modelRegistry,
			host.session.scopedModels,
			async (model) => {
				try {
					await host.session.setModel(model);
					host.footer.invalidate();
					host.updateEditorBorderColor();
					done();
					host.showStatus(interfaceText().sessions.model.chosen(model.id));
					void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
					host.checkDaxnutsEasterEgg(model);
				} catch (error) {
					finishSelectorError(host, done, error);
				}
			},
			() => {
				finishSelectorCancellation(host, done);
			},
			initialSearchInput,
			async (model) => {
				try {
					host.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
					await host.session.setModel(model);
					host.footer.invalidate();
					host.updateEditorBorderColor();
					done();
					host.showStatus(interfaceText().sessions.model.defaultChosen(model.id));
					void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
					host.checkDaxnutsEasterEgg(model);
				} catch (error) {
					finishSelectorError(host, done, error);
				}
			},
		);
		return { component: selector, focus: selector };
	});
}

export async function showModelsSelector(host: SessionFlowHost): Promise<void> {
	// Get all available models
	host.modelRegistry.refresh();
	const allModels = host.modelRegistry.getAvailable();
	const allModelIds = new Set(allModels.map((model) => `${model.provider}/${model.id}`));
	const configuredPatterns = host.settingsManager.getEnabledModels();
	// The selector edits the router's candidate pool, not the cycling list: an orchestration
	// profile pins cycling to its root model and must not show up here as a one-model selection.
	const routerPool = host.session.getRouterCandidatePool();

	if (allModels.length === 0 && !configuredPatterns?.length && !routerPool.customized) {
		host.showStatus(interfaceText().sessions.model.noneAvailable);
		return;
	}
	const configuredScope = configuredPatterns?.length
		? await resolveModelScopeWithDiagnostics(configuredPatterns, host.modelRegistry)
		: undefined;

	// Build enabled model IDs from the live router pool (session-only edits or CLI --models) or settings
	let currentEnabledIds: string[] | null = null;

	if (routerPool.customized) {
		currentEnabledIds = routerPoolModelRefs(routerPool);
	} else if (configuredScope) {
		currentEnabledIds = configuredScope.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
	}

	for (const diagnostic of configuredScope?.diagnostics ?? []) {
		if (diagnostic.code !== "no-match") continue;
		currentEnabledIds ??= [];
		if (!currentEnabledIds.includes(diagnostic.pattern)) currentEnabledIds.push(diagnostic.pattern);
	}

	// Helper to update session's scoped models (session-only, no persist)
	const updateSessionModels = async (enabledIds: string[] | null) => {
		currentEnabledIds = enabledIds === null ? null : [...enabledIds];
		const hasEnabledAvailableModel = enabledIds?.some((id) => allModelIds.has(id)) ?? false;
		const allAvailableModelsEnabled = enabledIds !== null && [...allModelIds].every((id) => enabledIds.includes(id));
		if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
			const newScopedModels = await resolveModelScope(enabledIds, host.modelRegistry);
			host.session.setScopedModels(
				newScopedModels.map((sm) => ({
					model: sm.model,
					thinkingLevel: sm.thinkingLevel,
				})),
			);
			host.session.setRouterPool({
				source: "models_selector",
				models: newScopedModels.map((sm) => sm.model),
			});
		} else {
			// All enabled or none enabled = no filter
			host.session.setScopedModels([]);
			host.session.setRouterPool(undefined);
		}
		await host.updateAvailableProviderCount();
		host.ui.requestRender();
	};

	host.showSelector((done) => {
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels,
				enabledModelIds: currentEnabledIds,
			},
			{
				onChange: async (enabledIds) => {
					await updateSessionModels(enabledIds);
				},
				onPersist: (enabledIds) => {
					// Persist to settings
					const allEnabled =
						enabledIds !== null &&
						enabledIds.length === allModels.length &&
						enabledIds.every((id) => allModelIds.has(id));
					const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
					host.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
					host.showStatus(interfaceText().sessions.model.selectionSaved);
				},
				onCancel: () => {
					finishSelectorCancellation(host, done);
				},
			},
		);
		return { component: selector, focus: selector };
	});
}

export function showUserMessageSelector(host: SessionFlowHost, newSessionName?: string): void {
	const words = interfaceText().sessions.resume;
	const userMessages = host.session.getUserMessagesForForking();

	if (userMessages.length === 0) {
		host.showStatus(words.forkNoMessages);
		return;
	}

	const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

	host.showSelector((done) => {
		const selector = new UserMessageSelectorComponent(
			userMessages.map((m) => ({ id: m.entryId, text: m.text })),
			async (entryId) => {
				try {
					const result = await host.runtimeHost.fork(entryId);
					if (result.cancelled) {
						finishSelectorCancellation(host, done);
						return;
					}

					host.renderCurrentSessionState();
					if (newSessionName) {
						host.session.setSessionName(newSessionName);
					}
					host.editor.setText(result.selectedText ?? "", result.pasted);
					done();
					host.showStatus(newSessionName ? words.forked(newSessionName) : words.forkedUnnamed);
				} catch (error: unknown) {
					finishSelectorError(host, done, error);
				}
			},
			() => {
				finishSelectorCancellation(host, done);
			},
			initialSelectedId,
		);
		return { component: selector, focus: selector.getMessageList() };
	});
}

export function showTreeSelector(host: SessionFlowHost, initialSelectedId?: string): void {
	const words = interfaceText().sessions.tree;
	const tree = host.sessionManager.getTree();
	const realLeafId = host.sessionManager.getLeafId();
	const initialFilterMode = host.settingsManager.getTreeFilterMode();

	if (tree.length === 0) {
		host.showStatus(words.noEntries);
		return;
	}

	host.showSelector((done) => {
		const selector = new TreeSelectorComponent(
			tree,
			realLeafId,
			host.ui.terminal.rows,
			async (entryId) => {
				// Selecting the current leaf is a no-op (already there)
				if (entryId === realLeafId) {
					done();
					host.showStatus(words.alreadyHere);
					return;
				}

				// Ask about summarization
				done(); // Close selector first

				// Loop until user makes a complete choice or cancels to tree
				let wantsSummary = false;
				let customInstructions: string | undefined;
				// The answers are identifiers: the label the owner reads never decides what happens next.
				const summaryChoices = [
					{ id: "none", label: words.noSummary },
					{ id: "summary", label: words.summarize },
					{ id: "custom", label: words.summarizeCustom },
				] as const;

				// Check if we should skip the prompt (user preference to always default to no summary)
				if (!host.settingsManager.getBranchSummarySkipPrompt()) {
					while (true) {
						const answer = await host.extensionUiHost.showExtensionSelector(
							words.summarizeTitle,
							summaryChoices.map((choice) => choice.label),
						);

						if (answer === undefined) {
							// User pressed escape - re-show tree selector with same selection
							showTreeSelector(host, entryId);
							return;
						}

						const choice = summaryChoices.find((candidate) => candidate.label === answer)?.id ?? "none";
						wantsSummary = choice !== "none";

						if (choice === "custom") {
							customInstructions = await host.extensionUiHost.showExtensionEditor(words.customInstructionsTitle);
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}
				}

				// Set up escape handler and loader if summarizing
				let summaryLoader: Loader | undefined;
				const originalOnEscape = host.defaultEditor.onEscape;

				if (wantsSummary) {
					host.defaultEditor.onEscape = () => {
						host.session.abortBranchSummary();
					};
					host.chatContainer.addChild(new Spacer(1));
					summaryLoader = new Loader(
						host.ui,
						(spinner) => theme.fg("accent", spinner),
						(text) => theme.fg("muted", text),
						words.loader(keyText("app.interrupt")),
					);
					host.statusContainer.addChild(summaryLoader);
					host.ui.requestRender();
				}

				try {
					const result = await host.session.navigateTree(entryId, {
						summarize: wantsSummary,
						customInstructions,
					});

					if (result.aborted) {
						// Summarization aborted - re-show tree selector with same selection
						host.showStatus(words.summarizationCancelled);
						showTreeSelector(host, entryId);
						return;
					}
					if (result.cancelled) {
						host.showStatus(words.navigationCancelled);
						return;
					}

					// Update UI
					await host.renderInitialMessages();
					if (result.editorText && !host.editor.getText().trim()) {
						host.editor.setText(result.editorText, result.pasted);
					}
					host.showStatus(words.navigated);
					void host.flushCompactionQueue({ willRetry: false });
				} catch (error) {
					host.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (summaryLoader) {
						summaryLoader.stop();
						host.statusContainer.clear();
					}
					host.defaultEditor.onEscape = originalOnEscape;
				}
			},
			() => {
				finishSelectorCancellation(host, done);
			},
			(entryId, label) => {
				host.sessionManager.appendLabelChange(entryId, label);
				host.ui.requestRender();
			},
			initialSelectedId,
			initialFilterMode,
		);
		return { component: selector, focus: selector };
	});
}

export function showTrustSelector(host: SessionFlowHost): void {
	const words = interfaceText().sessions.trust;
	const cwd = host.sessionManager.getCwd();
	const trustStore = new ProjectTrustStore(host.runtimeHost.services.agentDir);
	const savedDecision = trustStore.get(cwd);
	host.showSelector((done) => {
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision,
			projectTrusted: host.settingsManager.isProjectTrusted(),
			onSelect: (trusted) => {
				trustStore.set(cwd, trusted);
				done();
				// The decision applies to this session now: project settings, instructions and extensions load or drop.
				host.settingsManager.setProjectTrusted(trusted);
				void host.reload().then((reloaded) => {
					host.showStatus(reloaded ? words.applied(trusted) : words.saved(trusted));
				});
			},
			onCancel: () => {
				finishSelectorCancellation(host, done);
			},
		});
		return { component: selector, focus: selector };
	});
}

export function showSessionSelector(host: SessionFlowHost): void {
	const agentDir = host.runtimeHost.services.agentDir;
	host.showSelector((done) => {
		const selector = new SessionSelectorComponent(
			(onProgress) =>
				SessionManager.list(
					host.sessionManager.getCwd(),
					agentDir,
					host.sessionManager.getSessionDir(),
					onProgress,
				),
			(onProgress) =>
				host.sessionManager.usesDefaultSessionDir()
					? SessionManager.listAll(sessionsDir(agentDir), onProgress)
					: SessionManager.listAll(sessionsDir(agentDir), host.sessionManager.getSessionDir(), onProgress),
			async (sessionPath) => {
				done();
				await handleResumeSession(host, sessionPath);
			},
			() => {
				finishSelectorCancellation(host, done);
			},
			() => {
				void host.shutdown();
			},
			() => host.ui.requestRender(),
			{
				agentDir,
				renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
					const next = (nextName ?? "").trim();
					if (!next) return;
					// A session the bot daemon hosts is never written from here (`SessionHostedError`).
					const header = readSessionHeaderResult(sessionFilePath);
					try {
						if (header.ok) refuseHostedSession(agentDir, header.header.id);
					} catch (error) {
						if (!(error instanceof SessionHostedError)) throw error;
						host.showError(error.message);
						return;
					}
					const mgr = SessionManager.open(sessionFilePath, agentDir);
					mgr.appendSessionInfo(next);
				},
				showRenameHint: true,
				keybindings: host.keybindings,
			},

			host.sessionManager.getSessionFile(),
		);
		return { component: selector, focus: selector };
	});
}

async function switchSession(
	host: SessionFlowHost,
	sessionPath: string,
	options: Parameters<ExtensionCommandContext["switchSession"]>[1] | undefined,
	cwdOverride?: string,
): Promise<{ cancelled: boolean }> {
	return host.runtimeHost.switchSession(sessionPath, {
		cwdOverride,
		withSession: options?.withSession,
	});
}

async function offerRestoredGoalResume(host: SessionFlowHost): Promise<boolean> {
	const state = host.session.getGoalStateSnapshot();
	if (state && (isSystemBlockedGoal(state) || state.status === "usage_limited")) {
		const restored = host.session.restoreGoalRuntimeAfterResume();
		if (restored.resumed) {
			host.refreshAutonomyFooterStatus();
			return true;
		}
		// A goal waiting for its subscription's usage reset resumes on its own at the reset: nothing is asked.
		if (restored.waitsForUsageReset) return false;
	}
	if (!state || (state.status !== "paused" && state.status !== "blocked" && state.status !== "usage_limited")) {
		host.session.restoreGoalRuntimeAfterResume();
		return false;
	}
	const words = interfaceText().sessions.resume;
	// The answers are identifiers: the label the owner reads never decides what happens next.
	const resumeChoices = [
		{ id: "resume", label: words.resumeGoal },
		{ id: "leave", label: words.leaveStopped },
	] as const;
	const answer = await host.extensionUiHost?.showExtensionSelector(
		words.resumeGoalTitle,
		resumeChoices.map((choice) => choice.label),
	);
	const choice = resumeChoices.find((candidate) => candidate.label === answer)?.id;
	if (choice !== "resume") return false;
	const resumed = resumePersistedGoal(host.session);
	if (!resumed.ok) {
		throw new Error(words.goalResumeFailed(refusedGoalActionText(resumed, interfaceText().sessions.goal)));
	}
	host.session.restoreGoalRuntimeAfterResume();
	host.refreshAutonomyFooterStatus();
	return true;
}

export async function handleResumeSession(
	host: SessionFlowHost,
	sessionPath: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
): Promise<{ cancelled: boolean }> {
	const words = interfaceText().sessions.resume;
	if (host.loadingAnimation) {
		host.loadingAnimation.stop();
		host.loadingAnimation = undefined;
	}
	host.statusContainer.clear();
	try {
		const result = await switchSession(host, sessionPath, options);
		if (result.cancelled) {
			return result;
		}
		host.renderCurrentSessionState();
		const goalResumed = await offerRestoredGoalResume(host);
		host.showStatus(goalResumed ? words.resumedWithGoal : words.resumedGoalPreserved);
		return result;
	} catch (error: unknown) {
		const disposition = handleNonFatalSessionReplacementError(host, error);
		if (disposition) return { cancelled: disposition === "previous_restored" };
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus(words.cancelled);
				return { cancelled: true };
			}
			try {
				const result = await switchSession(host, sessionPath, options, selectedCwd);
				if (result.cancelled) {
					return result;
				}
				host.renderCurrentSessionState();
				const goalResumed = await offerRestoredGoalResume(host);
				host.showStatus(goalResumed ? words.resumedWithGoalHere : words.resumedGoalPreservedHere);
				return result;
			} catch (retryError: unknown) {
				const retryDisposition = handleNonFatalSessionReplacementError(host, retryError);
				if (retryDisposition) return { cancelled: retryDisposition === "previous_restored" };
				return host.handleFatalRuntimeError(words.failed, retryError);
			}
		}
		return host.handleFatalRuntimeError(words.failed, error);
	}
}

export async function handleModelCommand(host: SessionFlowHost, searchTerm?: string): Promise<void> {
	if (!searchTerm) {
		await showModelSelector(host);
		return;
	}

	const model = await findExactModelMatch(host, searchTerm);
	if (model) {
		try {
			await host.session.setModel(model);
			host.footer.invalidate();
			host.updateEditorBorderColor();
			host.showStatus(interfaceText().sessions.model.chosen(model.id));
			void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
			host.checkDaxnutsEasterEgg(model);
		} catch (error) {
			host.showError(error instanceof Error ? error.message : String(error));
		}
		return;
	}

	await showModelSelector(host, searchTerm);
}

export async function findExactModelMatch(host: SessionFlowHost, searchTerm: string): Promise<Model<Api> | undefined> {
	const models = await host.getModelCandidates();
	return findExactModelReferenceMatch(searchTerm, models);
}

export async function showThinkingSelector(host: SessionFlowHost): Promise<void> {
	const words = interfaceText().sessions.thinking;
	const currentLevel = host.session.thinkingLevel;
	const availableLevels = host.session.getAvailableThinkingLevels();
	if (availableLevels.length === 0) {
		host.showStatus(words.unsupported);
		return;
	}

	host.showSelector((done) => {
		const selector = new ThinkingSelectorComponent(
			currentLevel,
			availableLevels,
			(level) => {
				host.session.setThinkingLevel(level);
				host.footer.invalidate();
				host.updateEditorBorderColor();
				done();
				host.showStatus(words.levelSet(level));
			},
			() => {
				finishSelectorCancellation(host, done);
			},
			(level) => {
				host.settingsManager.setDefaultThinkingLevel(level);
				host.session.setThinkingLevel(level);
				host.footer.invalidate();
				host.updateEditorBorderColor();
				done();
				host.showStatus(words.defaultLevelSet(level));
			},
		);
		return { component: selector, focus: selector };
	});
}

export async function handleThinkingCommand(host: SessionFlowHost, arg?: string): Promise<void> {
	const words = interfaceText().sessions.thinking;
	if (!arg) {
		await showThinkingSelector(host);
		return;
	}

	const normalized = arg.trim().toLowerCase();
	const availableLevels = host.session.getAvailableThinkingLevels();
	if (availableLevels.length === 0) {
		host.showStatus(words.unsupported);
		return;
	}

	if (availableLevels.includes(normalized as ThinkingLevel)) {
		host.session.setThinkingLevel(normalized as ThinkingLevel);
		host.footer.invalidate();
		host.updateEditorBorderColor();
		host.showStatus(words.levelSet(normalized));
	} else {
		host.showError(words.invalid(arg, availableLevels.join(", ")));
	}
}

// ===========================================================================
// Prototype-tested leaf commands — narrow host shapes matching their fakes.
// ===========================================================================

export interface CloneCommandHost {
	readonly sessionManager: { getLeafId: () => string | null };
	readonly runtimeHost: {
		fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean }>;
	};
	renderCurrentSessionState(): void;
	readonly editor: { setText: (text: string) => void };
	readonly session: { setSessionName: (name: string) => void };
	showStatus(message: string): void;
	showError(message: string): void;
	readonly ui: { requestRender: () => void };
}

export async function handleCloneCommand(host: CloneCommandHost, newSessionName?: string): Promise<void> {
	const words = interfaceText().sessions.clone;
	const leafId = host.sessionManager.getLeafId();
	if (!leafId) {
		host.showStatus(words.nothing);
		return;
	}

	try {
		const result = await host.runtimeHost.fork(leafId, { position: "at" });
		if (result.cancelled) {
			host.ui.requestRender();
			return;
		}

		host.renderCurrentSessionState();
		if (newSessionName) {
			host.session.setSessionName(newSessionName);
		}
		host.editor.setText("");
		host.showStatus(newSessionName ? words.cloned(newSessionName) : words.clonedUnnamed);
	} catch (error: unknown) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

export type ParsedGoalContinueCommand =
	| { ok: true; maxTurns: number; maxStallTurns: number; maxWallClockMinutes: number }
	| { ok: false; error: string };

export interface GoalResumeHost {
	readonly session: {
		getGoalStateSnapshot: () => GoalState | undefined;
		saveGoalStateSnapshot: (state: GoalState, expected?: GoalStateRevision) => string;
		clearGoalStateSnapshot?: (state: GoalState, now: string) => string;
		restoreGoalRuntimeAfterResume: () => void;
	};
	refreshAutonomyFooterStatus(): void;
}

export interface GoalCommandHost extends GoalResumeHost {
	readonly session: GoalResumeHost["session"] & {
		continueGoalLoop: (options: GoalContinuationLoopOptions) => Promise<GoalContinuationLoopResult>;
		getGoalRuntimeSnapshot: (settings: {
			maxStallTurns: number;
		}) => ReturnType<AgentSession["getGoalRuntimeSnapshot"]>;
	};
	promptForGoalEdit?(currentObjective: string): Promise<string | undefined>;
	/** Keeps an owner correction of finished or given-up work as a candidate lesson; never holds the command. */
	recordLessonCandidate?(entry: {
		signal: "completed-goal-edited" | "blocked-requirement-reopened";
		goalId: string;
		goal: string;
		ownerWords?: string;
		hostGaps?: readonly string[];
	}): void;
	getMaxStallTurns?(): number;
	showStatus(message: string): void;
	showError(message: string): void;
}

export type GoalResumeResult =
	| { ok: true; resumed: true; state: GoalState }
	| { ok: false; error: string; refusal?: GoalActionRefusal };

/** Canonical persisted transition used by both `/goal resume` and session `/resume`. */
export function resumeCurrentGoal(host: GoalResumeHost, now = new Date().toISOString()): GoalResumeResult {
	const resumed = resumePersistedGoal(host.session, now);
	if (!resumed.ok) return resumed;
	host.session.restoreGoalRuntimeAfterResume();
	host.refreshAutonomyFooterStatus();
	return { ok: true, resumed: true, state: resumed.state };
}

/** A stop reason the host recorded as `machine_code: detail`, with the code in the owner's words. */
function plainStopReason(reason: string): string {
	return reason.replace(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+):/, (_match, code: string) => `${plainLabel(code)}:`);
}

function formatGoalStatus(snapshot: ReturnType<AgentSession["getGoalRuntimeSnapshot"]>): string {
	const words = interfaceText().sessions.goal;
	const state = snapshot.goalState;
	if (!state) return words.none;
	const requirements = state.requirements.map((requirement) =>
		words.requirement({
			id: requirement.id,
			status: requirement.status,
			blockedReason: requirement.blockedReason,
		}),
	);
	const blockedReason = state.blockedReason ? `\n${words.blockedReason(plainStopReason(state.blockedReason))}` : "";
	const autoContinue =
		snapshot.autoContinue === undefined ? "" : `\n${describeGoalAutoContinue(snapshot.autoContinue)}`;
	const requirementDetails = requirements.length > 0 ? `\n${requirements.join("\n")}` : "";
	const tokenUsage =
		state.tokenBudget !== undefined
			? `\n${words.tokens(state.tokensUsed ?? 0, state.tokenBudget)}`
			: (state.tokensUsed ?? 0) > 0
				? `\n${words.tokens(state.tokensUsed ?? 0)}`
				: "";
	return [
		words.head(state.userGoal),
		`${words.status(words.statusWords[state.status])}${blockedReason}${tokenUsage}`,
		`${words.counts({
			open: snapshot.continuation.openRequirementIds.length,
			blocked: snapshot.continuation.blockedRequirementIds.length,
			satisfied: snapshot.continuation.satisfiedRequirementIds.length,
		})}${requirementDetails}${autoContinue}`,
		words.controls,
	].join("\n");
}

/**
 * Direct editor controls that do not open a modal or launch another foreground turn.
 * This is delivery policy only; handleGoalCommand owns their lifecycle validation and persistence.
 */
const IMMEDIATE_GOAL_CONTROL_PATTERN =
	/^\/goal(?: +(?:status|resume|pause|complete|clear|close|cancel|reopen(?: +\S+)?))?$/;

export interface GoalEditorSubmitHost {
	readonly session: Pick<AgentSession, "isCompacting" | "isStreaming" | "isRetrying"> & {
		getSessionWorkState?: () => { busy: boolean };
	};
	readonly editor: Pick<EditorComponent, "setText">;
	handleGoalCommand(text: string): Promise<void>;
	showError(message: string): void;
}

/** Route owner controls before busy steering; explicit follow-ups stay literal while work is active. */
export async function tryHandleGoalEditorSubmit(
	text: string,
	queueAsFollowUp: boolean,
	host: GoalEditorSubmitHost,
): Promise<boolean> {
	if (text !== "/goal" && !text.startsWith("/goal ")) return false;
	const workIsActive =
		host.session.getSessionWorkState?.().busy ??
		(host.session.isCompacting || host.session.isStreaming || host.session.isRetrying);
	if (workIsActive && (queueAsFollowUp || !IMMEDIATE_GOAL_CONTROL_PATTERN.test(text))) return false;
	host.editor.setText("");
	try {
		await host.handleGoalCommand(text);
	} catch (error) {
		host.showError(interfaceText().sessions.goal.failed(error instanceof Error ? error.message : String(error)));
	}
	return true;
}

export async function handleGoalCommand(host: GoalCommandHost, text: string): Promise<void> {
	const words = interfaceText().sessions.goal;
	const input = text.replace(/^\/goal\s*/, "").trim();
	if (!input || input === "status") {
		host.showStatus(
			formatGoalStatus(host.session.getGoalRuntimeSnapshot({ maxStallTurns: host.getMaxStallTurns?.() ?? 20 })),
		);
		return;
	}

	const now = new Date().toISOString();
	const current = host.session.getGoalStateSnapshot();
	if (input === "resume") {
		const resumed = resumeCurrentGoal(host, now);
		if (!resumed.ok) {
			host.showError(refusedGoalActionText(resumed, words));
			return;
		}
		host.showStatus(words.resumed);
		return;
	}

	if (input === "pause") {
		const paused = pausePersistedGoal(host.session, now);
		if (!paused.ok) {
			host.showError(refusedGoalActionText(paused, words));
			return;
		}
		host.showStatus(words.paused);
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "edit" || input.startsWith("edit ")) {
		const inlineObjective = input.slice("edit".length).trim();
		const objective = inlineObjective || (current ? await host.promptForGoalEdit?.(current.userGoal) : undefined);
		if (!objective) {
			host.showError(current ? words.editUsage : words.nothingToEdit);
			return;
		}
		const edited = editPersistedGoal(host.session, { userGoal: objective }, now);
		if (!edited.ok) {
			host.showError(refusedGoalActionText(edited, words));
			return;
		}
		// Rewriting a goal the work called complete is the owner correcting finished work.
		if (current?.status === "completed") {
			host.recordLessonCandidate?.({
				signal: "completed-goal-edited",
				goalId: current.goalId,
				goal: current.userGoal,
				ownerWords: objective,
			});
		}
		if (isGoalExecutionActive(edited.state.status)) host.session.restoreGoalRuntimeAfterResume();
		host.showStatus(words.updated);
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "complete") {
		const completed = completeGoalManually(current, now);
		if (!completed.ok) {
			host.showError(refusedGoalActionText(completed, words));
			return;
		}
		host.session.saveGoalStateSnapshot(completed.state, current ? getGoalStateRevision(current) : undefined);
		host.showStatus(words.completed);
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "clear") {
		const cleared = clearPersistedGoal(host.session, now);
		if (!cleared.ok) {
			host.showError(refusedGoalActionText(cleared, words));
			return;
		}
		host.showStatus(cleared.cleared ? words.cleared : words.nothingToClear);
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "close" || input === "cancel") {
		const cancelled = cancelPersistedGoal(host.session, now);
		if (!cancelled.ok) {
			host.showError(refusedGoalActionText(cancelled, words));
			return;
		}
		host.showStatus(words.closed);
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "reopen" || input.startsWith("reopen ")) {
		const requirementId = input.slice("reopen".length).trim();
		if (!requirementId) {
			host.showError(words.reopenUsage);
			return;
		}
		if (!current) {
			host.showError(words.nothingToUpdate);
			return;
		}
		const requirement = current.requirements.find((candidate) => candidate.id === requirementId);
		if (requirement?.status !== "blocked") {
			host.showError(
				requirement
					? words.requirementNotBlocked(requirementId, requirement.status)
					: words.requirementUnknown(requirementId),
			);
			return;
		}
		let active = current;
		if (active.status === "blocked") {
			const resumed = resumeGoal(active, now);
			if (!resumed.ok) {
				host.showError(refusedGoalActionText(resumed, words));
				return;
			}
			active = resumed.state;
		}
		const reopened = applyGoalAction(active, { action: "reopen_requirement", requirementId }, now);
		if (!reopened.ok) {
			host.showError(refusedGoalActionText(reopened, words));
			return;
		}
		host.session.saveGoalStateSnapshot(reopened.state, getGoalStateRevision(current));
		// Reopening a requirement the work gave up on is the owner correcting that call.
		host.recordLessonCandidate?.({
			signal: "blocked-requirement-reopened",
			goalId: current.goalId,
			goal: current.userGoal,
			hostGaps: [`${requirement.id} blocked: ${requirement.blockedReason ?? "no reason recorded"}`],
		});
		if (isGoalExecutionActive(reopened.state.status)) host.session.restoreGoalRuntimeAfterResume();
		host.showStatus(words.requirementReopened(requirementId, current.status === "blocked"));
		host.refreshAutonomyFooterStatus();
		return;
	}

	const overriding = input === "override" || input.startsWith("override ");
	const goalText = overriding ? input.slice("override".length).trim() : input;
	if (!goalText) {
		host.showError(words.overrideUsage);
		return;
	}
	const goalId = `goal-${randomUUID()}`;
	const started = overriding
		? replaceGoal({ goalId, userGoal: goalText }, now)
		: applyGoalAction(current, { action: "start", goalId, userGoal: goalText }, now);
	if (!started.ok) {
		host.showError(`${refusedGoalActionText(started, words)}${words.overrideHint}`);
		return;
	}
	host.session.saveGoalStateSnapshot(started.state, current ? getGoalStateRevision(current) : undefined);
	const verb = overriding ? words.verbOverridden : words.verbStarted;
	try {
		// Submit one bootstrap pass, then yield to the event-driven idle scheduler. This is a scheduling
		// quantum, not a goal ceiling: an active goal is immediately rearmed and the configured goal turn
		// limit (unbounded by default) governs subsequent continuation.
		const result = await host.session.continueGoalLoop({
			maxTurns: 1,
			maxStallTurns: host.getMaxStallTurns?.() ?? 20,
			maxWallClockMinutes: 0,
		});
		if (result.stopReason === "already_continuing") {
			host.showStatus(words.alreadyContinuing(verb));
		} else if (result.stopReason === "session_disposed") {
			host.showStatus(words.disposedBeforeContinuation(verb));
		} else {
			const continuation = result.finalSnapshot.continuation;
			harnessLog.debug("ui", "a goal continuation decided", {
				action: continuation.action,
				reasonCode: continuation.reasonCode,
			});
			host.showStatus(
				words.started({
					verb,
					action: plainLabel(continuation.action),
					reason: plainLabel(continuation.reasonCode),
				}),
			);
			if (continuation.action === "continue") host.session.restoreGoalRuntimeAfterResume();
		}
	} catch (error) {
		host.showError(words.continuationFailed(error instanceof Error ? error.message : String(error)));
	} finally {
		host.refreshAutonomyFooterStatus();
	}
}

export interface TaskCommandHost {
	readonly session: {
		getTaskStepsStateSnapshot: () => TaskStepsState | undefined;
		saveTaskStepsStateSnapshot: (state: TaskStepsState) => string;
	};
	showStatus(message: string): void;
	showError(message: string): void;
}

export function handleTaskCommand(host: TaskCommandHost, text: string): void {
	const parsed = parseTaskCommand(text);
	if (!parsed.ok) {
		host.showError(parsed.error);
		return;
	}
	if (parsed.command.type === "retired_execution") {
		host.showStatus(interfaceText().sessions.task.retired(parsed.command.operation));
		return;
	}

	const now = new Date().toISOString();
	let state = host.session.getTaskStepsStateSnapshot() ?? createTaskStepsState(now);
	try {
		switch (parsed.command.type) {
			case "list":
				host.showStatus(formatTaskSteps(state, { includeTerminal: parsed.command.includeTerminal }));
				return;
			case "add":
				state = addTaskStep(state, { content: parsed.command.content }, now);
				break;
			case "update":
				state = updateTaskStep(
					state,
					parsed.command.selector,
					{
						status: parsed.command.status,
						note: parsed.command.note,
						evidence: parsed.command.evidence ? [parsed.command.evidence] : undefined,
					},
					now,
				);
				break;
			case "clear":
				state = clearTaskSteps(state, now);
				break;
			case "compact":
				state = compactTaskSteps(state, now);
				break;
		}
		host.session.saveTaskStepsStateSnapshot(state);
		host.showStatus(formatTaskSteps(state));
	} catch (error) {
		host.showError(error instanceof Error ? error.message : String(error));
	}
}

export interface GoalContinueCommandHost {
	readonly session: {
		continueGoalLoop: (options: GoalContinuationLoopOptions) => Promise<GoalContinuationLoopResult>;
	};
	parseGoalContinueCommand(text: string): ParsedGoalContinueCommand;
	showStatus(message: string): void;
	showError(message: string): void;
	refreshAutonomyFooterStatus(): void;
}

export async function handleGoalContinueCommand(host: GoalContinueCommandHost, text: string): Promise<void> {
	const words = interfaceText().sessions.goal;
	const parsed = host.parseGoalContinueCommand(text);
	if (!parsed.ok) {
		host.showError(parsed.error);
		return;
	}

	host.showStatus(
		words.continueStarted({
			turns: parsed.maxTurns === 0 ? words.unboundedTurns : words.upToTurns(parsed.maxTurns),
			stallTurns: parsed.maxStallTurns,
			wallClock: parsed.maxWallClockMinutes ? String(parsed.maxWallClockMinutes) : words.disabled,
		}),
	);
	try {
		const result = await host.session.continueGoalLoop({
			maxTurns: parsed.maxTurns,
			maxStallTurns: parsed.maxStallTurns,
			maxWallClockMinutes: parsed.maxWallClockMinutes,
		});
		const continuation = result.finalSnapshot.continuation;
		harnessLog.debug("ui", "a goal continuation loop stopped", {
			stopReason: result.stopReason,
			action: continuation.action,
			reasonCode: continuation.reasonCode,
		});
		host.showStatus(
			words.continueStopped({
				stopReason: plainLabel(result.stopReason),
				turns: result.turnsSubmitted,
				action: plainLabel(continuation.action),
				reason: plainLabel(continuation.reasonCode),
			}),
		);
	} catch (error) {
		host.showError(words.continuationFailed(error instanceof Error ? error.message : String(error)));
	} finally {
		host.refreshAutonomyFooterStatus();
	}
}

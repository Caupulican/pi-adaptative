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
import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model } from "@caupulican/pi-ai";
import type { EditorComponent } from "@caupulican/pi-tui";
import { type Component, type Container, Loader, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import type {
	AgentSession,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
} from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { hasCostSummarySignal } from "../../core/cost/cost-summary.ts";
import type { ExtensionCommandContext } from "../../core/extensions/index.ts";
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
import { type GoalState, isGoalExecutionActive } from "../../core/goals/goal-state.ts";
import { applyGoalAction, completeGoalManually } from "../../core/goals/goal-tool-core.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import {
	findExactModelReferenceMatch,
	resolveModelScope,
	resolveModelScopeWithDiagnostics,
} from "../../core/model-resolver.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import { listAllSessions, listSessions, openSession } from "../../core/session-manager-factory.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
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
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { keyText } from "./components/keybinding-hints.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import type { ExtensionUiHost } from "./extension-ui-host.ts";
import { formatCostReport } from "./report-commands.ts";
import { handleNonFatalSessionReplacementError } from "./session-replacement-errors.ts";
import { theme } from "./theme/theme.ts";

/** Shared seam for the interdependent selector/navigation flows. */
export interface SessionFlowHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
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
		await host.session.extensionRunner.emit({
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
			host.session.modelRegistry,
			host.session.scopedModels,
			async (model) => {
				try {
					await host.session.setModel(model);
					host.footer.invalidate();
					host.updateEditorBorderColor();
					done();
					host.showStatus(`Model: ${model.id}`);
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
					host.showStatus(`Default model: ${model.id}`);
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
	host.session.modelRegistry.refresh();
	const allModels = host.session.modelRegistry.getAvailable();
	const allModelIds = new Set(allModels.map((model) => `${model.provider}/${model.id}`));
	const configuredPatterns = host.settingsManager.getEnabledModels();
	const sessionScopedModels = host.session.scopedModels;

	if (allModels.length === 0 && !configuredPatterns?.length && sessionScopedModels.length === 0) {
		host.showStatus("No models available");
		return;
	}
	const configuredScope = configuredPatterns?.length
		? await resolveModelScopeWithDiagnostics(configuredPatterns, host.session.modelRegistry)
		: undefined;

	// Check if session has scoped models (from previous session-only changes or CLI --models)
	const hasSessionScope = sessionScopedModels.length > 0;

	// Build enabled model IDs from session state or settings
	let currentEnabledIds: string[] | null = null;

	if (hasSessionScope) {
		// Use current session's scoped models
		currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
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
			const newScopedModels = await resolveModelScope(enabledIds, host.session.modelRegistry);
			host.session.setScopedModels(
				newScopedModels.map((sm) => ({
					model: sm.model,
					thinkingLevel: sm.thinkingLevel,
				})),
			);
		} else {
			// All enabled or none enabled = no filter
			host.session.setScopedModels([]);
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
					host.showStatus("Model selection saved to settings");
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
	const userMessages = host.session.getUserMessagesForForking();

	if (userMessages.length === 0) {
		host.showStatus("No messages to fork from");
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
					host.editor.setText(result.selectedText ?? "");
					done();
					host.showStatus(newSessionName ? `Forked to new session: ${newSessionName}` : "Forked to new session");
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
	const tree = host.sessionManager.getTree();
	const realLeafId = host.sessionManager.getLeafId();
	const initialFilterMode = host.settingsManager.getTreeFilterMode();

	if (tree.length === 0) {
		host.showStatus("No entries in session");
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
					host.showStatus("Already at this point");
					return;
				}

				// Ask about summarization
				done(); // Close selector first

				// Loop until user makes a complete choice or cancels to tree
				let wantsSummary = false;
				let customInstructions: string | undefined;

				// Check if we should skip the prompt (user preference to always default to no summary)
				if (!host.settingsManager.getBranchSummarySkipPrompt()) {
					while (true) {
						const summaryChoice = await host.extensionUiHost.showExtensionSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector with same selection
							showTreeSelector(host, entryId);
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await host.extensionUiHost.showExtensionEditor(
								"Custom summarization instructions",
							);
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
						`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
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
						host.showStatus("Branch summarization cancelled");
						showTreeSelector(host, entryId);
						return;
					}
					if (result.cancelled) {
						host.showStatus("Navigation cancelled");
						return;
					}

					// Update UI
					await host.renderInitialMessages();
					if (result.editorText && !host.editor.getText().trim()) {
						host.editor.setText(result.editorText);
					}
					host.showStatus("Navigated to selected point");
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
				host.showStatus(
					`Saved trust decision: ${trusted ? "trusted" : "untrusted"}. Restart pi for this to take effect.`,
				);
			},
			onCancel: () => {
				finishSelectorCancellation(host, done);
			},
		});
		return { component: selector, focus: selector };
	});
}

export function showSessionSelector(host: SessionFlowHost): void {
	host.showSelector((done) => {
		const selector = new SessionSelectorComponent(
			(onProgress) => listSessions(host.sessionManager.getCwd(), host.sessionManager.getSessionDir(), onProgress),
			(onProgress) =>
				host.sessionManager.usesDefaultSessionDir()
					? listAllSessions(onProgress)
					: listAllSessions(host.sessionManager.getSessionDir(), onProgress),
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
				renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
					const next = (nextName ?? "").trim();
					if (!next) return;
					const mgr = openSession(sessionFilePath);
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
	if (state && isSystemBlockedGoal(state)) {
		const resumed = host.session.restoreGoalRuntimeAfterResume();
		if (resumed) {
			host.refreshAutonomyFooterStatus();
			return true;
		}
	}
	if (!state || (state.status !== "paused" && state.status !== "blocked" && state.status !== "usage_limited")) {
		host.session.restoreGoalRuntimeAfterResume();
		return false;
	}
	const choice = await host.extensionUiHost?.showExtensionSelector("Resume stopped goal?", [
		"Resume goal",
		"Leave stopped",
	]);
	if (choice !== "Resume goal") return false;
	const resumed = resumePersistedGoal(host.session);
	if (!resumed.ok) throw new Error(`Goal resume failed: ${resumed.error}`);
	host.session.restoreGoalRuntimeAfterResume();
	host.refreshAutonomyFooterStatus();
	return true;
}

export async function handleResumeSession(
	host: SessionFlowHost,
	sessionPath: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
): Promise<{ cancelled: boolean }> {
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
		host.showStatus(goalResumed ? "Resumed session and goal" : "Resumed session; goal state preserved");
		return result;
	} catch (error: unknown) {
		const disposition = handleNonFatalSessionReplacementError(host, error);
		if (disposition) return { cancelled: disposition === "previous_restored" };
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus("Resume cancelled");
				return { cancelled: true };
			}
			try {
				const result = await switchSession(host, sessionPath, options, selectedCwd);
				if (result.cancelled) {
					return result;
				}
				host.renderCurrentSessionState();
				const goalResumed = await offerRestoredGoalResume(host);
				host.showStatus(
					goalResumed
						? "Resumed session and goal in current cwd"
						: "Resumed session in current cwd; goal state preserved",
				);
				return result;
			} catch (retryError: unknown) {
				const retryDisposition = handleNonFatalSessionReplacementError(host, retryError);
				if (retryDisposition) return { cancelled: retryDisposition === "previous_restored" };
				return host.handleFatalRuntimeError("Failed to resume session", retryError);
			}
		}
		return host.handleFatalRuntimeError("Failed to resume session", error);
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
			host.showStatus(`Model: ${model.id}`);
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
	const currentLevel = host.session.thinkingLevel;
	const availableLevels = host.session.getAvailableThinkingLevels();
	if (availableLevels.length === 0) {
		host.showStatus("Current model does not support thinking");
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
				host.showStatus(`Thinking level set to ${level}`);
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
				host.showStatus(`Default thinking level set to ${level}`);
			},
		);
		return { component: selector, focus: selector };
	});
}

export async function handleThinkingCommand(host: SessionFlowHost, arg?: string): Promise<void> {
	if (!arg) {
		await showThinkingSelector(host);
		return;
	}

	const normalized = arg.trim().toLowerCase();
	const availableLevels = host.session.getAvailableThinkingLevels();
	if (availableLevels.length === 0) {
		host.showStatus("Current model does not support thinking");
		return;
	}

	if (availableLevels.includes(normalized as ThinkingLevel)) {
		host.session.setThinkingLevel(normalized as ThinkingLevel);
		host.footer.invalidate();
		host.updateEditorBorderColor();
		host.showStatus(`Thinking level set to ${normalized}`);
	} else {
		host.showError(`Invalid thinking level "${arg}". Valid levels: ${availableLevels.join(", ")}`);
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
	const leafId = host.sessionManager.getLeafId();
	if (!leafId) {
		host.showStatus("Nothing to clone yet");
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
		host.showStatus(newSessionName ? `Cloned to new session: ${newSessionName}` : "Cloned to new session");
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
	getMaxStallTurns?(): number;
	showStatus(message: string): void;
	showError(message: string): void;
}

export type GoalResumeResult = { ok: true; resumed: true; state: GoalState } | { ok: false; error: string };

/** Canonical persisted transition used by both `/goal resume` and session `/resume`. */
export function resumeCurrentGoal(host: GoalResumeHost, now = new Date().toISOString()): GoalResumeResult {
	const resumed = resumePersistedGoal(host.session, now);
	if (!resumed.ok) return resumed;
	host.session.restoreGoalRuntimeAfterResume();
	host.refreshAutonomyFooterStatus();
	return { ok: true, resumed: true, state: resumed.state };
}

function formatGoalStatus(snapshot: ReturnType<AgentSession["getGoalRuntimeSnapshot"]>): string {
	const state = snapshot.goalState;
	if (!state) return `Goal: none (${snapshot.continuation.action}/${snapshot.continuation.reasonCode})`;
	const requirements = state.requirements.map((requirement) => {
		const blockedReason = requirement.blockedReason ? ` — ${requirement.blockedReason}` : "";
		return `- ${requirement.id}: ${requirement.status}${blockedReason}`;
	});
	const blockedReason = state.blockedReason ? `\nBlocked reason: ${state.blockedReason}` : "";
	const requirementDetails = requirements.length > 0 ? `\n${requirements.join("\n")}` : "";
	const tokenUsage =
		state.tokenBudget !== undefined
			? `\nTokens: ${state.tokensUsed ?? 0}/${state.tokenBudget}`
			: (state.tokensUsed ?? 0) > 0
				? `\nTokens: ${state.tokensUsed ?? 0}`
				: "";
	return `Goal: ${state.userGoal}\nStatus: ${state.status}${blockedReason}${tokenUsage}\nRequirements: open ${snapshot.continuation.openRequirementIds.length}, blocked ${snapshot.continuation.blockedRequirementIds.length}, satisfied ${snapshot.continuation.satisfiedRequirementIds.length}${requirementDetails}\nContinuation: ${snapshot.continuation.action}/${snapshot.continuation.reasonCode}\nControls: /goal edit | /goal pause | /goal resume | /goal reopen <requirement-id> | /goal complete | /goal clear | /goal override <text>`;
}

/**
 * Direct editor controls that do not open a modal or launch another foreground turn.
 * This is delivery policy only; handleGoalCommand owns their lifecycle validation and persistence.
 */
const IMMEDIATE_GOAL_CONTROL_PATTERN =
	/^\/goal(?: +(?:status|resume|pause|complete|clear|close|cancel|reopen(?: +\S+)?))?$/;

export interface GoalEditorSubmitHost {
	readonly session: Pick<AgentSession, "isCompacting" | "isStreaming" | "isRetrying">;
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
	const workIsActive = host.session.isCompacting || host.session.isStreaming || host.session.isRetrying;
	if (workIsActive && (queueAsFollowUp || !IMMEDIATE_GOAL_CONTROL_PATTERN.test(text))) return false;
	host.editor.setText("");
	try {
		await host.handleGoalCommand(text);
	} catch (error) {
		host.showError(`Goal command failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return true;
}

export async function handleGoalCommand(host: GoalCommandHost, text: string): Promise<void> {
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
			host.showError(resumed.error);
			return;
		}
		host.showStatus("Goal resumed.");
		return;
	}

	if (input === "pause") {
		const paused = pausePersistedGoal(host.session, now);
		if (!paused.ok) {
			host.showError(paused.error);
			return;
		}
		host.showStatus("Goal paused.");
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "edit" || input.startsWith("edit ")) {
		const inlineObjective = input.slice("edit".length).trim();
		const objective = inlineObjective || (current ? await host.promptForGoalEdit?.(current.userGoal) : undefined);
		if (!objective) {
			host.showError(current ? "Usage: /goal edit <objective>" : "No goal exists to edit.");
			return;
		}
		const edited = editPersistedGoal(host.session, { userGoal: objective }, now);
		if (!edited.ok) {
			host.showError(edited.error);
			return;
		}
		if (isGoalExecutionActive(edited.state.status)) host.session.restoreGoalRuntimeAfterResume();
		host.showStatus("Goal updated.");
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "complete") {
		const completed = completeGoalManually(current, now);
		if (!completed.ok) {
			host.showError(completed.error);
			return;
		}
		host.session.saveGoalStateSnapshot(completed.state, current ? getGoalStateRevision(current) : undefined);
		host.showStatus("Goal completed manually.");
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "clear") {
		const cleared = clearPersistedGoal(host.session, now);
		if (!cleared.ok) {
			host.showError(cleared.error);
			return;
		}
		host.showStatus(cleared.cleared ? "Goal cleared." : "No goal exists to clear.");
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "close" || input === "cancel") {
		const cancelled = cancelPersistedGoal(host.session, now);
		if (!cancelled.ok) {
			host.showError(cancelled.error);
			return;
		}
		host.showStatus("Goal closed.");
		host.refreshAutonomyFooterStatus();
		return;
	}

	if (input === "reopen" || input.startsWith("reopen ")) {
		const requirementId = input.slice("reopen".length).trim();
		if (!requirementId) {
			host.showError("Usage: /goal reopen <requirement-id>");
			return;
		}
		if (!current) {
			host.showError("No goal exists to update.");
			return;
		}
		const requirement = current.requirements.find((candidate) => candidate.id === requirementId);
		if (requirement?.status !== "blocked") {
			host.showError(
				requirement
					? `Requirement '${requirementId}' is ${requirement.status}; only blocked requirements can be reopened.`
					: `Unknown requirement '${requirementId}'.`,
			);
			return;
		}
		let active = current;
		if (active.status === "blocked") {
			const resumed = resumeGoal(active, now);
			if (!resumed.ok) {
				host.showError(resumed.error);
				return;
			}
			active = resumed.state;
		}
		const reopened = applyGoalAction(active, { action: "reopen_requirement", requirementId }, now);
		if (!reopened.ok) {
			host.showError(reopened.error);
			return;
		}
		host.session.saveGoalStateSnapshot(reopened.state, getGoalStateRevision(current));
		if (isGoalExecutionActive(reopened.state.status)) host.session.restoreGoalRuntimeAfterResume();
		host.showStatus(
			`Requirement '${requirementId}' reopened${current.status === "blocked" ? " and goal resumed" : ""}.`,
		);
		host.refreshAutonomyFooterStatus();
		return;
	}

	const overriding = input === "override" || input.startsWith("override ");
	const goalText = overriding ? input.slice("override".length).trim() : input;
	if (!goalText) {
		host.showError("Usage: /goal override <text>");
		return;
	}
	const goalId = `goal-${randomUUID()}`;
	const started = overriding
		? replaceGoal({ goalId, userGoal: goalText }, now)
		: applyGoalAction(current, { action: "start", goalId, userGoal: goalText }, now);
	if (!started.ok) {
		host.showError(`${started.error} Use /goal override <text> to replace it explicitly.`);
		return;
	}
	host.session.saveGoalStateSnapshot(started.state, current ? getGoalStateRevision(current) : undefined);
	const verb = overriding ? "overridden" : "started";
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
			host.showStatus(`Goal ${verb}: the autonomy loop is already continuing this goal.`);
		} else if (result.stopReason === "session_disposed") {
			host.showStatus(`Goal ${verb}, but the session was disposed before continuation could run.`);
		} else {
			const continuation = result.finalSnapshot.continuation;
			host.showStatus(`Goal ${verb}: ${continuation.action}/${continuation.reasonCode}.`);
			if (continuation.action === "continue") host.session.restoreGoalRuntimeAfterResume();
		}
	} catch (error) {
		host.showError(`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`);
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
		host.showStatus(
			`/task ${parsed.command.operation} was retired with the detached extension runner. Ask Pi to use native delegate; session-owned worker lanes notify on completion without polling.`,
		);
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
	const parsed = host.parseGoalContinueCommand(text);
	if (!parsed.ok) {
		host.showError(parsed.error);
		return;
	}

	host.showStatus(
		`Goal continuation started: ${parsed.maxTurns === 0 ? "unbounded turns" : `up to ${parsed.maxTurns} turn(s)`}, recovery threshold ${parsed.maxStallTurns}, wall-clock limit ${parsed.maxWallClockMinutes || "disabled"} minute(s).`,
	);
	try {
		const result = await host.session.continueGoalLoop({
			maxTurns: parsed.maxTurns,
			maxStallTurns: parsed.maxStallTurns,
			maxWallClockMinutes: parsed.maxWallClockMinutes,
		});
		const continuation = result.finalSnapshot.continuation;
		host.showStatus(
			`Goal continuation stopped: ${result.stopReason}; submitted ${result.turnsSubmitted} turn(s); latest decision ${continuation.action}/${continuation.reasonCode}.`,
		);
	} catch (error) {
		host.showError(`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		host.refreshAutonomyFooterStatus();
	}
}

export interface SessionInfoCommandHost {
	readonly session: {
		getSessionStats: () => ReturnType<AgentSession["getSessionStats"]>;
		getCostSummary: () => ReturnType<AgentSession["getCostSummary"]>;
		getModelRouterStatus: (formatLabel: (label: string) => string) => string;
	};
	readonly sessionManager: { getSessionName: () => string | undefined };
	readonly chatContainer: Container;
	readonly ui: { requestRender: () => void };
}

export function handleSessionCommand(host: SessionInfoCommandHost): void {
	const stats = host.session.getSessionStats();
	const sessionName = host.sessionManager.getSessionName();

	let info = `${theme.bold("Session Info")}\n\n`;
	if (sessionName) {
		info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
	}
	info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
	info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
	info += `${theme.bold("Messages")}\n`;
	info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
	info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
	info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
	info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
	info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
	info += `${theme.bold("Tokens")}\n`;
	info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
	if (stats.tokens.cacheRead > 0) {
		info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
	}
	if (stats.tokens.cacheWrite > 0) {
		info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
	}
	info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

	const costs = host.session.getCostSummary();
	if (hasCostSummarySignal(costs)) {
		info += `\n${theme.bold("Cost")}\n`;
		info += formatCostReport(costs);
	}

	info += `\n\n${theme.bold("Model Router")}\n`;
	info += host.session.getModelRouterStatus((label) => theme.fg("dim", label));

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(info, 1, 0));
	host.ui.requestRender();
}

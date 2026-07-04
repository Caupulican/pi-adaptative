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

import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import type { EditorComponent } from "@caupulican/pi-tui";
import { type Component, type Container, Loader, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import type {
	AgentSession,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
} from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionCommandContext } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import { listAllSessions, listSessions, openSession } from "../../core/session-manager-factory.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { keyText } from "./components/keybinding-hints.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import type { ExtensionUiHost } from "./extension-ui-host.ts";
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
	renderCurrentSessionState(): void;
	renderInitialMessages(options?: { forceHistoryLoad?: boolean }): Promise<void>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	updateEditorBorderColor(): void;
	updateAvailableProviderCount(): Promise<void>;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<any>): Promise<void>;
	checkDaxnutsEasterEgg(model: { provider: string; id: string }): void;
	getModelCandidates(): Promise<Model<any>[]>;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;
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
					done();
					host.showError(error instanceof Error ? error.message : String(error));
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
			initialSearchInput,
		);
		return { component: selector, focus: selector };
	});
}

export async function showModelsSelector(host: SessionFlowHost): Promise<void> {
	// Get all available models
	host.session.modelRegistry.refresh();
	const allModels = host.session.modelRegistry.getAvailable();

	if (allModels.length === 0) {
		host.showStatus("No models available");
		return;
	}

	// Check if session has scoped models (from previous session-only changes or CLI --models)
	const sessionScopedModels = host.session.scopedModels;
	const hasSessionScope = sessionScopedModels.length > 0;

	// Build enabled model IDs from session state or settings
	let currentEnabledIds: string[] | null = null;

	if (hasSessionScope) {
		// Use current session's scoped models
		currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
	} else {
		// Fall back to settings
		const patterns = host.settingsManager.getEnabledModels();
		if (patterns !== undefined && patterns.length > 0) {
			const scopedModels = await resolveModelScope(patterns, host.session.modelRegistry);
			currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		}
	}

	// Helper to update session's scoped models (session-only, no persist)
	const updateSessionModels = async (enabledIds: string[] | null) => {
		currentEnabledIds = enabledIds === null ? null : [...enabledIds];
		if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
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
					const newPatterns =
						enabledIds === null || enabledIds.length === allModels.length
							? undefined // All enabled = clear filter
							: enabledIds;
					host.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
					host.showStatus("Model selection saved to settings");
				},
				onCancel: () => {
					done();
					host.ui.requestRender();
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
						done();
						host.ui.requestRender();
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
					done();
					host.showError(error instanceof Error ? error.message : String(error));
				}
			},
			() => {
				done();
				host.ui.requestRender();
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
				done();
				host.ui.requestRender();
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
				done();
				host.ui.requestRender();
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
				done();
				host.ui.requestRender();
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
		const result = await host.runtimeHost.switchSession(sessionPath, {
			withSession: options?.withSession,
		});
		if (result.cancelled) {
			return result;
		}
		host.renderCurrentSessionState();
		host.showStatus("Resumed session");
		return result;
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus("Resume cancelled");
				return { cancelled: true };
			}
			const result = await host.runtimeHost.switchSession(sessionPath, {
				cwdOverride: selectedCwd,
				withSession: options?.withSession,
			});
			if (result.cancelled) {
				return result;
			}
			host.renderCurrentSessionState();
			host.showStatus("Resumed session in current cwd");
			return result;
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

export async function findExactModelMatch(host: SessionFlowHost, searchTerm: string): Promise<Model<any> | undefined> {
	const models = await host.getModelCandidates();
	return findExactModelReferenceMatch(searchTerm, models);
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
		`Goal continuation started: up to ${parsed.maxTurns} turn(s), stall limit ${parsed.maxStallTurns}, wall-clock limit ${parsed.maxWallClockMinutes || "disabled"} minute(s).`,
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
		getDailyUsageTotals: () => ReturnType<AgentSession["getDailyUsageTotals"]>;
		getDailyUsageBreakdown: (formatLabel: (label: string) => string) => string;
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

	const dailyUsage = host.session.getDailyUsageTotals();
	if (stats.cost > 0 || dailyUsage.totalCost > 0) {
		info += `\n${theme.bold("Cost")}\n`;
		info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(4)}\n`;
		info += `${host.session.getDailyUsageBreakdown((label) => theme.fg("dim", label))}`;
	}

	info += `\n\n${theme.bold("Model Router")}\n`;
	info += host.session.getModelRouterStatus((label) => theme.fg("dim", label));

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(info, 1, 0));
	host.ui.requestRender();
}

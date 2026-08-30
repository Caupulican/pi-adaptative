import type { AgentMessage, ToolCallRepairInfo } from "@caupulican/pi-agent-core";
import { createCompactionSummaryMessage } from "@caupulican/pi-agent-core/messages";
import type { AssistantMessage } from "@caupulican/pi-ai";
import {
	type Container,
	type Loader,
	type LoaderIndicatorOptions,
	type MarkdownTheme,
	Spacer,
	Text,
	type TUI,
} from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionEvent } from "../../core/agent-session-contracts.ts";
import type { FooterDataProvider } from "../../core/footer-data-provider.ts";
import { latestAssistantCommentaryLabel } from "../../core/message-phase.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { ActiveToolCallRegistry } from "./components/active-tool-call-registry.ts";
import {
	type ActivityLaneComponent,
	type ActivityLaneKind,
	BACKGROUND_TOOL_ACTIVITY_ID_PREFIX,
	backgroundToolActivityId,
} from "./components/activity-lane.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { keyText } from "./components/keybinding-hints.ts";
import type { MarkdownTransformFn } from "./components/markdown-transform.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import { theme } from "./theme/theme.ts";

/** Structural host consumed by the event owner. InteractiveMode deliberately remains a thin facade. */
export interface InteractiveEventHost {
	isInitialized: boolean;
	session: AgentSession;
	settingsManager: SettingsManager;
	footer: FooterComponent;
	footerDataProvider: FooterDataProvider;
	ui: TUI;
	defaultEditor: CustomEditor;
	statusContainer: Container;
	chatContainer: Container;
	activityLane: ActivityLaneComponent | undefined;
	loadingAnimation: Loader | undefined;
	workingVisible: boolean;
	workingIndicatorOptions: LoaderIndicatorOptions | undefined;
	retryEscapeHandler: (() => void) | undefined;
	retryCountdown: CountdownTimer | undefined;
	autoCompactionEscapeHandler: (() => void) | undefined;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	hideThinkingBlock: boolean;
	lastStreamingUiUpdateAt: number;
	activeToolCalls: ActiveToolCallRegistry;
	init(): Promise<void>;
	createWorkingLoader(): Loader;
	stopWorkingLoader(): void;
	clearActiveToolCalls(): void;
	getWorkingLoaderMessage(): string;
	updatePendingMessagesDisplay(): void;
	updateTerminalTitle(): void;
	refreshActivityLane(): void;
	updateEditorBorderColor(): void;
	showWarning(message: string): void;
	showError(message: string): void;
	addMessageToChat(message: AgentMessage): void;
	clearPendingStreamingUiUpdate(): void;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	transformMarkdownForDisplay: MarkdownTransformFn;
	applyStreamingMessageUpdate(message: AssistantMessage, options?: { force?: boolean }): void;
	updateRuntimeStatus(message?: AssistantMessage): void;
	trimLiveTuiHistory(): void;
	attachToolExecutionComponent(
		toolName: string,
		toolCallId: string,
		args: unknown,
		repair?: ToolCallRepairInfo,
	): ToolExecutionComponent;
	toolActivityKind(toolName: string): ActivityLaneKind;
	toolActivityLabel(toolName: string): string;
	toolActivityTerminalStatus(isError: boolean, details: unknown): "success" | "failure" | "neutral";
	isNativeReflectionEnabled(): boolean;
	maybeRunNativeReflection(messages: AgentMessage[]): void;
	maybeStartAutoLearn(): boolean;
	maybeStartAutonomyReview(messages: AgentMessage[]): boolean;
	checkShutdownRequested(): Promise<void>;
	rebuildChatFromMessages(): Promise<void>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
}

function clearRetryControls(host: InteractiveEventHost): void {
	if (host.retryEscapeHandler) {
		host.defaultEditor.onEscape = host.retryEscapeHandler;
		host.retryEscapeHandler = undefined;
	}
	if (host.retryCountdown) {
		host.retryCountdown.dispose();
		host.retryCountdown = undefined;
	}
}

function updateCommentaryActivity(host: InteractiveEventHost, message: AssistantMessage): void {
	const label = latestAssistantCommentaryLabel(message);
	if (label) host.activityLane?.update("runtime:turn", label);
}

/** Single owner for AgentSessionEvent -> terminal UI state transitions. */
export async function handleInteractiveEvent(host: InteractiveEventHost, event: AgentSessionEvent): Promise<void> {
	if (!host.isInitialized) await host.init();
	host.footer.invalidate();

	switch (event.type) {
		case "routing_start":
			if (!host.session.isStreaming && !host.loadingAnimation && host.workingVisible) {
				if (host.workingIndicatorOptions) {
					host.loadingAnimation = host.createWorkingLoader();
					host.statusContainer.addChild(host.loadingAnimation);
				} else {
					host.activityLane?.start({ id: "runtime:routing", kind: "runtime", label: "Routing" });
				}
				host.ui.requestRender();
			}
			break;

		case "routing_end":
			host.stopWorkingLoader();
			host.ui.requestRender();
			break;

		case "agent_start":
			host.clearActiveToolCalls();
			if (host.settingsManager.getShowTerminalProgress()) host.ui.terminal.setProgress(true);
			clearRetryControls(host);
			host.activityLane?.remove("runtime:retry");
			host.stopWorkingLoader();
			if (host.workingVisible) {
				if (host.workingIndicatorOptions) {
					host.loadingAnimation = host.createWorkingLoader();
					host.statusContainer.addChild(host.loadingAnimation);
				} else {
					host.activityLane?.start({
						id: "runtime:turn",
						kind: "runtime",
						label: host.getWorkingLoaderMessage(),
					});
				}
			}
			host.ui.requestRender();
			break;

		case "queue_update":
			host.updatePendingMessagesDisplay();
			host.ui.requestRender();
			break;

		case "session_info_changed":
			host.updateTerminalTitle();
			host.refreshActivityLane();
			host.footer.invalidate();
			host.ui.requestRender();
			break;

		case "thinking_level_changed":
			host.footer.invalidate();
			host.updateEditorBorderColor();
			break;

		case "warning":
			// AgentSession warnings are operational diagnostics. Keep them in the transient status lane;
			// direct local UI validation still uses InteractiveMode.showWarning() and remains chat-local.
			host.activityLane?.announce(event.message, "warning");
			break;

		case "delegate_workers":
			host.footerDataProvider.setExtensionStatus("delegate", undefined);
			host.refreshActivityLane();
			host.footer.invalidate();
			break;

		case "background_tools":
			host.activityLane?.removeByPrefix(BACKGROUND_TOOL_ACTIVITY_ID_PREFIX);
			for (const task of event.tasks) {
				host.activityLane?.start({
					id: backgroundToolActivityId(task.taskId),
					kind: "tool",
					label: task.description.trim() || `${task.toolName} · ${task.taskId}`,
					tag: task.toolName,
				});
			}
			host.ui.requestRender();
			break;

		case "message_start":
			if (event.message.role === "custom") {
				host.addMessageToChat(event.message);
				host.ui.requestRender();
			} else if (event.message.role === "user") {
				host.addMessageToChat(event.message);
				host.updatePendingMessagesDisplay();
				host.ui.requestRender();
			} else if (event.message.role === "assistant") {
				host.clearPendingStreamingUiUpdate();
				host.lastStreamingUiUpdateAt = 0;
				host.streamingComponent = new AssistantMessageComponent(
					undefined,
					host.hideThinkingBlock,
					host.getMarkdownThemeWithSettings(),
					{ isStreaming: true, transformMarkdown: host.transformMarkdownForDisplay },
				);
				host.streamingMessage = event.message;
				host.chatContainer.addChild(host.streamingComponent);
				updateCommentaryActivity(host, host.streamingMessage);
				host.applyStreamingMessageUpdate(host.streamingMessage, { force: true });
				host.trimLiveTuiHistory();
			}
			break;

		case "message_update":
			if (host.streamingComponent && event.message.role === "assistant") {
				updateCommentaryActivity(host, event.message);
				host.applyStreamingMessageUpdate(event.message);
			}
			break;

		case "message_end":
			if (event.message.role === "user") break;
			if (host.streamingComponent && event.message.role === "assistant") {
				const streamingComponent = host.streamingComponent;
				host.streamingMessage = event.message;
				updateCommentaryActivity(host, host.streamingMessage);
				let errorMessage: string | undefined;
				if (host.streamingMessage.stopReason === "aborted") {
					const retryAttempt = host.session.retryAttempt;
					errorMessage =
						retryAttempt > 0
							? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
							: "Operation aborted";
					host.streamingMessage.errorMessage = errorMessage;
				}
				// Mark final before the last (force) render so this update's markdown transforms see
				// isStreaming:false, matching the message's now-complete state.
				streamingComponent.setStreaming(false);
				host.applyStreamingMessageUpdate(host.streamingMessage, { force: true });
				if (host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") {
					errorMessage ??= host.streamingMessage.errorMessage || "Error";
					for (const [, component] of host.activeToolCalls.activeEntries()) {
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					}
					host.clearActiveToolCalls();
				} else {
					for (const [, component] of host.activeToolCalls.activeEntries()) component.setArgsComplete();
				}
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
				host.footer.invalidate();
			}
			host.ui.requestRender();
			break;

		case "tool_execution_start": {
			host.updateRuntimeStatus();
			host.activityLane?.start({
				id: `tool:${event.toolCallId}`,
				kind: host.toolActivityKind(event.toolName),
				label: host.toolActivityLabel(event.toolName),
				tag: event.toolName,
			});
			let component = host.activeToolCalls.getActive(event.toolCallId);
			if (!component) {
				component = host.attachToolExecutionComponent(event.toolName, event.toolCallId, event.args, event.repair);
			} else {
				component.updateArgs(event.args, event.repair);
			}
			component.markExecutionStarted(event.repair);
			host.ui.requestRender();
			break;
		}

		case "tool_execution_update": {
			const component = host.activeToolCalls.getActive(event.toolCallId);
			if (component) {
				component.updateArgs(event.args, event.repair);
				component.updateResult({ ...event.partialResult, isError: false }, true);
				host.ui.requestRender();
			}
			break;
		}

		case "tool_execution_end": {
			const toolActivityId = `tool:${event.toolCallId}`;
			if (host.activityLane) {
				const toolKind = host.toolActivityKind(event.toolName);
				const terminalStatus = host.toolActivityTerminalStatus(event.isError, event.result.details);
				if (toolKind === "tool" || terminalStatus !== "success") {
					host.activityLane.finish(toolActivityId, terminalStatus, {
						id: toolActivityId,
						kind: toolKind,
						label: host.toolActivityLabel(event.toolName),
					});
				} else {
					host.activityLane.remove(toolActivityId);
				}
			}
			const component = host.activeToolCalls.getActive(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError });
				host.activeToolCalls.finish(event.toolCallId);
				host.ui.requestRender();
			}
			if (["task_steps", "goal", "delegate"].includes(event.toolName)) {
				host.refreshActivityLane();
			}
			break;
		}

		case "agent_end": {
			if (host.isNativeReflectionEnabled()) host.maybeRunNativeReflection(event.messages);
			else if (!host.maybeStartAutoLearn()) host.maybeStartAutonomyReview(event.messages);
			if (host.settingsManager.getShowTerminalProgress()) host.ui.terminal.setProgress(false);
			if (event.willRetry) {
				host.activityLane?.remove("runtime:turn");
			} else {
				const finalAssistant = event.messages.findLast(
					(message): message is AssistantMessage => message.role === "assistant",
				);
				const failed = finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted";
				host.activityLane?.finish("runtime:turn", failed ? "failure" : "success", {
					id: "runtime:turn",
					kind: "runtime",
					label: failed ? "Turn failed" : "Done",
				});
			}
			if (host.loadingAnimation) {
				host.loadingAnimation.stop();
				host.loadingAnimation = undefined;
				host.statusContainer.clear();
			}
			if (host.streamingComponent) {
				host.chatContainer.removeChild(host.streamingComponent);
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
			}
			host.clearActiveToolCalls();
			host.activityLane?.removeByPrefix("tool:");
			await host.checkShutdownRequested();
			host.ui.requestRender();
			break;
		}

		case "compaction_start": {
			if (host.settingsManager.getShowTerminalProgress()) host.ui.terminal.setProgress(true);
			host.autoCompactionEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortCompaction();
			host.stopWorkingLoader();
			const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
			const label =
				event.reason === "manual"
					? `Compacting context ${cancelHint}`
					: `${event.reason === "overflow" ? "Context overflow · " : ""}Auto-compacting ${cancelHint}`;
			host.activityLane?.start({ id: "runtime:compaction", kind: "runtime", label });
			host.ui.requestRender();
			break;
		}

		case "compaction_end": {
			if (host.settingsManager.getShowTerminalProgress()) host.ui.terminal.setProgress(false);
			if (host.autoCompactionEscapeHandler) {
				host.defaultEditor.onEscape = host.autoCompactionEscapeHandler;
				host.autoCompactionEscapeHandler = undefined;
			}
			if (event.aborted) {
				host.activityLane?.finish("runtime:compaction", "neutral", {
					id: "runtime:compaction",
					kind: "runtime",
					label: "Compaction cancelled",
				});
				if (event.reason === "manual") host.showError("Compaction cancelled");
			} else if (event.result) {
				host.activityLane?.finish("runtime:compaction", "success", {
					id: "runtime:compaction",
					kind: "runtime",
					label: "Context compacted",
				});
				await host.rebuildChatFromMessages();
				host.addMessageToChat(
					createCompactionSummaryMessage(
						event.result.summary,
						event.result.tokensBefore,
						new Date().toISOString(),
					),
				);
				host.footer.invalidate();
			} else if (event.errorMessage) {
				host.activityLane?.finish("runtime:compaction", "failure", {
					id: "runtime:compaction",
					kind: "runtime",
					label: "Compaction failed",
				});
				if (event.reason === "manual") host.showError(event.errorMessage);
				else {
					host.chatContainer.addChild(new Spacer(1));
					host.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
				}
			} else if (event.skipReason) {
				host.activityLane?.finish("runtime:compaction", "neutral", {
					id: "runtime:compaction",
					kind: "runtime",
					label: `Compaction skipped · ${event.skipReason}`,
				});
			}
			void host.flushCompactionQueue({ willRetry: event.willRetry });
			host.ui.requestRender();
			break;
		}

		case "auto_retry_start": {
			host.retryEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => host.session.abortRetry();
			host.retryCountdown?.dispose();
			const retryMessage = (seconds: number) =>
				`Retry ${event.attempt}/${event.maxAttempts} in ${seconds}s · ${keyText("app.interrupt")} cancel`;
			host.activityLane?.wait({
				id: "runtime:retry",
				kind: "runtime",
				label: retryMessage(Math.ceil(event.delayMs / 1000)),
			});
			host.retryCountdown = new CountdownTimer(
				event.delayMs,
				host.ui,
				(seconds) => host.activityLane?.update("runtime:retry", retryMessage(seconds)),
				() => {
					host.retryCountdown = undefined;
				},
			);
			host.ui.requestRender();
			break;
		}

		case "auto_retry_end":
			clearRetryControls(host);
			host.activityLane?.finish("runtime:retry", event.success ? "success" : "failure", {
				id: "runtime:retry",
				kind: "runtime",
				label: event.success ? "Retry resumed" : "Retry failed",
			});
			if (!event.success) {
				host.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			host.ui.requestRender();
			break;
	}
}

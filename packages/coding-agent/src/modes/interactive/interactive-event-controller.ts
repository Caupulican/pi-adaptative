import type { AssistantMessage } from "@caupulican/pi-ai";
import { isFirstTokenEvent } from "@caupulican/pi-ai/event-stream";
import { type Container, type Loader, type MarkdownTheme, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionEvent } from "../../core/agent-session-contracts.ts";
import { expandArgumentsForDisplay, expandMessageTextForDisplay } from "../../core/context/path-alias-display.ts";
import type { FooterDataProvider } from "../../core/footer-data-provider.ts";
import { latestAssistantCommentaryLabel } from "../../core/message-phase.ts";
import { getToolCallRepairInfo } from "../../kernel/agent-loop.ts";
import { type AgentMessage, retainedToolInvocation, type ToolCallRepairInfo } from "../../kernel/index.ts";
import type { SessionManager } from "../../kernel/node.ts";
import { keyText } from "../../presentation/keybinding-hints.ts";
import { theme } from "../../presentation/theme-model.ts";
import type { ActiveToolCallRegistry } from "./components/active-tool-call-registry.ts";
import {
	type ActivityLaneComponent,
	type ActivityLaneKind,
	BACKGROUND_TOOL_ACTIVITY_ID_PREFIX,
	backgroundToolActivityId,
	RUNTIME_TURN_ACTIVITY_ID,
} from "./components/activity-lane.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import type { MarkdownTransformFn } from "./components/markdown-transform.ts";
import { type ReplyBylineTracker, replyByline, replyModelRef } from "./components/reply-byline.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import { type MisalignmentBlock, misalignmentBlock } from "./misalignment-continuation.ts";
import type { RuntimeStatusController } from "./runtime-status-controller.ts";
import type { WorkbenchController } from "./workbench-controller.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface InteractiveEventControllerSettingsSource {
	getShowTerminalProgress(): boolean;
}

/** What the event controller needs from the interactive host; the streaming reply and retry/compaction escape state it owns itself. */
export interface InteractiveEventPort {
	readonly hasHumanAudience: boolean;
	readonly ui: TUI;
	readonly footer: FooterComponent;
	readonly footerDataProvider: FooterDataProvider;
	readonly defaultEditor: CustomEditor;
	readonly statusContainer: Container;
	readonly chatContainer: Container;
	readonly activityLane: ActivityLaneComponent | undefined;
	/** Owns the working loader (`loadingAnimation`) and the working-visibility state this controller reads and drives. */
	readonly runtimeStatus: RuntimeStatusController;
	readonly replyBylines: ReplyBylineTracker;
	readonly activeToolCalls: ActiveToolCallRegistry;
	getSession(): AgentSession;
	getSessionManager(): SessionManager;
	getSettings(): InteractiveEventControllerSettingsSource;
	getWorkbench(): WorkbenchController | undefined;
	isInitialized(): boolean;
	isThinkingHidden(): boolean;
	init(): Promise<void>;
	clearActiveToolCalls(): void;
	updatePendingMessagesDisplay(): void;
	updateTerminalTitle(): void;
	refreshActivityLane(): void;
	updateEditorBorderColor(): void;
	showError(message: string): void;
	addMessageToChat(message: AgentMessage): void;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	transformMarkdownForDisplay: MarkdownTransformFn;
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
	/** A Codex misalignment block with an explanation and a steer: the owner may continue past it. */
	offerMisalignmentContinuation(block: MisalignmentBlock): void;
	checkShutdownRequested(): Promise<void>;
	/**
	 * Rebuild the visible chat from session context. When `checkpointWhenDeferred` is set and TUI
	 * history has not been loaded, render the provider context (the checkpoint) instead of the
	 * hidden-history placeholder or the pre-compaction turns.
	 */
	rebuildChatFromMessages(options?: { checkpointWhenDeferred?: boolean }): Promise<boolean>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
}

const STREAMING_UI_UPDATE_INTERVAL_MS = 80;

/**
 * Single owner for AgentSessionEvent -> terminal UI state transitions. Owns the streaming reply being
 * drawn (component, message, throttle clock and timer) and the escape handlers it swaps in during retry
 * and compaction; only this class writes them.
 */
export class InteractiveEventController {
	private readonly port: InteractiveEventPort;
	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingMessage: AssistantMessage | undefined;
	private streamingUiUpdateTimer: ReturnType<typeof setTimeout> | undefined;
	private lastStreamingUiUpdateAt = 0;
	private retryEscapeHandler: (() => void) | undefined;
	private retryCountdown: CountdownTimer | undefined;
	private autoCompactionEscapeHandler: (() => void) | undefined;

	constructor(port: InteractiveEventPort) {
		this.port = port;
	}

	getStreamingComponent(): AssistantMessageComponent | undefined {
		return this.streamingComponent;
	}

	getStreamingMessage(): AssistantMessage | undefined {
		return this.streamingMessage;
	}

	/** Forgets the streaming reply when the transcript it was drawn into is replaced. */
	discardStreaming(): void {
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
	}

	/** The working loader belongs to RuntimeStatusController; this is the controller's view of it. */
	private get loadingAnimation(): Loader | undefined {
		return this.port.runtimeStatus.loadingAnimation;
	}

	private set loadingAnimation(value: Loader | undefined) {
		this.port.runtimeStatus.loadingAnimation = value;
	}

	private clearRetryControls(): void {
		if (this.retryEscapeHandler) {
			this.port.defaultEditor.onEscape = this.retryEscapeHandler;
			this.retryEscapeHandler = undefined;
		}
		if (this.retryCountdown) {
			this.retryCountdown.dispose();
			this.retryCountdown = undefined;
		}
	}

	private updateCommentaryActivity(message: AssistantMessage): void {
		const label = latestAssistantCommentaryLabel(message);
		if (label) this.port.activityLane?.update("runtime:turn", label);
	}

	private clearPendingStreamingUiUpdate(): void {
		if (!this.streamingUiUpdateTimer) return;
		clearTimeout(this.streamingUiUpdateTimer);
		this.streamingUiUpdateTimer = undefined;
	}

	/**
	 * @param argumentsComplete whether the tool call's arguments have finished streaming. Alias
	 * expansion walks the whole argument payload, and this runs once per streamed chunk (a tool call
	 * bypasses the UI update throttle), so expanding mid-stream is O(chunks x payload) — a 1MB write
	 * cost 2.2s of UI work. Partial arguments are also mid-token, so expanding them is meaningless:
	 * the value is only final, and only worth expanding, once the message ends.
	 */
	private attachStreamingToolActions(message: AssistantMessage, argumentsComplete: boolean): void {
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const repair = getToolCallRepairInfo(content);
			const args = argumentsComplete
				? expandArgumentsForDisplay(this.port.getSession().peekPathAliasTable(), content.arguments)
				: content.arguments;
			if (!this.port.activeToolCalls.hasActive(content.id)) {
				this.port.attachToolExecutionComponent(content.name, content.id, args, repair);
			} else {
				const component = this.port.activeToolCalls.getActive(content.id);
				if (component) {
					component.updateArgs(args, repair);
				}
			}
		}
	}

	private applyStreamingMessageUpdate(message: AssistantMessage, options: { force?: boolean } = {}): void {
		this.streamingMessage = message;
		this.port.runtimeStatus.updateRuntimeStatus(message);
		if (!this.streamingComponent) return;

		const now = performance.now();
		const elapsed = now - this.lastStreamingUiUpdateAt;
		const hasToolCall = message.content.some((content) => content.type === "toolCall");
		const shouldUpdateNow = options.force || hasToolCall || elapsed >= STREAMING_UI_UPDATE_INTERVAL_MS;

		// `force` marks the message_start and message_end updates; only at message_end are a tool
		// call's arguments complete. Every other update is a mid-stream chunk.
		const argumentsComplete = options.force === true;
		const update = () => {
			if (!this.streamingComponent || !this.streamingMessage) return;
			// Recomputed from the raw accumulated message on every call, never cached or expanded
			// incrementally: an alias split across chunk boundaries renders literally for one update
			// and self-heals on the next. `this.streamingMessage` is never reassigned here — at
			// message_end it is the live history object (session state must keep raw aliases
			// forever), so only this local, freshly-built copy is ever handed to rendering.
			const displayMessage = expandMessageTextForDisplay(
				this.port.getSession().peekPathAliasTable(),
				this.streamingMessage,
			);
			this.streamingComponent.updateContent(displayMessage);
			this.attachStreamingToolActions(displayMessage, argumentsComplete);
			this.lastStreamingUiUpdateAt = performance.now();
			this.port.ui.requestRender();
		};

		if (shouldUpdateNow) {
			this.clearPendingStreamingUiUpdate();
			update();
			return;
		}

		if (this.streamingUiUpdateTimer) return;
		this.streamingUiUpdateTimer = setTimeout(
			() => {
				this.streamingUiUpdateTimer = undefined;
				update();
			},
			Math.max(0, STREAMING_UI_UPDATE_INTERVAL_MS - elapsed),
		);
	}

	async handle(event: AgentSessionEvent): Promise<void> {
		if (!this.port.isInitialized()) await this.port.init();
		this.port.footer.invalidate();

		switch (event.type) {
			case "routing_start":
				if (
					!this.port.getSession().isStreaming &&
					!this.loadingAnimation &&
					this.port.runtimeStatus.isWorkingVisible
				) {
					if (this.port.runtimeStatus.indicatorOptions) {
						this.loadingAnimation = this.port.runtimeStatus.createWorkingLoader();
						this.port.statusContainer.addChild(this.loadingAnimation);
					} else {
						this.port.activityLane?.start({ id: "runtime:routing", kind: "runtime", label: "Routing" });
					}
					this.port.ui.requestRender();
				}
				break;

			case "routing_end":
				this.port.activityLane?.remove("runtime:routing");
				if (
					!this.port.getSession().isStreaming &&
					this.loadingAnimation &&
					!this.port.getSession().getSessionWorkState().busy
				)
					this.port.runtimeStatus.stopWorkingLoader();
				this.port.ui.requestRender();
				break;

			case "agent_start": {
				const activity = this.port.getSession().getSessionWorkState();
				if (activity.busy && activity.epoch !== undefined) {
					this.port.getWorkbench()?.beginCycle(this.port.getSessionManager().getCwd(), activity.epoch);
				}
				this.port.activityLane?.syncForegroundActivity({ ...activity, sessionId: activity.sessionId ?? "unknown" });
				this.port.activityLane?.update(RUNTIME_TURN_ACTIVITY_ID, this.port.runtimeStatus.getWorkingLoaderMessage());
				this.port.clearActiveToolCalls();
				if (this.port.getSettings().getShowTerminalProgress()) this.port.ui.terminal.setProgress(true);
				this.clearRetryControls();
				this.port.activityLane?.remove("runtime:retry");
				if (this.port.runtimeStatus.isWorkingVisible) {
					if (this.port.runtimeStatus.indicatorOptions) {
						if (!this.loadingAnimation) {
							this.loadingAnimation = this.port.runtimeStatus.createWorkingLoader();
							this.port.statusContainer.addChild(this.loadingAnimation);
						}
					}
				}
				this.port.ui.requestRender();
				break;
			}

			case "queue_update":
				this.port.updatePendingMessagesDisplay();
				this.port.ui.requestRender();
				break;

			case "session_info_changed":
				this.port.updateTerminalTitle();
				this.port.refreshActivityLane();
				this.port.footer.invalidate();
				this.port.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.port.footer.invalidate();
				this.port.updateEditorBorderColor();
				break;

			case "warning":
				// AgentSession warnings are operational diagnostics. Keep them in the transient status lane;
				// direct local UI validation still uses InteractiveMode.showWarning() and remains chat-local.
				this.port.activityLane?.announce(event.message, "warning");
				break;

			case "delegate_workers":
				this.port.footerDataProvider.setExtensionStatus("delegate", undefined);
				this.port.refreshActivityLane();
				this.port.footer.invalidate();
				break;

			case "background_tools":
				for (const task of event.tasks) {
					if (task.toolCallId) this.port.activityLane?.remove(`tool:${task.toolCallId}`);
				}
				this.port.activityLane?.reconcileByPrefix(
					BACKGROUND_TOOL_ACTIVITY_ID_PREFIX,
					event.tasks.map((task) => ({
						id: backgroundToolActivityId(task.taskId),
						toolCallId: task.toolCallId,
						kind: "tool" as const,
						label: task.description.trim() || `${task.toolName} · ${task.taskId}`,
						tag: task.toolName,
						...(task.startedAt ? { originAt: task.startedAt } : {}),
						...(typeof task.elapsedBeforeHandoffMs === "number"
							? { elapsedBeforeMs: task.elapsedBeforeHandoffMs }
							: {}),
					})),
				);
				this.port.getWorkbench()?.refreshExecution();
				this.port.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.port.getWorkbench()?.recordBackground(event.message);
					this.port.addMessageToChat(event.message);
					this.port.ui.requestRender();
				} else if (event.message.role === "user") {
					this.port.addMessageToChat(event.message);
					this.port.updatePendingMessagesDisplay();
					this.port.ui.requestRender();
				} else if (event.message.role === "bashExecution") {
					// A run the harness made for the owner (an exact toolkit hit) shows like a `!` command.
					this.port.addMessageToChat(event.message);
					this.port.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.clearPendingStreamingUiUpdate();
					this.lastStreamingUiUpdateAt = 0;
					const modelRef = replyModelRef(event.message);
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.port.isThinkingHidden(),
						this.port.getMarkdownThemeWithSettings(),
						{
							isStreaming: true,
							showCommentary: this.port.hasHumanAudience,
							transformMarkdown: this.port.transformMarkdownForDisplay,
							...(this.port.replyBylines.shouldShow(modelRef)
								? { byline: replyByline(modelRef, this.port.getSession().getForegroundRouteSnapshot()) }
								: {}),
						},
					);
					this.streamingMessage = event.message;
					this.port.chatContainer.addChild(this.streamingComponent);
					this.updateCommentaryActivity(this.streamingMessage);
					this.applyStreamingMessageUpdate(this.streamingMessage, { force: true });
					this.port.trimLiveTuiHistory();
				}
				break;

			case "message_update":
				if (event.message.role !== "assistant") break;
				// Provider activity and visible output are separate clocks: hidden thinking proves the
				// provider answered, but must not claim that the operator has received readable output.
				if (isFirstTokenEvent(event.assistantMessageEvent)) {
					const visibility =
						event.assistantMessageEvent.type === "thinking_delta" && this.port.isThinkingHidden()
							? "hidden"
							: "visible";
					this.port.activityLane?.markFirstToken(RUNTIME_TURN_ACTIVITY_ID, visibility);
				}
				if (this.streamingComponent) {
					this.updateCommentaryActivity(event.message);
					this.applyStreamingMessageUpdate(event.message);
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					const streamingComponent = this.streamingComponent;
					this.streamingMessage = event.message;
					this.updateCommentaryActivity(this.streamingMessage);
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.port.getSession().retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					// Mark final before the last (force) render so this update's markdown transforms see
					// isStreaming:false, matching the message's now-complete state.
					streamingComponent.setStreaming(false);
					this.applyStreamingMessageUpdate(this.streamingMessage, { force: true });
					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						errorMessage ??= this.streamingMessage.errorMessage || "Error";
						for (const [, component] of this.port.activeToolCalls.activeEntries()) {
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						}
						this.port.clearActiveToolCalls();
					} else {
						for (const [, component] of this.port.activeToolCalls.activeEntries()) component.setArgsComplete();
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.port.footer.invalidate();
				}
				this.port.ui.requestRender();
				break;

			case "tool_execution_start": {
				this.port.getWorkbench()?.beforeTool(event.toolName, this.port.getSessionManager().getCwd());
				this.port.runtimeStatus.updateRuntimeStatus();
				this.port.activityLane?.start({
					id: `tool:${event.toolCallId}`,
					kind: this.port.toolActivityKind(event.toolName),
					label: this.port.toolActivityLabel(event.toolName),
					tag: event.toolName,
				});
				let component = this.port.activeToolCalls.getActive(event.toolCallId);
				if (!component) {
					component = this.port.attachToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						event.repair,
					);
				} else {
					component.updateArgs(event.args, event.repair);
				}
				component.markExecutionStarted(event.repair);
				this.port.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.port.activeToolCalls.getActive(event.toolCallId);
				if (component) {
					component.updateArgs(event.args, event.repair);
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.port.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const toolActivityId = `tool:${event.toolCallId}`;
				const handedOff = retainedToolInvocation(event.result.details)?.execution === "running";
				if (this.port.activityLane) {
					const toolKind = this.port.toolActivityKind(event.toolName);
					const terminalStatus = this.port.toolActivityTerminalStatus(event.isError, event.result.details);
					if (!handedOff && (toolKind === "tool" || terminalStatus !== "success")) {
						this.port.activityLane.finish(toolActivityId, terminalStatus, {
							id: toolActivityId,
							kind: toolKind,
							label: this.port.toolActivityLabel(event.toolName),
						});
					} else {
						this.port.activityLane.remove(toolActivityId);
					}
				}
				const component = this.port.activeToolCalls.getActive(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.port.activeToolCalls.finish(event.toolCallId);
					this.port.ui.requestRender();
				}
				// A verification receipt changes what the inspector's Checks block shows; refresh it too.
				const details = event.result.details;
				const carriesVerification =
					!!details && typeof details === "object" && "piVerification" in (details as Record<string, unknown>);
				if (["task_steps", "goal", "delegate", "peer"].includes(event.toolName) || carriesVerification) {
					this.port.refreshActivityLane();
				}
				const workbench = this.port.getWorkbench();
				workbench?.record(component?.getWorkbenchPreview(workbench.attribution()), {
					toolCallId: event.toolCallId,
					isError: event.isError,
					details: event.result.details,
				});
				void workbench?.afterTool(event.toolName);
				break;
			}

			case "agent_end": {
				if (!event.willRetry) this.port.getWorkbench()?.complete();
				// The run's receipts are all in the transcript now; the inspector (plan, team, checks) follows them.
				this.port.refreshActivityLane();
				if (this.port.isNativeReflectionEnabled()) this.port.maybeRunNativeReflection(event.messages);
				else if (!this.port.maybeStartAutoLearn()) this.port.maybeStartAutonomyReview(event.messages);
				if (this.port.getSettings().getShowTerminalProgress()) this.port.ui.terminal.setProgress(false);
				if (!event.willRetry) {
					const finalAssistant = event.messages.findLast(
						(message): message is AssistantMessage => message.role === "assistant",
					);
					const failed = finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted";
					this.port.activityLane?.setForegroundOutcome(
						failed ? "failure" : "success",
						failed ? "Turn failed" : "Done",
					);
					const block = misalignmentBlock(finalAssistant);
					if (block) this.port.offerMisalignmentContinuation(block);
				}
				if (this.loadingAnimation && !this.port.getSession().getSessionWorkState().busy) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.port.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.port.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.port.clearActiveToolCalls();
				this.port.activityLane?.removeByPrefix("tool:");
				await this.port.checkShutdownRequested();
				this.port.ui.requestRender();
				break;
			}

			case "compaction_start": {
				if (this.port.getSettings().getShowTerminalProgress()) this.port.ui.terminal.setProgress(true);
				this.autoCompactionEscapeHandler = this.port.defaultEditor.onEscape;
				this.port.defaultEditor.onEscape = () => this.port.getSession().abortCompaction();
				if (!this.loadingAnimation) this.port.runtimeStatus.stopWorkingLoader();
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow · " : ""}Auto-compacting ${cancelHint}`;
				if (
					!this.loadingAnimation &&
					this.port.runtimeStatus.isWorkingVisible &&
					this.port.runtimeStatus.indicatorOptions
				) {
					this.loadingAnimation = this.port.runtimeStatus.createWorkingLoader();
					this.port.statusContainer.addChild(this.loadingAnimation);
				}
				this.port.activityLane?.start({ id: "runtime:compaction", kind: "runtime", label });
				this.loadingAnimation?.setMessage(label);
				this.port.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.port.getSettings().getShowTerminalProgress()) this.port.ui.terminal.setProgress(false);
				if (this.autoCompactionEscapeHandler) {
					this.port.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				if (event.aborted) {
					this.port.activityLane?.finish("runtime:compaction", "neutral", {
						id: "runtime:compaction",
						kind: "runtime",
						label: "Compaction cancelled",
					});
					if (event.reason === "manual") this.port.showError("Compaction cancelled");
				} else if (event.result) {
					const fallback = event.result.deterministic;
					this.port.activityLane?.finish("runtime:compaction", fallback ? "neutral" : "success", {
						id: "runtime:compaction",
						kind: "runtime",
						label: fallback ? `Context compacted (fallback: ${fallback.cause})` : "Context compacted",
					});
					if (fallback) {
						this.port.showError(
							`Compaction fell back to a deterministic checkpoint (${fallback.cause}): the narrative summary was lost; only files and task facts were kept.`,
						);
					}
					await this.port.rebuildChatFromMessages({ checkpointWhenDeferred: true });
					this.port.footer.invalidate();
				} else if (event.errorMessage) {
					this.port.activityLane?.finish("runtime:compaction", "failure", {
						id: "runtime:compaction",
						kind: "runtime",
						label: "Compaction failed",
					});
					if (event.reason === "manual") this.port.showError(event.errorMessage);
					else {
						this.port.chatContainer.addChild(new Spacer(1));
						this.port.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				} else if (event.skipReason) {
					this.port.activityLane?.finish("runtime:compaction", "neutral", {
						id: "runtime:compaction",
						kind: "runtime",
						label: `Compaction skipped · ${event.skipReason}`,
					});
				}
				void this.port.flushCompactionQueue({ willRetry: event.willRetry });
				if (this.loadingAnimation) {
					if (this.port.getSession().getSessionWorkState().busy)
						this.loadingAnimation.setMessage(this.port.runtimeStatus.getWorkingLoaderMessage());
					else this.port.runtimeStatus.stopWorkingLoader();
				}
				this.port.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				this.retryEscapeHandler = this.port.defaultEditor.onEscape;
				this.port.defaultEditor.onEscape = () => this.port.getSession().abortRetry();
				this.retryCountdown?.dispose();
				const retryMessage = (seconds: number) =>
					`Retry ${event.attempt}/${event.maxAttempts} in ${seconds}s · ${keyText("app.interrupt")} cancel`;
				this.port.activityLane?.wait({
					id: "runtime:retry",
					kind: "runtime",
					label: retryMessage(Math.ceil(event.delayMs / 1000)),
				});
				this.loadingAnimation?.setMessage(retryMessage(Math.ceil(event.delayMs / 1000)));
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.port.ui,
					(seconds) => {
						const label = retryMessage(seconds);
						this.port.activityLane?.update("runtime:retry", label);
						this.loadingAnimation?.setMessage(label);
					},
					() => {
						this.retryCountdown = undefined;
					},
				);
				this.port.ui.requestRender();
				break;
			}

			case "provider_admission_wait": {
				const id = `runtime:admission:${event.lane}:${event.provider}${event.account ? `#${event.account}` : ""}`;
				if (event.phase === "start") {
					const where = event.account
						? `${event.provider} (account ${event.account.slice(0, 8)})`
						: event.provider;
					const why =
						event.reason === "provider_limit"
							? `rate-limited${event.expectedMs !== undefined ? `, resets in ${Math.ceil(event.expectedMs / 1000)}s` : ""}`
							: event.reason === "emergency_stop"
								? "emergency stop engaged"
								: "at its in-flight limit";
					const label = `${event.lane} request waiting: ${where} ${why}`;
					this.port.activityLane?.wait({ id, kind: "runtime", scope: event.lane, label });
					if (event.lane === "foreground") this.loadingAnimation?.setMessage(label);
				} else {
					this.port.activityLane?.finish(id, "neutral", {
						id,
						kind: "runtime",
						label: `${event.provider} admitted after ${Math.ceil((event.waitedMs ?? 0) / 1000)}s`,
					});
					if (event.lane === "foreground")
						this.loadingAnimation?.setMessage(this.port.runtimeStatus.getWorkingLoaderMessage());
				}
				this.port.ui.requestRender();
				break;
			}
			case "auto_retry_end":
				this.clearRetryControls();
				this.loadingAnimation?.setMessage(this.port.runtimeStatus.getWorkingLoaderMessage());
				this.port.activityLane?.finish("runtime:retry", event.success ? "success" : "failure", {
					id: "runtime:retry",
					kind: "runtime",
					label: event.success ? "Retry resumed" : "Retry failed",
				});
				if (!event.success) {
					this.port.showError(
						`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`,
					);
				}
				this.port.ui.requestRender();
				break;
		}
	}
}

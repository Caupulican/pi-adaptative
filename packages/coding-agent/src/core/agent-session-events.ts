/**
 * Agent-event routing for the session coordinator: the handler every agent event reaches (extension delivery,
 * persistence, the routed-turn flush, reflection and goal hooks, and the end-of-run cleanups), the bridge that
 * fires each event into the extension runner, and the warning emitter the coordinator's observers share. The
 * coordinator supplies its owners through one ports object, so the order in which an event settles is kept here.
 */

import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import type { Agent } from "../kernel/agent.ts";
import { compactToolResultDetailsForRetention } from "../kernel/session/message-retention.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR } from "../kernel/tool-protocol-residue.ts";
import type { AgentEvent, AgentMessage } from "../kernel/types.ts";
import type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session-contracts.ts";
import type { CompactionController } from "./compaction-controller.ts";
import type { ContextPipeline } from "./context-pipeline.ts";
import type { DurableCustomMessageTurnController } from "./durable-custom-message-turn-controller.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { ForegroundLifecycleAdapter } from "./foreground-lifecycle-adapter.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import type { ForegroundTerminalHandoffController } from "./foreground-terminal-handoff-controller.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import type { MemoryController } from "./memory-controller.ts";
import type { ModelRouterController } from "./model-router-controller.ts";
import type { DeliveryState } from "./operator-projection/session-operator-projection.ts";
import type { PendingInputQueueController } from "./pending-input-queue-controller.ts";
import type { ReflectionController } from "./reflection-controller.ts";
import { REPLY_ROUTE_CUSTOM_TYPE, type ReplyRouteRecord } from "./reply-route.ts";
import type { RuntimeUpdateController } from "./runtime-update-controller.ts";
import type { SkillVaultController } from "./skill-vault.ts";
import { skillWorkPathsFromToolCall } from "./skill-work-paths.ts";
import type { ToolRecoveryLogger } from "./tool-recovery-logger.ts";
import type { ToolSelectionController } from "./tool-selection/tool-selection-controller.ts";

export interface AgentSessionEventsPorts {
	agent(): Agent;
	cwd(): string;
	sessionManager(): SessionManager;
	runtimeUpdates(): RuntimeUpdateController;
	model(): Model<Api> | undefined;
	pendingQueue(): PendingInputQueueController;
	goals(): GoalSessionController;
	skillVault(): SkillVaultController;
	toolRecoveryLogger(): ToolRecoveryLogger;
	modelRouter(): ModelRouterController;
	compaction(): CompactionController;
	terminalHandoffs(): ForegroundTerminalHandoffController;
	foregroundLifecycle(): ForegroundLifecycleAdapter;
	durableCustomMessageTurns(): DurableCustomMessageTurnController;
	memory(): MemoryController;
	reflection(): ReflectionController;
	pipeline(): ContextPipeline;
	foregroundRecovery(): ForegroundRecoveryController;
	toolSelection(): ToolSelectionController;
	deliveryToolCalls(): Set<string>;
	earlyDisplayedUserMessages(): Set<AgentMessage>;
	closingConsumerReleased(): boolean;
	disposed(): boolean;
	extensionRunner(): ExtensionRunner;
	isClosingRuntimeWaitOnly(): boolean;
	getListeners(): AgentSessionEventListener[];
	holdUnlistenedWarning(message: string): void;
	emitQueueUpdate(): void;
	setDeliveryState(state: DeliveryState): void;
	refreshForegroundEnvelope(): void;
	recordCacheObservation(message: AssistantMessage): void;
}

export class AgentSessionEvents {
	turnIndex = 0;
	private readonly ports: AgentSessionEventsPorts;

	constructor(ports: AgentSessionEventsPorts) {
		this.ports = ports;
	}

	emit(event: AgentSessionEvent): void {
		if (
			this.ports.isClosingRuntimeWaitOnly() &&
			!(event.type === "wait" && event.id === "runtime_generation.mutation_release")
		) {
			if (event.type === "warning") this.ports.holdUnlistenedWarning(event.message);
			return;
		}
		if (event.type === "warning" && this.ports.getListeners().length === 0) {
			this.ports.holdUnlistenedWarning(event.message);
			return;
		}
		for (const listener of [...this.ports.getListeners()]) {
			try {
				// Public listeners are observers. Freeze this emission's generation and invoke it
				// synchronously to preserve ordering, but contain both synchronous failures and rejected
				// thenables so one observer cannot alter sibling delivery or reject the session operation.
				const result = listener(event) as unknown;
				if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
					void Promise.resolve(result).catch(() => {});
				}
			} catch {
				// Listener failures must not affect session event dispatch or operation completion.
			}
		}
	}

	async handleAgentEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_end") this.ports.runtimeUpdates().noteRunEnd(this.ports.agent().signal);
		// A run read a queued input: it leaves the visible queue BEFORE listeners see the message (the UI sees the updated
		// queue), matched by the identity the message carries. It is delivered when its user entry is persisted, not here.
		if (event.type === "message_start" && event.message.role === "user") {
			this.ports.compaction().resetOverflowRecovery();
			if (this.ports.pendingQueue().noteRead(event.message)) this.ports.emitQueueUpdate();
			this.ports.goals().noteUserMessageRead();
		}
		if (event.type === "turn_end" || event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			this.ports.skillVault().noteActivity();
		}
		if (event.type === "tool_execution_start") {
			this.ports
				.skillVault()
				.noteWorkPaths(
					skillWorkPathsFromToolCall(
						event.toolName,
						event.args,
						this.ports.pipeline().peekPathAliasTable(),
						this.ports.cwd(),
					),
				);
		}
		if (event.type === "tool_execution_end" && event.isError) {
			this.ports.toolRecoveryLogger().recordToolExecutionFailure({
				provider: this.ports.model()?.provider,
				model: this.ports.model()?.id,
				tool: event.toolName,
				details: event.result.details,
			});
			if (event.result.terminate === true) {
				this.ports.goals().markTerminalToolFailureBlocked(event.toolName);
			}
		}

		// Emit to extensions first. Extension delivery ended with `session_shutdown` (their cleanup runs there and the runner is
		// invalidated), so a closing session's remaining agent events are settled internally only: persistence and memory sync.
		if (!this.ports.disposed()) await this._emitExtensionEvent(event);
		// A handler that was already awaiting an extension when the closing sequence gave up on it (the bounded settle) resumes
		// into owners that are being or have been closed: it stops here instead of writing to them. The loss was disclosed.
		if (this.ports.closingConsumerReleased()) return;

		const suppressRetryPromptEvent =
			this.ports.modelRouter().isRetryInFlight() &&
			(event.type === "message_start" || event.type === "message_end") &&
			(event.message.role === "user" || event.message.role === "custom");

		// This is the authoritative message_start for a user message already painted early (see
		// _promptUnserialized). Set#delete both tests and consumes membership in one step, so only
		// this one duplicate is suppressed and a later, unrelated user message is never affected.
		const suppressAlreadyDisplayedUserMessage =
			event.type === "message_start" &&
			event.message.role === "user" &&
			this.ports.earlyDisplayedUserMessages().delete(event.message);

		// Notify all listeners
		if (!suppressRetryPromptEvent && !suppressAlreadyDisplayedUserMessage) {
			this.emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		}

		if (event.type === "message_end") {
			compactToolResultDetailsForRetention(event.message);
			let messagePersisted = false;
			if (this.ports.modelRouter().captureSessionMessage(event.message, event.origin)) {
				// buffered by the router; persistence is deferred to the routed-turn flush
			} else if (event.message.role === "custom") {
				this.ports.foregroundLifecycle().appendCustomMessage(event.message);
				this.ports.durableCustomMessageTurns().notePersisted(event.message);
				messagePersisted = true;
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// The append is the Delivered point of an owner input this message carries (the ledger hears it there).
				this.ports.foregroundLifecycle().appendMessage(event.message, event.origin);
				messagePersisted = true;
			}
			// Track the response for ordered retry/failover/compaction handling after agent_end.
			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this.ports.recordCacheObservation(assistantMsg);
				// The session lane's stream closed: it idles until its next request (a tool run or the owner).
				const sessionModel = this.ports.model();
				if (
					sessionModel &&
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					assistantMsg.provider === sessionModel.provider &&
					assistantMsg.model === sessionModel.id
				) {
					this.ports.compaction().onLaneIdle(assistantMsg);
				}
				// A reply a routed model wrote keeps its route, so a reloaded conversation names the same author.
				const route = this.ports.modelRouter().getForegroundRouteSnapshot();
				if (route.switched) {
					const record: ReplyRouteRecord = { timestamp: assistantMsg.timestamp, route };
					this.ports.sessionManager().appendCustomEntry(REPLY_ROUTE_CUSTOM_TYPE, record);
				}
				this.ports.foregroundLifecycle().recordTransportTelemetry(assistantMsg);
				this.ports.goals().recordExecutionUsage(assistantMsg);
				if (messagePersisted) {
					this.ports.pipeline().observeProviderUsage(this.ports.agent().state.messages, assistantMsg);
				}
				if (assistantMsg.errorMessage?.startsWith(`${NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR}:`)) {
					this.ports.goals().markProtocolFailureBlocked(assistantMsg.errorMessage);
				}
				this.ports.foregroundRecovery().observeAssistant(assistantMsg);
			}
		}
		if (event.type === "agent_end") {
			const willRetry = this._willRetryAfterAgentEnd(event);
			// The end-of-run cleanups are independent: one that fails (a fenced session file refusing a write) must not skip the
			// others, which release leases and flush handoffs. Every step runs, and every cause is kept.
			const failures: unknown[] = [];
			const settle = (step: () => void): void => {
				try {
					step();
				} catch (error: unknown) {
					failures.push(error);
				}
			};
			// Settle the exact cue-bearing run before completed-turn analysis can queue a later cue.
			settle(() => this.ports.reflection().finishCurrentTurnCue(event.messages, { willRetry }));
			if (!willRetry)
				settle(() => {
					const reflectionTurn = this.ports.reflection().analyzeCompletedTurn(event.messages);
					// The shared projection excludes raw tool-result payloads and bounds both roles before any
					// deterministic memory sync. No reflection provider request is scheduled at this boundary.
					this.ports.memory().scheduleTurnSync(reflectionTurn.userText, reflectionTurn.assistantText);
					if (reflectionTurn.trigger !== "none")
						this.ports.reflection().queueCurrentTurnCue(reflectionTurn.trigger);
				});
			// Error/abort turns bypass the normal steering boundary, and a completion can arrive after the
			// final normal poll. agent_end is the fallback before foreground recovery decides whether queued
			// steering requires one continuation; turn_end is intentionally not a flush.
			settle(() => this.ports.terminalHandoffs().flushProviderBoundary());
			settle(() => this.ports.durableCustomMessageTurns().flushParentSteers());
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					failures[0] instanceof Error ? failures[0].message : "The end-of-run cleanup failed.",
				);
			}
		}
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.turnIndex = 0;
			await this.ports.extensionRunner().emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this.ports.extensionRunner().emit({
				type: "agent_end",
				messages: event.messages,
				willRetry: this._willRetryAfterAgentEnd(event),
			});
		} else if (event.type === "turn_start") {
			this.ports.toolSelection().startTurn();
			this.ports.refreshForegroundEnvelope();
			await this.ports.extensionRunner().emit({
				type: "turn_start",
				turnIndex: this.turnIndex,
				timestamp: Date.now(),
			});
		} else if (event.type === "turn_end") {
			await this.ports.extensionRunner().emit({
				type: "turn_end",
				turnIndex: this.turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			});
			this.turnIndex++;
		} else if (event.type === "message_start") {
			await this.ports.extensionRunner().emit({ type: "message_start", message: event.message });
		} else if (event.type === "message_update") {
			await this.ports.extensionRunner().emit({
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			});
		} else if (event.type === "message_end") {
			const replacement = await this.ports.extensionRunner().emitMessageEnd({
				type: "message_end",
				message: event.message,
			});
			if (replacement) {
				this.ports.agent().replaceMessageContents(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			await this.ports.extensionRunner().emit({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
		} else if (event.type === "tool_execution_update") {
			await this.ports.extensionRunner().emit({
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			});
		} else if (event.type === "tool_execution_end") {
			if (this.ports.deliveryToolCalls().delete(event.toolCallId) && this.ports.deliveryToolCalls().size === 0) {
				this.ports.setDeliveryState("none");
			}
			await this.ports.extensionRunner().emit({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			});
		}
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		return this.ports.foregroundRecovery().willRetryAfterAgentEnd(event);
	}

	noteSystemOneTaskDirectoryUnavailable(error: unknown): void {
		// A verification that meets its task directory already released by a closing session is not a directory to repair: the session
		// is ending and the verification is not run. Say that, and keep the repair advice for a live session.
		if (this.ports.disposed()) {
			this.emit({
				type: "warning",
				message: "System One verification was not run because the session was closing; no judgment was recorded.",
			});
			return;
		}
		const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/gu, " ").slice(0, 240);
		this.emit({
			type: "warning",
			message: `System One verification was deferred because the active task directory is unavailable (${reason}). Repair it with task_directory; no judgment was recorded.`,
		});
	}
}

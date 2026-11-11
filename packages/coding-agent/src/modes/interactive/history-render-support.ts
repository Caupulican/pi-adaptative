/**
 * The parts of a history reload that do not belong to the live chat state: byline seeding for the
 * first painted tail, the display state older rows inherit, and the seam where the background prefix
 * is placed above the tail.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import { type Component, Container, Spacer } from "@caupulican/pi-tui";
import { interfaceText } from "../../core/language/interface-text.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { ownerInputIdOf } from "../../kernel/owner-input-stamp.ts";
import { turnOriginStampOf } from "../../kernel/turn-origin-stamp.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { isModelFacingText } from "../../presentation/plain-text.ts";
import { ActionTranscriptComponent } from "./components/action-transcript.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { ChannelMessageComponent } from "./components/channel-message.ts";
import { isExpandable } from "./components/expandable-text.ts";
import { ReplyBylineTracker, replyModelRef } from "./components/reply-byline.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { getUserMessageText } from "./history-reload-math.ts";

/** Display state an older row must adopt, because it was built after the operator changed a toggle. */
export interface HistoryDisplayState {
	showImages: boolean;
	imageWidthCells: number;
	toolsExpanded: boolean;
	actionsExpanded: boolean;
	hideThinkingBlock: boolean;
}

/** Is this user turn one the transcript shows? The same test `addMessageToChat` renders by. */
function showsOwnerTurn(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	const text = getUserMessageText(message);
	if (!text) return false;
	return (
		turnOriginStampOf(message)?.shown !== undefined ||
		ownerInputIdOf(message) !== undefined ||
		!isModelFacingText(text)
	);
}

/** Off-screen walk of the earlier turns, so the first painted reply still knows whether to show a byline. */
export function seedReplyBylines(messages: readonly AgentMessage[], bylines: ReplyBylineTracker): void {
	for (const message of messages) {
		if (message.role === "assistant") bylines.shouldShow(replyModelRef(message));
		else if (showsOwnerTurn(message)) bylines.ownerMessage();
	}
}

const PREFIX_CHUNK = 20;

/** What the background prefix pass needs from the live chat it will be spliced into. */
export interface PrefixHistoryHost {
	readonly chatContainer: Container;
	generation(): number;
	displayState(): HistoryDisplayState;
	renderMessage(
		message: AgentMessage,
		container: Container,
		pending: Map<string, ToolExecutionComponent>,
		bylines: ReplyBylineTracker,
	): void;
	requestRender(): void;
	historyLoadFailed(error: unknown): void;
}

/**
 * Builds the older half off-screen in chunks, then places it above the tail. Each chunk yields, so a
 * long history never blocks a frame; the generation fence stops a superseded pass from painting.
 */
export async function renderPrefixHistory(
	prefixMessages: readonly AgentMessage[],
	generation: number,
	host: PrefixHistoryHost,
): Promise<void> {
	try {
		const container = new Container();
		const pending = new Map<string, ToolExecutionComponent>();
		const bylines = new ReplyBylineTracker();
		let processed = 0;
		for (const message of prefixMessages) {
			if (processed > 0 && processed % PREFIX_CHUNK === 0) {
				await new Promise((resolve) => setImmediate(resolve));
				if (generation !== host.generation()) return;
			}
			processed++;
			host.renderMessage(message, container, pending, bylines);
		}
		if (generation !== host.generation() || container.children.length === 0) return;
		applyHistoryDisplayState(container.children, host.displayState());
		mergePrefixHistory(host.chatContainer, container.children);
		host.requestRender();
	} catch (error) {
		if (generation === host.generation()) host.historyLoadFailed(error);
	}
}

/** Applies the operator's current toggles and image settings to rows that were rendered off-screen. */
export function applyHistoryDisplayState(children: readonly Component[], state: HistoryDisplayState): void {
	for (const child of children) {
		if (child instanceof ActionTranscriptComponent) {
			child.setShowImages(state.showImages);
			child.setImageWidthCells(state.imageWidthCells);
			child.setTranscriptExpanded(state.actionsExpanded);
			continue;
		}
		if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(state.hideThinkingBlock);
		if (isExpandable(child)) child.setExpanded(state.toolsExpanded);
	}
}

/** What a failed tool call says in the Root transcript. */
export function rootToolFailureText(message: AssistantMessage, retryAttempt: number): string {
	const text = interfaceText();
	if (message.stopReason === "aborted") {
		return retryAttempt > 0
			? text.conversation.abortedAfterRetries(retryAttempt)
			: text.conversation.operationAborted;
	}
	return message.errorMessage || text.notices.errorWord;
}

/**
 * What a failed tool call says in a bot or team transcript. A peer's provider error can echo credentials
 * and internal endpoints, so only one redacted line survives; Root keeps its full diagnostic.
 */
export function targetToolFailureText(message: AssistantMessage): string {
	const text = interfaceText();
	if (message.stopReason === "aborted") return text.conversation.operationAborted;
	const redacted = message.errorMessage ? boundedRedactedDiagnosticText(message.errorMessage) : undefined;
	return redacted || text.notices.errorWord;
}

/**
 * Places the background prefix above the tail. Two seams need sewing: an action transcript split by the
 * partition boundary is rejoined, and a row that opens a turn keeps its spacer when it lands under the
 * prefix. The child list is replaced rather than spliced, so the container's revision and row cache
 * stay in step with what is now on screen.
 */
export function mergePrefixHistory(chatContainer: Container, prefixChildren: readonly Component[]): void {
	const merged = prefixChildren.slice();
	const lastPrefix = merged.at(-1);
	const firstTail = chatContainer.children[0];
	if (lastPrefix instanceof ActionTranscriptComponent && firstTail instanceof ActionTranscriptComponent) {
		for (const action of [...firstTail.actionComponents()]) {
			if (!lastPrefix.canAccept()) break;
			lastPrefix.addAction(action);
			firstTail.removeAction(action);
		}
		if (firstTail.actionComponents().length === 0) chatContainer.removeChild(firstTail);
	} else if (
		firstTail instanceof UserMessageComponent ||
		firstTail instanceof ChannelMessageComponent ||
		firstTail instanceof SkillInvocationMessageComponent
	) {
		merged.push(new Spacer(1));
	}
	const children = merged.concat(chatContainer.children);
	chatContainer.clear();
	chatContainer.children = children;
}

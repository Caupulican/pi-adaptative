/**
 * Per-target isolated chat view containers and caching for bot and team chats.
 */

import { Container, Spacer, Text } from "@caupulican/pi-tui";
import type { ActiveChatTarget } from "../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { AgentMessage } from "../../kernel/index.ts";
import { theme } from "../../presentation/theme-model.ts";
import { ActionTranscriptComponent } from "./components/action-transcript.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { isExpandable } from "./components/expandable-text.ts";
import { ReplyBylineTracker } from "./components/reply-byline.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/** What a bot is doing now, in a few words: its last tool call with the argument that names its target, from its own transcript. */
export function currentActivity(messages: readonly AgentMessage[]): string | undefined {
	const text = interfaceText().chat;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const call = [...message.content].reverse().find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") return text.writingAnswer;
		const args = call.arguments as Record<string, unknown>;
		// A message to a peer shows who it goes to, never its text; any other call shows the argument that names its target.
		const keys =
			call.name === "bot_message"
				? ["to", "agentId", "target", "recipient"]
				: ["path", "command", "pattern", "query", "url", "prompt", "message", "text"];
		const key = keys.find((name) => typeof args[name] === "string");
		const value = key ? String(args[key]).replace(/\s+/g, " ").trim() : "";
		const shown = value.length > 42 ? `${value.slice(0, 41)}…` : value;
		if (call.name === "bot_message") return shown ? text.messagesTo(shown) : text.messagesPeer;
		return shown ? `${call.name} ${shown}` : call.name;
	}
	return undefined;
}

export interface TargetChatView {
	readonly container: Container;
	readonly pendingToolCalls: Map<string, ToolExecutionComponent>;
	/** Its own byline turns: a bot or team transcript must never consume Root's. */
	readonly bylines: ReplyBylineTracker;
	lastHeaderSignature?: string;
	lastFooterSignature?: string;
	/** One key per rendered message, so an append is recognised without re-walking the transcript. */
	renderedMessageKeys: string[];
	headerTextComponent?: Text;
	emptyHintComponent?: Text;
	footerComponents: Text[];
}

/** A rendered message's identity: role, time, stop reason and the shape of its last block. */
function messageKey(message: AgentMessage): string {
	const rawContent = "content" in message ? message.content : undefined;
	const isString = typeof rawContent === "string";
	const content = Array.isArray(rawContent) ? rawContent : [];
	const contentLen = isString ? rawContent.length : content.length;
	const last = isString ? undefined : (content.at(-1) as { text?: unknown; id?: unknown } | undefined);
	const lastSize = isString
		? rawContent.length
		: typeof last?.text === "string"
			? last.text.length
			: typeof last?.id === "string"
				? last.id.length
				: 0;
	const stopReason = "stopReason" in message ? String(message.stopReason ?? "") : "";
	const isError = "isError" in message ? Number(Boolean(message.isError)) : 0;
	return `${message.role}:${message.timestamp ?? 0}:${stopReason}:${contentLen}:${lastSize}:${isError}`;
}

export type TargetMessageRenderer = (
	container: Container,
	pendingToolCalls: Map<string, ToolExecutionComponent>,
	message: AgentMessage,
	bylines: ReplyBylineTracker,
) => void;

export function targetKey(target: ActiveChatTarget): string | undefined {
	if (target.kind === "bot") return `bot:${target.agentId}`;
	if (target.kind === "team") return `team:${target.teamId}`;
	return undefined;
}

function applyTargetFooter(view: TargetChatView, footer: readonly string[]): void {
	// Replaced in place: a working-status change must not rebuild the transcript it sits under.
	for (const previous of view.footerComponents) view.container.removeChild(previous);
	view.footerComponents = [];
	if (footer.length === 0) return;
	const footerComp = new Text(footer.join("\n"), 1, 0);
	view.container.addChild(footerComp);
	view.footerComponents.push(footerComp);
}

export class TargetChatViewRegistry {
	private readonly views = new Map<string, TargetChatView>();

	getOrCreate(key: string): TargetChatView {
		let view = this.views.get(key);
		if (!view) {
			view = {
				container: new Container(),
				pendingToolCalls: new Map(),
				bylines: new ReplyBylineTracker(),
				renderedMessageKeys: [],
				footerComponents: [],
			};
			this.views.set(key, view);
		}
		return view;
	}

	getActiveContainer(target: ActiveChatTarget): Container | undefined {
		if (target.kind === "root") return undefined;
		const key = targetKey(target);
		return key ? this.getOrCreate(key).container : undefined;
	}

	invalidate(): void {
		for (const view of this.views.values()) {
			view.container.invalidate();
		}
	}

	setToolsExpanded(expanded: boolean): void {
		for (const view of this.views.values()) {
			for (const child of view.container.children) {
				if (isExpandable(child)) child.setExpanded(expanded);
			}
		}
	}

	setShowImages(show: boolean): void {
		for (const view of this.views.values()) {
			for (const child of view.container.children) {
				if (child instanceof ActionTranscriptComponent) child.setShowImages(show);
			}
			for (const component of view.pendingToolCalls.values()) component.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const view of this.views.values()) {
			for (const child of view.container.children) {
				if (child instanceof ActionTranscriptComponent) child.setImageWidthCells(width);
			}
			for (const component of view.pendingToolCalls.values()) component.setImageWidthCells(width);
		}
	}

	setTranscriptActionsExpanded(expanded: boolean): void {
		for (const view of this.views.values()) {
			for (const child of view.container.children) {
				if (child instanceof ActionTranscriptComponent) child.setTranscriptExpanded(expanded);
			}
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		for (const view of this.views.values()) {
			for (const child of view.container.children) {
				if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(hide);
			}
		}
	}

	reset(): void {
		this.views.clear();
	}

	renderTargetChat(
		key: string,
		header: readonly string[],
		headerSignature: string,
		messages: readonly AgentMessage[],
		emptyHint: string,
		renderMessage: TargetMessageRenderer,
		footer: readonly string[] = [],
	): void {
		const view = this.getOrCreate(key);
		const footerSignature = JSON.stringify(footer);
		const keys: string[] = [];
		for (const message of messages) keys.push(messageKey(message));
		const count = keys.length;
		const rendered = view.renderedMessageKeys;

		// 1. Nothing changed for this target: reuse the cached Container without touching it.
		if (
			view.lastHeaderSignature === headerSignature &&
			view.lastFooterSignature === footerSignature &&
			rendered.length === count &&
			rendered.every((key, index) => key === keys[index])
		) {
			return;
		}

		// 2. Only new messages were appended (and no rendered one changed): append the new tail and
		// update the header/footer in place, so a working-status or member change never rebuilds.
		let canAppend = rendered.length > 0 && count >= rendered.length;
		for (let index = 0; canAppend && index < rendered.length; index++) {
			if (rendered[index] !== keys[index]) canAppend = false;
		}

		if (canAppend) {
			if (view.lastHeaderSignature !== headerSignature && view.headerTextComponent) {
				view.headerTextComponent.setText(header.join("\n"));
				view.lastHeaderSignature = headerSignature;
			}

			if (count > rendered.length) {
				if (view.emptyHintComponent) {
					view.container.removeChild(view.emptyHintComponent);
					view.emptyHintComponent = undefined;
				}
				for (let index = rendered.length; index < count; index++) {
					renderMessage(view.container, view.pendingToolCalls, messages[index]!, view.bylines);
				}
			}

			applyTargetFooter(view, footer);

			view.renderedMessageKeys = keys;
			view.lastFooterSignature = footerSignature;
			return;
		}

		// 3. Full build of this target container
		view.container.clear();
		view.pendingToolCalls.clear();
		view.bylines.reset();
		view.footerComponents = [];
		view.emptyHintComponent = undefined;

		view.container.addChild(new DynamicBorder());
		const headerComp = new Text(header.join("\n"), 1, 0);
		view.headerTextComponent = headerComp;
		view.container.addChild(headerComp);
		view.container.addChild(new DynamicBorder());
		view.container.addChild(new Spacer(1));

		if (messages.length === 0) {
			const emptyComp = new Text(theme.fg("muted", emptyHint), 1, 0);
			view.emptyHintComponent = emptyComp;
			view.container.addChild(emptyComp);
		} else {
			for (const message of messages) {
				renderMessage(view.container, view.pendingToolCalls, message, view.bylines);
			}
		}

		applyTargetFooter(view, footer);

		view.renderedMessageKeys = keys;
		view.lastHeaderSignature = headerSignature;
		view.lastFooterSignature = footerSignature;
	}
}

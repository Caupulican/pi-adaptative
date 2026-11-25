import type { AssistantMessage } from "@caupulican/pi-ai";
import {
	type Component,
	Container,
	collectTerminalRows,
	componentTerminalRows,
	joinTerminalRows,
	Markdown,
	type MarkdownTheme,
	Spacer,
	type TerminalRows,
	Text,
	TruncatedText,
	VisibilityContainer,
} from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { isAssistantDisplayText } from "../../../core/message-phase.ts";
import { harnessLog } from "../../../kernel/harness-log.ts";
import { VERIFICATION_HANDOFF_REQUIRED_ERROR } from "../../../kernel/index.ts";
import { isModelFacingText } from "../../../presentation/plain-text.ts";
import { getMarkdownTheme, theme } from "../../../presentation/theme-model.ts";
import { abortedTurnScreenText } from "../aborted-turn.ts";
import { applyMarkdownTransform, type MarkdownTransformFn, type MarkdownTransformSlot } from "./markdown-transform.ts";
import { markPromptZone } from "./prompt-zone-rows.ts";
import type { ReplyByline } from "./reply-byline.ts";

export interface AssistantMessageComponentOptions {
	isStreaming?: boolean;
	showCommentary?: boolean;
	transformMarkdown?: MarkdownTransformFn;
	/** Who wrote this reply, shown as one row above it (see reply-byline.ts). */
	byline?: ReplyByline;
}

interface AssistantVisualBlock {
	readonly kind: "text" | "thinking";
	readonly rawText: string;
	readonly trailingSpacer: boolean;
}

interface AssistantFinalNotice {
	readonly kind: "aborted" | "verification" | "error" | "empty";
	readonly text: string;
	readonly tone: "error" | "warning" | "muted";
}

interface AssistantVisualProjection {
	readonly blocks: readonly AssistantVisualBlock[];
	readonly hasToolCalls: boolean;
	readonly hasVisibleContent: boolean;
	readonly hasVisibleText: boolean;
	readonly visibleNonThinkingOutput: boolean;
	readonly notice?: AssistantFinalNotice;
	/** Content topology only. Raw Markdown stays out so growing text can reconcile in place. */
	readonly shape: string;
}

/**
 * An error the owner can read. A message led by a machine code (`NATIVE_TOOL_PROTOCOL_RESIDUE: …`) or written as a
 * JSON record shows a plain sentence instead; the raw text stays in the harness log.
 */
function ownerErrorText(raw: string): string {
	if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?::|\s|$)/.test(raw) || /^\s*[[{]/.test(raw) || isModelFacingText(raw)) {
		harnessLog.debug("ui", "an assistant turn error is kept in the log, not on screen", () => ({ error: raw }));
		return interfaceText().conversation.modelInternalError;
	}
	return raw;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentRevision = 0;
	private readonly showCommentary: boolean;
	override get renderRevision(): number {
		return this.contentRevision;
	}
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private hasVisibleText = false;
	private visibleNonThinkingOutput = false;
	private isStreaming: boolean;
	private transformMarkdown?: MarkdownTransformFn;
	private readonly byline?: ReplyByline;
	private markdownSlots: MarkdownTransformSlot[] = [];
	/** Topology of the mounted visual blocks; text changes alone retain their Markdown components. */
	private visualShape?: string;
	/** Thinking sections retain their contents and spacing across visibility toggles. */
	private thinkingContainers: VisibilityContainer[] = [];
	private leadingSpacer?: VisibilityContainer;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options?: AssistantMessageComponentOptions,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.isStreaming = options?.isStreaming ?? false;
		this.showCommentary = options?.showCommentary ?? false;
		this.transformMarkdown = options?.transformMarkdown;
		this.byline = options?.byline;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			// Theme and locale invalidation must recreate static, already-colored children too.
			this.visualShape = undefined;
			this.updateContent(this.lastMessage);
		} else {
			this.contentRevision++;
		}
	}

	/** Marks whether this instance is still the live in-progress response (vs. a finalized one). */
	setStreaming(isStreaming: boolean): void {
		if (this.isStreaming === isStreaming) return;
		this.isStreaming = isStreaming;
		for (const { component } of this.markdownSlots) component.setStreaming(isStreaming);
		// A transform receives `isStreaming`; the final pass must not be hidden behind the viewport cache.
		this.contentRevision++;
	}

	/**
	 * Flip thinking-block visibility in place. Never rebuilds message content (F4/upstream
	 * b07e17faa): toggling must not touch sibling live tool components sharing the chat tree, and
	 * must not discard partial streaming output. The thinking block (and its own trailing spacer,
	 * when one was built) live inside a VisibilityContainer built once in updateContent(), so a
	 * toggle is just a visibility flip plus a cache invalidation on that one subtree.
	 *
	 * The leading spacer follows visible text, thinking, and the byline independently of the
	 * content tree, so thinking-only replies do not leave an empty row behind when hidden.
	 */
	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinkingBlock === hide) return;
		this.contentRevision++;
		this.hideThinkingBlock = hide;
		for (const container of this.thinkingContainers) container.setVisible(!hide);
		this.leadingSpacer?.setVisible(
			this.hasVisibleText || Boolean(this.byline) || (!hide && this.thinkingContainers.length > 0),
		);
	}

	hasVisibleOutput(): boolean {
		return this.visibleNonThinkingOutput || this.thinkingContainers.some((container) => container.isVisible());
	}

	override render(width: number): string[] {
		return collectTerminalRows(this.renderRows(width));
	}

	renderRows(width: number): TerminalRows {
		this.applyMarkdownTransforms(width);
		const rows = this.contentRows(this.children, width);
		return this.hasToolCalls ? rows : markPromptZone(rows);
	}

	private contentRows(children: readonly Component[], width: number): TerminalRows {
		return joinTerminalRows(
			children.map((child) => {
				if (child instanceof VisibilityContainer)
					return child.isVisible() ? this.contentRows(child.children, width) : [];
				if (child === this.contentContainer) return this.contentRows(this.contentContainer.children, width);
				return componentTerminalRows(child, width);
			}),
		);
	}

	/**
	 * Re-run registered extension markdown transformers (P2g) for the current viewport width.
	 * `slot.rawText` is always text that has already been through the session's path-alias display
	 * expansion (interactive-mode expands aliases before ever constructing or updating this
	 * component), so transformers only ever see already-expanded, display-ready text -- never raw
	 * wire-format aliases.
	 */
	private applyMarkdownTransforms(width: number): void {
		if (!this.transformMarkdown) return;
		for (const slot of this.markdownSlots) {
			applyMarkdownTransform(slot, this.transformMarkdown, this.isStreaming, width);
		}
	}

	/**
	 * Does this block carry something the operator can read? Text the current commentary setting
	 * shows, or any thinking block — a hidden one is still content, just collapsed. Deliberately
	 * blind to `hideThinkingBlock`, which is a view toggle, not a fact about the turn.
	 */
	private isReadable(content: AssistantMessage["content"][number]): boolean {
		if (content.type === "text")
			return isAssistantDisplayText(content, this.showCommentary) && Boolean(content.text.trim());
		return content.type === "thinking" && Boolean(content.thinking.trim());
	}

	private projectContent(message: AssistantMessage): AssistantVisualProjection {
		const readable = message.content.map((content) => this.isReadable(content));
		const readableAfter = new Array<boolean>(readable.length + 1).fill(false);
		for (let index = readable.length - 1; index >= 0; index--) {
			readableAfter[index] = readable[index] === true || readableAfter[index + 1] === true;
		}

		const blocks: AssistantVisualBlock[] = [];
		let hasVisibleText = false;
		let hasThinking = false;
		for (let index = 0; index < message.content.length; index++) {
			const content = message.content[index];
			if (content.type === "text" && readable[index] === true) {
				const rawText = content.text.trim();
				if (!rawText) continue;
				hasVisibleText = true;
				blocks.push({ kind: "text", rawText, trailingSpacer: false });
				continue;
			}
			if (content.type !== "thinking") continue;

			const thinkingBlocks: string[] = [];
			let end = index;
			for (; end < message.content.length; end++) {
				const thinkingContent = message.content[end];
				if (thinkingContent.type !== "thinking") break;
				const thinking = thinkingContent.thinking.trim();
				if (thinking) thinkingBlocks.push(thinking);
			}
			index = end - 1;
			if (thinkingBlocks.length === 0) continue;
			hasThinking = true;
			blocks.push({
				kind: "thinking",
				rawText: thinkingBlocks.join("\n\n"),
				trailingSpacer: readableAfter[end] === true,
			});
		}

		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		const hasReadableContent = blocks.length > 0;
		let notice: AssistantFinalNotice | undefined;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const text =
					abortedTurnScreenText(message.errorMessage) ??
					(message.errorMessage
						? ownerErrorText(message.errorMessage)
						: interfaceText().conversation.operationAborted);
				notice = { kind: "aborted", text, tone: "error" };
			} else if (message.stopReason === "error" && message.errorMessage === VERIFICATION_HANDOFF_REQUIRED_ERROR) {
				notice = {
					kind: "verification",
					text: interfaceText().conversation.verificationUnresolved,
					tone: "warning",
				};
			} else if (message.stopReason === "error") {
				const error = ownerErrorText(message.errorMessage || interfaceText().notices.unknownError);
				notice = { kind: "error", text: interfaceText().notices.error(error), tone: "error" };
			} else if (!this.isStreaming && !hasReadableContent) {
				notice = {
					kind: "empty",
					text: interfaceText().conversation.noResponseReceived,
					tone: "muted",
				};
			}
		}

		const hasVisibleContent = hasVisibleText || (!this.hideThinkingBlock && hasThinking);
		return {
			blocks,
			hasToolCalls,
			hasVisibleContent,
			hasVisibleText,
			visibleNonThinkingOutput: hasVisibleText || (!hasToolCalls && notice !== undefined),
			...(notice ? { notice } : {}),
			shape: JSON.stringify([
				hasToolCalls,
				notice ? [notice.kind, notice.text] : null,
				blocks.map((block) => [block.kind, block.trailingSpacer]),
			]),
		};
	}

	private mountProjection(projection: AssistantVisualProjection): void {
		this.contentContainer.clear();
		this.markdownSlots = [];
		this.thinkingContainers = [];
		this.leadingSpacer = new VisibilityContainer(projection.hasVisibleContent || Boolean(this.byline));
		this.leadingSpacer.addChild(new Spacer(1));
		this.contentContainer.addChild(this.leadingSpacer);
		if (this.byline) {
			this.contentContainer.addChild(
				// One row: at narrow widths the route and model shorten from the end, the actor always stays.
				new TruncatedText(theme.fg(this.byline.routed ? "warning" : "muted", this.byline.text), 1, 0),
			);
		}

		for (const block of projection.blocks) {
			if (block.kind === "text") {
				const markdown = new Markdown(block.rawText, 1, 0, this.markdownTheme);
				markdown.setStreaming(this.isStreaming);
				this.markdownSlots.push({ component: markdown, rawText: block.rawText, messageType: "assistant" });
				this.contentContainer.addChild(markdown);
				continue;
			}

			const markdown = new Markdown(block.rawText, 1, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("thinkingText", text),
				italic: true,
			});
			markdown.setStreaming(this.isStreaming);
			this.markdownSlots.push({
				component: markdown,
				rawText: block.rawText,
				messageType: "assistant-thinking",
			});
			const container = new VisibilityContainer(!this.hideThinkingBlock);
			container.addChild(markdown);
			if (block.trailingSpacer) container.addChild(new Spacer(1));
			this.thinkingContainers.push(container);
			this.contentContainer.addChild(container);
		}

		if (projection.notice) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg(projection.notice.tone, projection.notice.text), 1, 0));
		}
	}

	/** Update mounted Markdown text without discarding caches held by unchanged visual blocks. */
	private reconcileProjection(projection: AssistantVisualProjection): boolean {
		let changed = false;
		for (let index = 0; index < projection.blocks.length; index++) {
			const block = projection.blocks[index]!;
			const slot = this.markdownSlots[index]!;
			if (slot.rawText === block.rawText) continue;
			// Before the first transformed paint, the component still contains the old raw text. Record
			// that actual baseline before advancing rawText, or an identity transform could skip the write.
			if (this.transformMarkdown && slot.lastTransformed === undefined) slot.lastTransformed = slot.rawText;
			slot.rawText = block.rawText;
			// With a transformer, the component still contains the previous transformed output. Keep
			// lastTransformed beside it so applyMarkdownTransform can compare and replace them together.
			if (!this.transformMarkdown) slot.component.setText(block.rawText);
			changed = true;
		}
		this.leadingSpacer?.setVisible(projection.hasVisibleContent || Boolean(this.byline));
		return changed;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		const projection = this.projectContent(message);
		const topologyChanged = projection.shape !== this.visualShape;
		const textChanged = topologyChanged ? true : this.reconcileProjection(projection);
		if (topologyChanged) this.mountProjection(projection);

		this.visualShape = projection.shape;
		this.hasToolCalls = projection.hasToolCalls;
		this.hasVisibleText = projection.hasVisibleText;
		this.visibleNonThinkingOutput = projection.visibleNonThinkingOutput;
		if (topologyChanged || textChanged) this.contentRevision++;
	}
}

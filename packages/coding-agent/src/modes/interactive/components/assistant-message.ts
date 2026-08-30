import type { AssistantMessage } from "@caupulican/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text, VisibilityContainer } from "@caupulican/pi-tui";
import { isAssistantCommentary } from "../../../core/message-phase.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { applyMarkdownTransform, type MarkdownTransformFn, type MarkdownTransformSlot } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface AssistantMessageComponentOptions {
	isStreaming?: boolean;
	transformMarkdown?: MarkdownTransformFn;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private visibleOutput = false;
	private isStreaming: boolean;
	private transformMarkdown?: MarkdownTransformFn;
	private markdownSlots: MarkdownTransformSlot[] = [];
	/** Wraps the thinking block (+ its own trailing spacer) so toggling never rebuilds content. */
	private thinkingContainer?: VisibilityContainer;

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
		this.transformMarkdown = options?.transformMarkdown;

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
			this.updateContent(this.lastMessage);
		}
	}

	/** Marks whether this instance is still the live in-progress response (vs. a finalized one). */
	setStreaming(isStreaming: boolean): void {
		this.isStreaming = isStreaming;
	}

	/**
	 * Flip thinking-block visibility in place. Never rebuilds message content (F4/upstream
	 * b07e17faa): toggling must not touch sibling live tool components sharing the chat tree, and
	 * must not discard partial streaming output. The thinking block (and its own trailing spacer,
	 * when one was built) live inside a VisibilityContainer built once in updateContent(), so a
	 * toggle is just a visibility flip plus a cache invalidation on that one subtree.
	 *
	 * Known cosmetic limitation: the single leading spacer before all message content is decided
	 * once, in updateContent(), from the thinking-visibility at that time. For a thinking-only
	 * message (no text, no tool-call error text) toggled after the fact, the leading spacer does
	 * not react. This never loses or corrupts content -- only that one blank line can be stale
	 * until the next real content update.
	 */
	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingContainer?.setVisible(!hide);
	}

	hasVisibleOutput(): boolean {
		return this.visibleOutput;
	}

	override render(width: number): string[] {
		this.applyMarkdownTransforms(width);
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
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

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();
		this.markdownSlots = [];
		this.thinkingContainer = undefined;

		const hasVisibleContent = message.content.some(
			(c) =>
				(c.type === "text" && !isAssistantCommentary(c) && c.text.trim()) ||
				(!this.hideThinkingBlock && c.type === "thinking" && c.thinking.trim()),
		);
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.visibleOutput =
			hasVisibleContent || (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error"));

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && !isAssistantCommentary(content) && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const rawText = content.text.trim();
				const textMarkdown = new Markdown(rawText, 1, 0, this.markdownTheme);
				this.markdownSlots.push({ component: textMarkdown, rawText, messageType: "assistant" });
				this.contentContainer.addChild(textMarkdown);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") break;
					const thinking = thinkingContent.thinking.trim();
					if (thinking) thinkingBlocks.push(thinking);
				}
				i--;
				if (thinkingBlocks.length === 0) continue;

				// Build the thinking block (and its spacing) regardless of current visibility, wrapped
				// in a VisibilityContainer, so a later setHideThinkingBlock() toggle can show it
				// in place without rebuilding this component (see setHideThinkingBlock doc above).
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(c) =>
							(c.type === "text" && !isAssistantCommentary(c) && c.text.trim()) ||
							(c.type === "thinking" && c.thinking.trim()),
					);
				const thinkingRaw = thinkingBlocks.join("\n\n");
				// Adjacent thinking blocks form one section instead of repeated visual chrome.
				const thinkingMarkdown = new Markdown(thinkingRaw, 1, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				});
				this.markdownSlots.push({
					component: thinkingMarkdown,
					rawText: thinkingRaw,
					messageType: "assistant-thinking",
				});
				const thinkingContainer = new VisibilityContainer(!this.hideThinkingBlock);
				thinkingContainer.addChild(thinkingMarkdown);
				if (hasVisibleContentAfter) {
					thinkingContainer.addChild(new Spacer(1));
				}
				this.thinkingContainer = thinkingContainer;
				this.contentContainer.addChild(thinkingContainer);
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}

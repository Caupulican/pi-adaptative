import { VERIFICATION_HANDOFF_REQUIRED_ERROR } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	TruncatedText,
	VisibilityContainer,
} from "@caupulican/pi-tui";
import { isAssistantDisplayText } from "../../../core/message-phase.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { applyMarkdownTransform, type MarkdownTransformFn, type MarkdownTransformSlot } from "./markdown-transform.ts";
import type { ReplyByline } from "./reply-byline.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface AssistantMessageComponentOptions {
	isStreaming?: boolean;
	showCommentary?: boolean;
	transformMarkdown?: MarkdownTransformFn;
	/** Who wrote this reply, shown as one row above it (see reply-byline.ts). */
	byline?: ReplyByline;
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
	private visibleOutput = false;
	private isStreaming: boolean;
	private transformMarkdown?: MarkdownTransformFn;
	private readonly byline?: ReplyByline;
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
		this.contentRevision++;
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

	updateContent(message: AssistantMessage): void {
		this.contentRevision++;
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();
		this.markdownSlots = [];
		this.thinkingContainer = undefined;

		const hasVisibleContent = message.content.some(
			(c) => this.isReadable(c) && (c.type !== "thinking" || !this.hideThinkingBlock),
		);
		// What the turn produced, independent of the thinking toggle: a hidden thinking block is still
		// content the operator can reveal, so it must not read as an empty turn.
		const hasReadableContent = message.content.some((c) => this.isReadable(c));
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.visibleOutput =
			hasVisibleContent ||
			(!hasToolCalls &&
				(message.stopReason === "aborted" ||
					message.stopReason === "error" ||
					(!this.isStreaming && !hasReadableContent)));

		if (hasVisibleContent || this.byline) {
			this.contentContainer.addChild(new Spacer(1));
		}
		if (this.byline) {
			this.contentContainer.addChild(
				// One row: at narrow widths the route and model shorten from the end, the actor always stays.
				new TruncatedText(theme.fg(this.byline.routed ? "warning" : "muted", this.byline.text), 1, 0),
			);
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && isAssistantDisplayText(content, this.showCommentary) && content.text.trim()) {
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
				const hasVisibleContentAfter = message.content.slice(i + 1).some((c) => this.isReadable(c));
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
			} else if (message.stopReason === "error" && message.errorMessage === VERIFICATION_HANDOFF_REQUIRED_ERROR) {
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(
						theme.fg(
							"warning",
							"Verification remains unresolved: this run's own check is still failing. Rerun it, or /verify to see and dismiss it.",
						),
						1,
						0,
					),
				);
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			} else if (!this.isStreaming && !hasReadableContent) {
				// The placeholder reports an empty turn. A turn that produced text or a thinking block
				// has something to read, so it never gets one.
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("muted", "(No response received from model)"), 1, 0));
			}
		}
	}
}

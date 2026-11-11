import { type Component, truncateToWidth } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { keyText } from "../../../presentation/keybinding-hints.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { bumpActionTranscriptEpoch, getActionTranscriptEpoch } from "../action-transcript-epoch.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

// A pathological tool-only turn must not turn one top-level TUI component into
// an unbounded retention root. A new adjacent transcript segment starts at the
// bound and uses the same presentation contract.
export const ACTION_TRANSCRIPT_SEGMENT_LIMIT = 256;

export { bumpActionTranscriptEpoch, getActionTranscriptEpoch };

/**
 * The single history projection for model-invoked actions.
 *
 * Membership is append-only: one admitted tool call contributes exactly one
 * action and is never relocated or replaced by a later call. Tool-specific
 * rendering is available only in the expanded transcript.
 */
export class ActionTranscriptComponent implements Component {
	private readonly actions: ToolExecutionComponent[] = [];
	private transcriptExpanded = false;
	private readonly conversation: Component[] = [];
	private revision = 0;

	constructor(actions: ToolExecutionComponent[] = []) {
		for (const action of actions) this.addAction(action);
	}

	/**
	 * Folded action revisions, or undefined while an expanded transcript holds a live call: those rows
	 * carry a running clock, so no cached row may be reused for them.
	 */
	get renderRevision(): number | undefined {
		if (this.transcriptExpanded && this.actions.some((action) => action.isToolPartial())) return undefined;
		let revision = this.revision;
		for (const action of this.actions) revision = (revision * 31 + action.actionRevision) | 0;
		return revision;
	}

	addAction(action: ToolExecutionComponent): void {
		action.setExpanded(this.transcriptExpanded);
		this.actions.push(action);
		const conversation = action.getConversationComponent();
		if (conversation) this.conversation.push(conversation);
		this.revision++;
		bumpActionTranscriptEpoch();
	}

	/** Hands one admitted action to another segment, so a partition boundary never splits a turn. */
	removeAction(action: ToolExecutionComponent): void {
		const index = this.actions.indexOf(action);
		if (index === -1) return;
		this.actions.splice(index, 1);
		const conversation = action.getConversationComponent();
		if (conversation) {
			const conversationIndex = this.conversation.indexOf(conversation);
			if (conversationIndex !== -1) this.conversation.splice(conversationIndex, 1);
		}
		this.revision++;
		bumpActionTranscriptEpoch();
	}

	actionComponents(): readonly ToolExecutionComponent[] {
		return this.actions;
	}

	conversationComponents(): readonly Component[] {
		return this.conversation;
	}

	canAccept(): boolean {
		return this.actions.length < ACTION_TRANSCRIPT_SEGMENT_LIMIT;
	}

	containsAction(action: ToolExecutionComponent): boolean {
		return this.actions.includes(action);
	}

	setTranscriptExpanded(expanded: boolean): void {
		if (this.transcriptExpanded !== expanded) {
			this.transcriptExpanded = expanded;
			for (const action of this.actions) action.setExpanded(expanded);
			this.revision++;
			bumpActionTranscriptEpoch();
		}
	}

	setShowImages(show: boolean): void {
		for (const action of this.actions) action.setShowImages(show);
		this.revision++;
		bumpActionTranscriptEpoch();
	}

	setImageWidthCells(width: number): void {
		for (const action of this.actions) action.setImageWidthCells(width);
		this.revision++;
		bumpActionTranscriptEpoch();
	}

	invalidate(): void {
		for (const action of this.actions) action.invalidate();
		this.revision++;
		bumpActionTranscriptEpoch();
	}

	render(width: number): string[] {
		if (this.actions.length === 0) return [];
		const safeWidth = Math.max(1, width);
		if (this.transcriptExpanded) return this.actions.flatMap((action) => action.render(safeWidth));

		const total = this.actions.length;
		let pending = 0;
		let failed = 0;
		for (const action of this.actions) {
			if (action.isToolPartial()) pending++;
			if (action.isToolError()) failed++;
		}
		const text = interfaceText().conversation;
		const failureSuffix = failed > 0 ? text.actionFailure(failed) : "";
		const color = failed > 0 ? "error" : pending > 0 ? "accent" : "success";
		const summary = `${theme.fg(color, "•")} ${theme.bold(text.actionStatus(pending, total))}${theme.fg(
			"dim",
			`${failureSuffix} · ${keyText("app.transcript.open")} ${text.viewTranscript}`,
		)}`;
		return [truncateToWidth(summary, safeWidth, "...")];
	}
}

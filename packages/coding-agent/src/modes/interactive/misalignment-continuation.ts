import type { AssistantMessage } from "@caupulican/pi-ai";
import type { Component } from "@caupulican/pi-tui";
import { UsageActionSelectorComponent } from "./components/usage-action-selector.ts";

/** A Codex misalignment block the owner may choose to continue past. */
export interface MisalignmentBlock {
	readonly detailedExplanation: string;
	/** The model-visible instruction the backend asks to be submitted if the owner continues. */
	readonly steer: string;
}

/**
 * The block a failed Codex answer carries, when it can be continued: as the Codex CLI requires, only
 * with both the explanation (the owner reads it first) and the steer to submit.
 */
export function misalignmentBlock(message: AssistantMessage | undefined): MisalignmentBlock | undefined {
	if (message?.stopReason !== "error") return undefined;
	const diagnostic = message.diagnostics?.find((entry) => entry.type === "openai_codex_misalignment");
	const details = diagnostic?.details as { detailedExplanation?: unknown; steer?: unknown } | undefined;
	if (typeof details?.detailedExplanation !== "string" || typeof details.steer !== "string") return undefined;
	return { detailedExplanation: details.detailedExplanation, steer: details.steer };
}

export interface MisalignmentContinuationHost {
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	/** Sends the steer as the owner's next message. */
	submit(text: string): Promise<void>;
}

/** Show the explanation and let the owner continue with the backend's instruction, or stop. */
export function offerMisalignmentContinuation(host: MisalignmentContinuationHost, block: MisalignmentBlock): void {
	host.showSelector((done) => {
		const selector = new UsageActionSelectorComponent({
			title: "Codex blocked this request",
			subtitle: block.detailedExplanation,
			items: [
				{ value: "continue", label: "Continue", description: block.steer },
				{ value: "stop", label: "Stop", description: "Leave the turn as it ended" },
			],
			initialSelectedIndex: 1,
			onSelect: (value) => {
				done();
				if (value === "continue") void host.submit(block.steer);
			},
			onCancel: done,
		});
		return { component: selector, focus: selector };
	});
}

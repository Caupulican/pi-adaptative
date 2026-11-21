/** Retains the artifact views a provider accepted for one conversation and isolates speculative requests. */
import { createHash } from "node:crypto";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import type { ContextVisibility } from "./context-query-visibility.ts";

export interface AcceptedPreview {
	readonly row: ToolResultMessage;
	readonly visibility: Exclude<ContextVisibility, "full">;
	readonly fingerprint: string;
}

type Entries = Map<number, WeakMap<ToolResultMessage, { source: ToolResultMessage; preview: AcceptedPreview }>>;

export class AcceptedPromptPreviews {
	private accepted?: { scope: string; entries: Entries; order: number };
	private sequence = 0;

	get started(): boolean {
		return this.sequence !== 0;
	}

	begin(scope: string) {
		const order = ++this.sequence;
		const previous = this.accepted;
		const entries: Entries = new Map();
		let fingerprints: ReturnType<typeof createHash> | undefined;
		return {
			get: (index: number, source: ToolResultMessage, base: ToolResultMessage) => {
				const entry = previous?.scope === scope ? previous.entries.get(index)?.get(base) : undefined;
				return entry?.source === source ? entry.preview : undefined;
			},
			keep: (index: number, source: ToolResultMessage, base: ToolResultMessage, preview: AcceptedPreview) => {
				entries.set(index, new WeakMap([[base, { source, preview }]]));
				fingerprints ??= createHash("sha256");
				fingerprints.update(JSON.stringify([index, preview.fingerprint]));
			},
			policy: () => fingerprints?.copy().digest("hex"),
			isCurrent: () => this.accepted === previous,
			accept: () => {
				if (order > (this.accepted?.order ?? 0)) this.accepted = { scope, entries, order };
			},
		};
	}
}

export function acceptedPreview(row: ToolResultMessage, visibility: AcceptedPreview["visibility"]): AcceptedPreview {
	const fingerprint = createHash("sha256")
		.update(JSON.stringify([row.toolCallId, row.content]))
		.digest("hex");
	return { row, visibility, fingerprint };
}

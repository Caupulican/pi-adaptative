import type { AgentContextPlanFn, AgentMessage } from "../kernel/index.ts";
import { createCustomMessage } from "../kernel/messages.ts";
import { parentInputMetadataOfMessage, parentNoteMarker } from "../kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";

/**
 * Pending and skipped note bodies stay out of ordinary history; consumed notes retain their canonical history
 * position.
 */
function savedInputId(message: AgentMessage): string | false {
	return message.role === "custom" ? (parentInputMetadataOfMessage(message)?.deliveryId ?? false) : false;
}

/** One wrapper around the existing ICM/base plan: authorizes before filtering, projects only the selected batch. */
export function projectParentInputs(
	base: AgentContextPlanFn,
	manager: Pick<
		SessionManager,
		"captureParentNotes" | "getPendingParentInputs" | "getActiveParentInputIds" | "getSkippedParentInputIds"
	>,
	getSubmissionEpoch: () => number | undefined,
): AgentContextPlanFn {
	return async (request, signal) => {
		const epoch = getSubmissionEpoch();
		const selection = manager.captureParentNotes(request.messages, epoch);
		const pending = new Set(manager.getPendingParentInputs().map((input) => input.metadata.deliveryId));
		const skipped = manager.getSkippedParentInputIds();
		const active = manager.getActiveParentInputIds();
		const isCurrent = (): boolean => {
			if (getSubmissionEpoch() !== epoch) return false;
			const currentPending = manager.getPendingParentInputs();
			const currentActive = manager.getActiveParentInputIds();
			return (
				currentPending.length === pending.size &&
				currentPending.every((input) => pending.has(input.metadata.deliveryId)) &&
				currentActive.size === active.size &&
				[...currentActive].every((id) => active.has(id)) &&
				(!selection || selection.isCurrent())
			);
		};
		const keep = (message: AgentMessage): boolean => {
			const id = savedInputId(message);
			return id === false || (!pending.has(id) && !skipped.has(id)) || active.has(id);
		};
		const messages = request.messages.filter(keep);
		const plan = await base(
			{
				...request,
				messages,
				sentPrefixCount: request.messages.slice(0, request.sentPrefixCount).filter(keep).length,
				...(request.wire ? { wire: { ...request.wire, messages: request.wire.messages?.filter(keep) } } : {}),
			},
			signal,
		);
		const projected = plan.messages.filter(keep);
		const transientMessages = plan.transientMessages?.filter(keep);
		return {
			...plan,
			...(transientMessages ? { transientMessages } : {}),
			messages: [
				...projected,
				...(selection
					? [
							createCustomMessage(
								"parent-note-selection",
								// Held notes may wait days for the owner: the saved time lets the model weigh their age.
								`${parentNoteMarker(selection.selectionId)}\nHeld since ${new Date(Math.min(...selection.messages.map((message) => message.timestamp))).toISOString()}; check current state before acting on any of them.`,
								false,
								undefined,
								new Date(selection.messages[0]!.timestamp).toISOString(),
							),
							...selection.messages,
						]
					: []),
			],
			isCurrent: () => isCurrent() && plan.isCurrent?.() !== false,
			prepareCommit: () => isCurrent() && plan.prepareCommit?.() !== false,
		};
	};
}

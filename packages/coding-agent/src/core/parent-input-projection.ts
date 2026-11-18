import { countHistoryWork, inheritHistoryWork } from "@caupulican/pi-ai/history-work";
import type { AgentContextPlanFn, AgentMessage } from "../kernel/index.ts";
import { messageHistoryVersion } from "../kernel/message-revision.ts";
import { createCustomMessage } from "../kernel/messages.ts";
import { VersionedMessageFilter } from "../kernel/prefix-fold.ts";
import { parentInputMetadataOfMessage, parentNoteMarker } from "../kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";

/**
 * Pending and skipped note bodies stay out of ordinary history; consumed notes retain their canonical history
 * position.
 */
function savedInputId(message: AgentMessage): string | false {
	return message.role === "custom" ? (parentInputMetadataOfMessage(message)?.deliveryId ?? false) : false;
}

function matchesIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every((id) => right.has(id));
}

function hiddenParentInput(message: AgentMessage, hiddenIds: ReadonlySet<string>): boolean {
	const id = savedInputId(message);
	return id !== false && hiddenIds.has(id);
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
	let hidden: ReadonlySet<string> = new Set();
	const createFilter = (hiddenIds: ReadonlySet<string>) =>
		new VersionedMessageFilter((message) => hiddenParentInput(message, hiddenIds));
	let inputFilter = createFilter(hidden);
	let outputFilter = createFilter(hidden);
	return async (request, signal) => {
		const epoch = getSubmissionEpoch();
		const selection = manager.captureParentNotes(request.messages, epoch);
		const pending = new Set(manager.getPendingParentInputs().map((input) => input.metadata.deliveryId));
		const skipped = new Set(manager.getSkippedParentInputIds());
		const active = new Set(manager.getActiveParentInputIds());
		const hiddenIds = new Set([...pending, ...skipped]);
		for (const id of active) hiddenIds.delete(id);
		if (!matchesIds(hidden, hiddenIds)) {
			hidden = hiddenIds;
			inputFilter = createFilter(hidden);
			outputFilter = createFilter(hidden);
		}
		const inputs = inputFilter;
		const outputs = outputFilter;
		const isCurrent = (): boolean => {
			if (getSubmissionEpoch() !== epoch) return false;
			const currentPending = manager.getPendingParentInputs();
			const currentActive = manager.getActiveParentInputIds();
			return (
				currentPending.length === pending.size &&
				currentPending.every((input) => pending.has(input.metadata.deliveryId)) &&
				matchesIds(active, currentActive) &&
				matchesIds(skipped, manager.getSkippedParentInputIds()) &&
				(!selection || selection.isCurrent())
			);
		};
		const keep = (message: AgentMessage) => !hiddenParentInput(message, hiddenIds);
		const filter = (messages: AgentMessage[], projection: VersionedMessageFilter): AgentMessage[] =>
			hiddenIds.size === 0 && messageHistoryVersion(messages) ? messages : projection.filter(messages);
		const messages = filter(request.messages, inputs);
		const sourceLength = request.messages.length;
		const sourcePrefix = Math.min(sourceLength, request.sentPrefixCount);
		let sentPrefixCount = sourcePrefix;
		if (messages.length !== sourceLength) {
			// Count the shorter side of the boundary. On a warm append the unsent tail is usually only one turn.
			const countPrefix = sourcePrefix <= sourceLength - sourcePrefix;
			let kept = 0;
			const end = countPrefix ? sourcePrefix : sourceLength;
			for (let index = countPrefix ? 0 : sourcePrefix; index < end; index++) {
				const message = request.messages[index];
				if (message && keep(message)) kept++;
			}
			if (countPrefix) countHistoryWork(request.messages, "oldRowsRead", sourcePrefix);
			sentPrefixCount = countPrefix ? kept : messages.length - kept;
		}
		const plan = await base(
			{
				...request,
				messages,
				sentPrefixCount,
				...(request.wire
					? {
							wire: {
								...request.wire,
								messages:
									hiddenIds.size === 0 && messages === request.messages
										? request.wire.messages
										: request.wire.messages?.filter(keep),
							},
						}
					: {}),
			},
			signal,
		);
		const projected = filter(plan.messages, outputs);
		const transientMessages = plan.transientMessages?.filter(keep);
		const history = plan.providerHistory;
		const messagesWithNotes = selection
			? [
					...projected,
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
			: projected;
		inheritHistoryWork(projected, messagesWithNotes);
		return {
			...plan,
			...(transientMessages ? { transientMessages } : {}),
			// A selection is request-local authority. Admitting this request starts a fresh history window.
			...(selection && history
				? {
						providerHistory: {
							...history,
							offer: () => undefined,
							accept: (candidate, messages) => history.accept({ ...candidate, nativeHistory: false }, messages),
						} satisfies typeof history,
					}
				: {}),
			messages: messagesWithNotes,
			isCurrent: () => isCurrent() && plan.isCurrent?.() !== false,
			prepareCommit: () => isCurrent() && plan.prepareCommit?.() !== false,
		};
	};
}

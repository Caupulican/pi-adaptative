import { countHistoryWork, inheritHistoryWork } from "@caupulican/pi-ai/history-work";
import type { AgentContextPlanFn, AgentMessage } from "../kernel/index.ts";
import { messageHistoryVersion } from "../kernel/message-revision.ts";
import { createCustomMessage } from "../kernel/messages.ts";
import { VersionedMessageFilter } from "../kernel/prefix-fold.ts";
import { isContextPlanDispatchCurrent } from "../kernel/provider-request-planner.ts";
import {
	hiddenParentInputIds,
	parentInputMetadataOfMessage,
	parentNoteMarker,
} from "../kernel/session/parent-input-ledger.ts";
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
		| "captureParentNotes"
		| "getPendingParentInputs"
		| "getActiveParentInputWake"
		| "getSkippedParentInputIds"
		| "getMessageEntryId"
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
		const wake = manager.getActiveParentInputWake();
		const pending = new Set(manager.getPendingParentInputs().map((input) => input.metadata.deliveryId));
		const skipped = new Set(manager.getSkippedParentInputIds());
		const hiddenIds = hiddenParentInputIds(pending, skipped, wake);
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

			return (
				currentPending.length === pending.size &&
				currentPending.every((input) => pending.has(input.metadata.deliveryId)) &&
				wake?.wakeId === manager.getActiveParentInputWake()?.wakeId &&
				matchesIds(skipped, manager.getSkippedParentInputIds()) &&
				(!selection || selection.isCurrent())
			);
		};
		const keep = (message: AgentMessage) => !hiddenParentInput(message, hiddenIds);
		const window = wake?.window;
		const keepInput = window
			? (message: AgentMessage): boolean => {
					const entryId = manager.getMessageEntryId(request.sourceMessage?.(message) ?? message);
					return (entryId === undefined || window.admitsPriorEntry(entryId)) && keep(message);
				}
			: keep;
		const filter = (messages: AgentMessage[], projection: VersionedMessageFilter): AgentMessage[] =>
			hiddenIds.size === 0 && messageHistoryVersion(messages) ? messages : projection.filter(messages);
		const messages = window ? request.messages.filter(keepInput) : filter(request.messages, inputs);
		// An owner can steer into this wake after it starts. Only the admitted window may select their held notes.
		const selection = manager.captureParentNotes(messages, epoch);
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
				if (message && keepInput(message)) kept++;
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
										: request.wire.messages?.filter(keepInput),
							},
						}
					: {}),
			},
			signal,
		);
		const projected = filter(plan.messages, outputs);
		const transientMessages = plan.transientMessages?.filter(keep);
		const history = plan.providerHistory;
		// A saved assistant exchange can end the detached window. Reopen the same manifest for the request only.
		const tail = wake && projected.findLast((row) => row.role !== "bashExecution" || !row.excludeFromContext);
		const resumeWake = wake && tail?.role === "assistant";
		const requestMessages = selection
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
			: resumeWake
				? [
						...projected,
						{
							role: "user" as const,
							content: wake.content,
							timestamp: tail.timestamp,
						},
					]
				: projected;
		inheritHistoryWork(projected, requestMessages);
		return {
			...plan,
			...(transientMessages ? { transientMessages } : {}),
			// A selection is request-local authority. Admitting this request starts a fresh history window.
			...((selection || wake) && history
				? {
						providerHistory: {
							...history,
							offer: () => undefined,
							accept: (candidate, messages) => history.accept({ ...candidate, nativeHistory: false }, messages),
						} satisfies typeof history,
					}
				: {}),
			messages: requestMessages,
			isCurrent: () => isCurrent() && plan.isCurrent?.() !== false,
			...(wake && {
				isDispatchCurrent: () =>
					getSubmissionEpoch() === epoch &&
					manager.getActiveParentInputWake()?.wakeId === wake.wakeId &&
					(!selection || selection.isCurrent()) &&
					isContextPlanDispatchCurrent(plan),
			}),
			prepareCommit: () => isCurrent() && plan.prepareCommit?.() !== false,
		};
	};
}

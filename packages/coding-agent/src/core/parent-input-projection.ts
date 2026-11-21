import { countHistoryWork, inheritHistoryWork } from "@caupulican/pi-ai/history-work";
import type { AgentContextPlanFn, AgentMessage } from "../kernel/index.ts";
import { messageHistoryVersion } from "../kernel/message-revision.ts";
import { createCustomMessage } from "../kernel/messages.ts";
import { VersionedMessageFilter } from "../kernel/prefix-fold.ts";
import { isContextPlanDispatchCurrent } from "../kernel/provider-request-planner.ts";
import {
	parentInputMetadataOfMessage,
	parentNoteMarker,
	parentWakeContent,
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
		"captureParentNotes" | "getPendingParentInputs" | "getActiveParentInputWake" | "getSkippedParentInputIds"
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
		const wake = manager.getActiveParentInputWake();
		const hiddenIds = new Set([...pending, ...skipped]);
		for (const input of wake?.inputs ?? []) hiddenIds.delete(input.deliveryId);
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
		// A failed wake can outlive an unrelated owner turn. Retry from the complete history with the
		// same manifest as a request-local user turn, without re-appending the input or replaying a tool.
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
							content: parentWakeContent(wake.wakeId, wake.inputs),
							timestamp: tail.timestamp,
						},
					]
				: projected;
		inheritHistoryWork(projected, requestMessages);
		return {
			...plan,
			...(transientMessages ? { transientMessages } : {}),
			// A selection is request-local authority. Admitting this request starts a fresh history window.
			...((selection || resumeWake) && history
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
					isContextPlanDispatchCurrent(plan),
			}),
			prepareCommit: () => isCurrent() && plan.prepareCommit?.() !== false,
		};
	};
}

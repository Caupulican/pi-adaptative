/** Chronological projection of a saved bot conversation and the worker history, inbox and notices shown beside it. */
import { messageAppendLineage, messageContentEpoch } from "../../kernel/message-revision.ts";
import type { AgentMessage } from "../../kernel/types.ts";

const followed = new WeakSet<readonly AgentMessage[]>();

/** Only the owner of the rows may mark an array. A discontinuity must replace the array. */
export function followedBotTranscript(messages: AgentMessage[]): readonly AgentMessage[] {
	followed.add(messages);
	return messages;
}

export function isFollowedBotTranscript(messages: readonly AgentMessage[]): boolean {
	return followed.has(messages);
}

const liveViews = new WeakMap<object, { epoch: number; rows: AgentMessage[] }>();

/** Keep the live chat's append-only view until its history is replaced, reordered, or edited in place. */
export function liveBotTranscript(messages: readonly AgentMessage[]): readonly AgentMessage[] {
	const lineage = messageAppendLineage(messages);
	if (!lineage) return messages.slice();
	const epoch = messageContentEpoch();
	const previous = liveViews.get(lineage);
	if (previous && previous.epoch === epoch) {
		for (let i = previous.rows.length; i < messages.length; i++) previous.rows.push(messages[i]!);
		return previous.rows;
	}
	const rows = messages.slice();
	liveViews.set(lineage, { epoch, rows });
	return followedBotTranscript(rows);
}

/** The messages of two chronological lists in time order, each list's own order kept (an untimed message keeps its place). */
export function mergeByTime(first: readonly AgentMessage[], second: readonly AgentMessage[]): AgentMessage[] {
	const merged: AgentMessage[] = [];
	let i = 0;
	let j = 0;
	let leftTime = 0;
	let rightTime = 0;
	while (i < first.length && j < second.length) {
		leftTime = first[i]!.timestamp ?? leftTime;
		rightTime = second[j]!.timestamp ?? rightTime;
		merged.push(leftTime <= rightTime ? first[i++]! : second[j++]!);
	}
	while (i < first.length) merged.push(first[i++]!);
	while (j < second.length) merged.push(second[j++]!);
	return merged;
}

interface MergedChat {
	earlier: readonly AgentMessage[];
	inbox: readonly AgentMessage[];
	overlayTime: number;
	count: number;
	time: number;
	result: AgentMessage[];
}

/** A continuing disk conversation pays for new messages and the bounded inbox overlay on refresh. */
export class BotChatChronology {
	private readonly merged = new WeakMap<readonly AgentMessage[], MergedChat>();

	view(
		earlier: readonly AgentMessage[],
		current: readonly AgentMessage[],
		inbox: readonly AgentMessage[],
	): readonly AgentMessage[] {
		if (!earlier.length && !inbox.length) return current;
		const cached = this.merged.get(current);
		if (
			cached &&
			cached.earlier === earlier &&
			cached.inbox.length === inbox.length &&
			cached.inbox.every((row, i) => {
				const next = inbox[i];
				return (
					row.role === "custom" &&
					next?.role === "custom" &&
					row.timestamp === next.timestamp &&
					row.content === next.content
				);
			})
		) {
			let time = cached.time;
			let afterOverlay = true;
			for (let i = cached.count; i < current.length; i++) {
				time = current[i]!.timestamp ?? time;
				if (time <= cached.overlayTime) {
					afterOverlay = false;
					break;
				}
			}
			if (afterOverlay) {
				for (let i = cached.count; i < current.length; i++) cached.result.push(current[i]!);
				cached.time = time;
				cached.count = current.length;
				return cached.result;
			}
		}

		const result =
			earlier.length && !inbox.length
				? mergeByTime(earlier, current)
				: mergeByTime(earlier.length ? mergeByTime(earlier, current) : current, inbox);
		if (isFollowedBotTranscript(current)) {
			let overlayTime = 0;
			for (const rows of [earlier, inbox])
				for (const row of rows) overlayTime = Math.max(overlayTime, row.timestamp ?? 0);
			let time = 0;
			for (let i = current.length - 1; i >= 0; i--) {
				if (current[i]!.timestamp !== undefined) {
					time = current[i]!.timestamp!;
					break;
				}
			}
			this.merged.set(current, { earlier, inbox, overlayTime, count: current.length, time, result });
			followedBotTranscript(result);
		}
		return result;
	}
}

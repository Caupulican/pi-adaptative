/** Provider-neutral coordinator that builds one node of the permanent chat's summary tree. */

import { safeErrorMessage } from "../../kernel/types.ts";
import type { ContinuousChatRecord } from "./continuous-chat-contracts.ts";
import {
	renderContinuousChatLeafTask,
	renderContinuousChatMergeTask,
	renderContinuousChatOverlengthCorrection,
} from "./continuous-chat-prompt.ts";
import {
	CONTINUOUS_CHAT_NODE_MAX_BYTES,
	CONTINUOUS_CHAT_NODE_TARGET_BYTES,
	type ContinuousChatNodeCoordinate,
	type ContinuousChatTreeNode,
	continuousChatParentCoordinate,
	createContinuousChatLeaf,
	createContinuousChatParent,
	createContinuousChatParentWithoutCall,
	renderContinuousChatLeaf,
} from "./continuous-chat-tree.ts";

/** Model replies allowed for one node, including the first. */
export const CONTINUOUS_CHAT_COMPACTION_MAX_REPLIES = 5;

/** The cache-stable prefix of a compaction call: the turns' system prompt and tools, then the chat view. */
export interface ContinuousChatCompactionPrefix {
	systemPrompt: string;
	tools: readonly ContinuousChatStableToolDefinition[];
	view: string;
}

/** Provider-neutral declaration projected from the exact foreground tool set accepted for this chat. */
export interface ContinuousChatStableToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
}

/** One open compaction conversation. Each send appends to it and resolves with the model's plain-text reply. */
export interface ContinuousChatCompactionConversation {
	send(message: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Provider-neutral model port. The tools in the prefix exist only for cache identity: an adapter MUST throw
 * rather than execute a tool call, because a reply is plain text.
 */
export interface ContinuousChatCompactionPort {
	open(prefix: ContinuousChatCompactionPrefix): ContinuousChatCompactionConversation;
}

/** The durable tree a compaction reads from and appends to. ContinuousChatStore satisfies it structurally. */
export interface ContinuousChatCompactionSink {
	readNode(coordinate: ContinuousChatNodeCoordinate): Promise<ContinuousChatTreeNode | undefined>;
	/** Resolves false when an identical node already exists. */
	appendNode(node: ContinuousChatTreeNode): Promise<boolean>;
}

/** The node to build: a message leaf, or two adjacent aligned siblings merged into their parent. */
export type ContinuousChatCompactionTarget =
	| { kind: "leaf"; record: ContinuousChatRecord }
	| { kind: "merge"; left: ContinuousChatTreeNode; right: ContinuousChatTreeNode };

/** One compaction request. Its causal view ends before a leaf target or at a merge target's last message. */
export interface ContinuousChatCompactionJob {
	target: ContinuousChatCompactionTarget;
	prefix: ContinuousChatCompactionPrefix;
	signal?: AbortSignal;
}

/** Why a run failed. A failed run never publishes a node. */
export type ContinuousChatCompactionFailureReason = "empty-reply" | "overflow" | "port-error" | "sink-error";

interface ContinuousChatCompactionCandidate {
	text: string;
	bytes: number;
}

/** `replies` counts the model replies received. `existing` is true when the sink already held the node. */
export type ContinuousChatCompactionOutcome =
	| { status: "published"; node: ContinuousChatTreeNode; replies: number; existing: boolean }
	| {
			status: "failed";
			reason: ContinuousChatCompactionFailureReason;
			replies: number;
			shortest?: ContinuousChatCompactionCandidate;
			message: string;
	  }
	| { status: "cancelled"; replies: number };

/**
 * Builds one tree node per run, from the cheapest source that fits: an existing node, the message leaf, the joined
 * children, or the model. The model conversation is not resumable across a restart; a restarted node starts a new
 * conversation from its first task. Replies target 512 bytes; after five corrections the shortest is retained when
 * it satisfies the tree's bounded interpretation of the reference's "a few bytes over is fine" exception.
 */
export class ContinuousChatCompactionCoordinator {
	private readonly port: ContinuousChatCompactionPort;
	private readonly sink: ContinuousChatCompactionSink;

	constructor(port: ContinuousChatCompactionPort, sink: ContinuousChatCompactionSink) {
		this.port = port;
		this.sink = sink;
	}

	async run(job: ContinuousChatCompactionJob): Promise<ContinuousChatCompactionOutcome> {
		if (!job.prefix.view.startsWith("<chat>") || !job.prefix.view.endsWith("</chat>")) {
			throw new TypeError("Continuous-chat compaction view must be a <chat> block.");
		}
		const coordinate = targetCoordinate(job.target);
		if (job.signal?.aborted) return { status: "cancelled", replies: 0 };
		let existing: ContinuousChatTreeNode | undefined;
		try {
			existing = await this.sink.readNode(coordinate);
		} catch (error) {
			return failure("sink-error", 0, safeErrorMessage(error, "Continuous-chat node read failed."));
		}
		if (existing !== undefined) return { status: "published", node: existing, replies: 0, existing: true };
		const node = noCallNode(job.target);
		if (node !== undefined) return this.publish(job.signal, node, 0);
		return this.compose(job);
	}

	private async compose(job: ContinuousChatCompactionJob): Promise<ContinuousChatCompactionOutcome> {
		const { target, signal } = job;
		if (signal?.aborted) return { status: "cancelled", replies: 0 };
		let conversation: ContinuousChatCompactionConversation;
		try {
			conversation = this.port.open(job.prefix);
		} catch (error) {
			return portFailure(signal, 0, error);
		}
		let message =
			target.kind === "leaf"
				? renderContinuousChatLeafTask(target.record)
				: renderContinuousChatMergeTask(target.left, target.right);
		let replies = 0;
		let shortest: ContinuousChatCompactionCandidate | undefined;
		while (replies < CONTINUOUS_CHAT_COMPACTION_MAX_REPLIES) {
			let reply: string;
			try {
				reply = await conversation.send(message, signal);
			} catch (error) {
				return portFailure(signal, replies, error, shortest);
			}
			replies++;
			if (signal?.aborted) return { status: "cancelled", replies };
			const candidate = reply.trim();
			if (candidate.length === 0) return failure("empty-reply", replies, "Compaction reply was empty.", shortest);
			const bytes = Buffer.byteLength(candidate, "utf8");
			if (shortest === undefined || bytes < shortest.bytes) shortest = { text: candidate, bytes };
			if (bytes <= CONTINUOUS_CHAT_NODE_TARGET_BYTES) {
				const node =
					target.kind === "leaf"
						? createContinuousChatLeaf(target.record, candidate)
						: createContinuousChatParent(target.left, target.right, candidate);
				return this.publish(signal, node, replies, shortest);
			}
			message = renderContinuousChatOverlengthCorrection(candidate);
		}
		if (shortest === undefined) return failure("empty-reply", replies, "Compaction produced no candidate.");
		if (shortest.bytes > CONTINUOUS_CHAT_NODE_MAX_BYTES) {
			return failure(
				"overflow",
				replies,
				`Shortest compaction reply was ${shortest.bytes} bytes; bounded overflow ends at ${CONTINUOUS_CHAT_NODE_MAX_BYTES}.`,
				shortest,
			);
		}
		const node =
			target.kind === "leaf"
				? createContinuousChatLeaf(target.record, shortest.text)
				: createContinuousChatParent(target.left, target.right, shortest.text);
		return this.publish(signal, node, replies, shortest);
	}

	private async publish(
		signal: AbortSignal | undefined,
		node: ContinuousChatTreeNode,
		replies: number,
		shortest?: ContinuousChatCompactionCandidate,
	): Promise<ContinuousChatCompactionOutcome> {
		if (signal?.aborted) return { status: "cancelled", replies };
		let appended: boolean;
		try {
			appended = await this.sink.appendNode(node);
		} catch (error) {
			const message = safeErrorMessage(error, "Continuous-chat node append failed.");
			return failure("sink-error", replies, message, shortest);
		}
		return { status: "published", node, replies, existing: !appended };
	}
}

function targetCoordinate(target: ContinuousChatCompactionTarget): ContinuousChatNodeCoordinate {
	if (target.kind === "leaf") return { level: 0, ordinal: target.record.id };
	const coordinate = continuousChatParentCoordinate(target.left, target.right);
	if (coordinate === undefined) {
		throw new TypeError("Continuous-chat merge children must be adjacent aligned siblings.");
	}
	return coordinate;
}

/** The node that needs no model call: the leaf when it fits as is, or the joined children when their join fits. */
function noCallNode(target: ContinuousChatCompactionTarget): ContinuousChatTreeNode | undefined {
	if (target.kind === "merge") return createContinuousChatParentWithoutCall(target.left, target.right);
	const fits = Buffer.byteLength(renderContinuousChatLeaf(target.record), "utf8") <= CONTINUOUS_CHAT_NODE_TARGET_BYTES;
	return fits ? createContinuousChatLeaf(target.record) : undefined;
}

function failure(
	reason: ContinuousChatCompactionFailureReason,
	replies: number,
	message: string,
	shortest?: ContinuousChatCompactionCandidate,
): ContinuousChatCompactionOutcome {
	return { status: "failed", reason, replies, message, shortest };
}

/** A port error raised after cancellation is a cancellation: the caller stopped the run, not the model. */
function portFailure(
	signal: AbortSignal | undefined,
	replies: number,
	error: unknown,
	shortest?: ContinuousChatCompactionCandidate,
): ContinuousChatCompactionOutcome {
	if (signal?.aborted) return { status: "cancelled", replies };
	return failure("port-error", replies, safeErrorMessage(error, "Continuous-chat port failed."), shortest);
}

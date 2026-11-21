/** Retains accepted per-message provider conversion within a single request scope. */

import { countHistoryWork, historyWorkFallback } from "@caupulican/pi-ai/history-work";
import type { ProviderToolSurface } from "@caupulican/pi-ai/stream";
import type { Api, Context, Message, Model } from "@caupulican/pi-ai/types";
import {
	immutableHistoryMessage,
	isImmutableHistoryMessage,
	type MessageHistoryVersion,
	messageHistoryVersion,
	unchangedMessagePrefix,
} from "./message-revision.ts";
import type { captureProviderMessageConverter } from "./messages.ts";
import type { AgentMessage } from "./types.ts";

/** Stable wire-envelope identity. Message bodies deliberately stay outside this scope. */
export function providerMessageProjectionScope(options: {
	model: Model<Api>;
	account: string | undefined;
	context: Pick<Context, "systemPrompt" | "tools">;
	policy: string | undefined;
	blockImages?: boolean;
	conversation?: string;
	protocol?: unknown;
}): string | undefined {
	const { model, account, context, policy, blockImages, conversation, protocol } = options;
	if (account === undefined) return undefined;
	try {
		return JSON.stringify([
			model,
			account,
			context.systemPrompt,
			context.tools,
			policy,
			blockImages,
			conversation,
			protocol,
		]);
	} catch {
		return undefined;
	}
}

type Conversion = NonNullable<ReturnType<typeof captureProviderMessageConverter>>;

interface ProjectedHistory {
	readonly identityPrefix: number;
	readonly scope: string;
	readonly version: MessageHistoryVersion | undefined;
	readonly sources: AgentMessage[];
	/** Cumulative wire count by source position, including filtered source messages. */
	readonly offsets: number[];
	readonly messages: readonly Message[];
	final?: {
		readonly messages: readonly Message[];
		readonly compactablePrefix: number;
		readonly imageFreeHistoryLength: number;
		readonly scope: string;
	};
	disclosure?: {
		readonly surface: ProviderToolSurface;
		readonly historyLength: number;
		readonly durableVersion: MessageHistoryVersion;
		readonly durableLength: number;
		readonly imageFree: boolean;
		readonly requestOnly: { readonly start: number; readonly count: number };
	};
}

const acceptedHistories = new WeakMap<object, ProjectedHistory>();

export function projectProviderMessages(options: {
	owner: object | undefined;
	work: object;
	scope: string | undefined;
	converter: Conversion;
	messages: AgentMessage[];
	head: number;
}) {
	const { owner, work, scope, converter, messages, head } = options;
	const version = messageHistoryVersion(messages);
	const retained = owner && scope !== undefined ? acceptedHistories.get(owner) : undefined;
	const previous = retained?.scope === scope ? retained : undefined;
	if (retained && !previous) historyWorkFallback(work, "provider projection scope changed");
	let shared = 0;
	if (previous) {
		const currentPrefix =
			version ?? messageHistoryVersion(messages, Math.min(messages.length, previous.offsets.length - 1));
		if (currentPrefix && previous.version) {
			shared = Math.min(unchangedMessagePrefix(previous.version, currentPrefix), previous.offsets.length - 1);
		} else {
			// Host plans may assemble a new array. Only previously certified immutable rows can match here.
			const bound = Math.min(previous.sources.length, messages.length);
			while (shared < bound && previous.sources[shared] === messages[shared]) shared++;
			countHistoryWork(work, "oldRowsRead", Math.min(shared + 1, bound));
		}
		if (shared === 0 && previous.offsets.length > 1) {
			historyWorkFallback(work, "provider projection prefix changed");
		}
	}
	const reusedWire = previous?.offsets[shared] ?? 0;
	let identityPrefix = Math.min(shared, previous?.identityPrefix ?? 0);
	const canBorrow =
		owner !== undefined && scope !== undefined && Object.isFrozen(messages) && identityPrefix === shared;
	let wire: Message[] | undefined = canBorrow ? undefined : previous ? previous.messages.slice(0, reusedWire) : [];
	const offsets: number[] = [];
	// Assembled plans lack an owner version. Keep evidence only for their immutable rows.
	const sources: AgentMessage[] = [];
	if (wire) countHistoryWork(work, "copiedRows", reusedWire);
	let retain = owner !== undefined && scope !== undefined;
	let stableWire = retain;
	let retainedSourceCount = shared;
	for (let index = shared; index < messages.length; index++) {
		const message = messages[index]!;
		const converted = converter.convert(message);
		// Both the cached output and the source proving it must remain stable across requests.
		const stableSource = isImmutableHistoryMessage(message);
		if (retain && !stableSource) {
			retain = false;
			historyWorkFallback(work, "mutable provider projection row");
		}
		const stable = stableSource && converted ? immutableHistoryMessage(converted) : undefined;
		if (retain && converted && !stable) {
			retain = false;
			historyWorkFallback(work, "unowned provider conversion");
		}
		const identity = converted === message && stable === message;
		if (identityPrefix === index && identity) identityPrefix++;
		if (!wire && !identity) {
			wire = previous ? previous.messages.slice(0, reusedWire) : [];
			countHistoryWork(work, "copiedRows", reusedWire);
			for (let earlier = shared; earlier < index; earlier++) wire.push(messages[earlier] as Message);
		}
		if (converted) {
			if (!stable) stableWire = false;
			wire?.push((stable as Message | undefined) ?? converted);
		}
		offsets.push(wire?.length ?? index + 1);
		if (retain) {
			retainedSourceCount = index + 1;
			if (!version) sources.push(message);
		}
	}
	const borrowed = wire === undefined;
	wire ??= messages as Message[];
	const convertedRows = messages.length - shared;
	countHistoryWork(work, "projectedRows", convertedRows);
	countHistoryWork(work, "providerRowsConverted", convertedRows);

	const wireCountAt = (index: number): number =>
		index <= shared ? (previous?.offsets[index] ?? 0) : offsets[index - shared - 1]!;
	const headWire = wireCountAt(head);
	const retainedWire = wireCountAt(retainedSourceCount);

	return {
		wire,
		borrowed,
		headWire,
		stableWire,
		previousFinal: previous?.final,
		previousDisclosure: previous?.disclosure,
		reusedWire,
		prepareAcceptance(
			final: ProjectedHistory["final"],
			insertedCount: number,
			disclosure?: ProjectedHistory["disclosure"],
		): (() => void) | undefined {
			if (!owner || scope === undefined) return undefined;
			let acceptedWire = final && final.compactablePrefix >= retainedWire ? final.messages : undefined;
			if (!acceptedWire) {
				const prefix = wire.slice(0, Math.min(headWire, retainedWire));
				for (let index = headWire; index < retainedWire; index++)
					prefix.push(wire[index + (borrowed ? 0 : insertedCount)]!);
				countHistoryWork(work, "copiedRows", retainedWire);
				acceptedWire = prefix;
			}
			const snapshot = acceptedWire;
			const retainedVersion = version ?? messageHistoryVersion(messages, retainedSourceCount);
			return () => {
				if (acceptedHistories.get(owner) !== retained) return;
				// Only acceptance can extend the previous index. This avoids copying it on append.
				const acceptedOffsets = previous?.offsets ?? [0];
				acceptedOffsets.length = shared + 1;
				for (let index = 0; index < retainedSourceCount - shared; index++) {
					acceptedOffsets.push(offsets[index]!);
				}
				const acceptedSources = !version && previous ? previous.sources : [];
				if (!version && acceptedSources.length >= shared) {
					acceptedSources.length = shared;
					for (const source of sources) acceptedSources.push(source);
				}
				acceptedHistories.set(owner, {
					identityPrefix: Math.min(identityPrefix, retainedSourceCount),
					scope,
					version: retainedVersion,
					sources: acceptedSources,
					offsets: acceptedOffsets,
					messages: snapshot,
					final,
					disclosure,
				});
			};
		},
	};
}

/** Fresh, bounded request-only sections use the same captured conversion policy. */
export function convertProviderWireRows(rows: readonly AgentMessage[], converter: Conversion): Message[] {
	const wire: Message[] = [];
	for (const row of rows) {
		const converted = converter.convert(row);
		if (converted) wire.push((immutableHistoryMessage(converted) as Message | undefined) ?? converted);
	}
	return wire;
}

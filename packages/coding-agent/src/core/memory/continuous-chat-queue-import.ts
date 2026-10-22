import { createReadStream } from "node:fs";
import { hasOnlyKeys, isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import { ContinuousChatCorruptError } from "./continuous-chat-index.ts";
import { checkpointContinuousChatRecovery } from "./continuous-chat-recovery.ts";
import { parseContinuousChatNodeCoordinate } from "./continuous-chat-tree.ts";
import type { ContinuousChatBlockedWork, ContinuousChatWorkItem } from "./continuous-chat-work-queue.ts";
import { CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS } from "./continuous-chat-work-queue.ts";

type QueueArray = "readyLeaves" | "readyParents" | "running" | "blocked" | "halfBuilt";
const ARRAYS: readonly string[] = ["readyLeaves", "readyParents", "running", "blocked", "halfBuilt"];
const SCALARS = ["schemaVersion", "revision", "generation", "totalMessages", "nextLeaf", "leafStreak"] as const;

export interface LegacyQueueHeader {
	origin: "fresh" | "legacy-replay-v1";
	revision: number;
	generation: number;
	totalMessages: number;
	nextLeaf: number;
	leafStreak: number;
}

export interface LegacyQueueEntry {
	list: QueueArray;
	item: ContinuousChatWorkItem;
	blocked?: ContinuousChatBlockedWork;
}

/** Strict JSON tokens, bounded even for damaged input. No whole-file or whole-array buffer. */
async function* tokens(path: string, signal?: AbortSignal): AsyncGenerator<string> {
	let pending = "";
	let quoted = false;
	let escaped = false;
	for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024, signal })) {
		await checkpointContinuousChatRecovery(signal);
		for (const char of chunk) {
			if (quoted) {
				pending += char;
				if (pending.length > 8192) throw new ContinuousChatCorruptError(path, "Legacy queue token is too large");
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') {
					quoted = false;
					yield pending;
					pending = "";
				}
				continue;
			}
			if ('{}[]:,"'.includes(char) || /[ \t\r\n]/u.test(char)) {
				if (pending) {
					yield pending;
					pending = "";
				}
				if (char === '"') {
					quoted = true;
					pending = char;
				} else if (!/[ \t\r\n]/u.test(char)) yield char;
			} else {
				pending += char;
				if (pending.length > 128) throw new ContinuousChatCorruptError(path, "Invalid legacy queue token");
			}
		}
	}
	signal?.throwIfAborted();
	if (quoted) throw new ContinuousChatCorruptError(path, "Unterminated legacy queue string");
	if (pending) yield pending;
}

class QueueJsonReader {
	private readonly source: AsyncIterator<string>;
	private readonly path: string;
	private peeked: string | undefined;

	constructor(path: string, signal?: AbortSignal) {
		this.path = path;
		this.source = tokens(path, signal)[Symbol.asyncIterator]();
	}
	async next(): Promise<string | undefined> {
		if (this.peeked !== undefined) {
			const value = this.peeked;
			this.peeked = undefined;
			return value;
		}
		return (await this.source.next()).value;
	}
	async peek(): Promise<string | undefined> {
		this.peeked ??= await this.next();
		return this.peeked;
	}
	async expect(token: string): Promise<void> {
		if ((await this.next()) !== token)
			throw new ContinuousChatCorruptError(this.path, `Expected ${token} in legacy queue`);
	}
	async value(depth = 0): Promise<unknown> {
		if (depth > 4) throw new ContinuousChatCorruptError(this.path, "Legacy queue nesting is too deep");
		const token = await this.next();
		if (token === undefined) throw new ContinuousChatCorruptError(this.path, "Truncated legacy queue");
		if (token === "{") {
			const result: Record<string, unknown> = Object.create(null);
			if ((await this.peek()) === "}") {
				await this.next();
				return result;
			}
			for (;;) {
				const key = await this.key();
				if (Object.hasOwn(result, key) || Object.keys(result).length >= 8)
					throw new ContinuousChatCorruptError(this.path, "Duplicate or oversized queue object");
				result[key] = await this.value(depth + 1);
				const separator = await this.next();
				if (separator === "}") return result;
				if (separator !== ",") throw new ContinuousChatCorruptError(this.path, "Invalid legacy queue object");
			}
		}
		if (token === "[") throw new ContinuousChatCorruptError(this.path, "Unexpected nested queue array");
		try {
			return JSON.parse(token);
		} catch {
			throw new ContinuousChatCorruptError(this.path, "Invalid legacy queue value");
		}
	}
	async key(): Promise<string> {
		const token = await this.next();
		if (!token?.startsWith('"')) throw new ContinuousChatCorruptError(this.path, "Invalid legacy queue key");
		const key: unknown = JSON.parse(token);
		if (typeof key !== "string") throw new ContinuousChatCorruptError(this.path, "Invalid legacy queue key");
		await this.expect(":");
		return key;
	}
	async close(): Promise<void> {
		await this.source.return?.();
	}
}

function parseEntry(path: string, list: QueueArray, value: unknown): LegacyQueueEntry {
	if (list === "readyLeaves") {
		if (!isNonNegativeSafeInteger(value)) throw new ContinuousChatCorruptError(path, "Invalid ready leaf");
		return { list, item: { level: 0, ordinal: value } };
	}
	if (list === "blocked") {
		if (!isPlainRecord(value) || !hasOnlyKeys(value, ["item", "retryAfterGeneration", "reason"]))
			throw new ContinuousChatCorruptError(path, "Invalid blocked work");
		const item = parseContinuousChatNodeCoordinate(value.item);
		if (
			!item ||
			!isNonNegativeSafeInteger(value.retryAfterGeneration) ||
			typeof value.reason !== "string" ||
			!value.reason ||
			Array.from(value.reason).length > CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS
		)
			throw new ContinuousChatCorruptError(path, "Invalid blocked work fields");
		return { list, item, blocked: { item, retryAfterGeneration: value.retryAfterGeneration, reason: value.reason } };
	}
	const item = parseContinuousChatNodeCoordinate(value);
	if (!item || (list === "readyParents" && item.level === 0))
		throw new ContinuousChatCorruptError(path, "Invalid queue coordinate");
	return { list, item };
}

/** Calls consume in source order; the consumer commits bounded batches to an unpublished migration store. */
export async function importLegacyQueue(
	path: string,
	consume: (entry: LegacyQueueEntry) => void | Promise<void>,
	signal?: AbortSignal,
): Promise<LegacyQueueHeader> {
	signal?.throwIfAborted();
	const reader = new QueueJsonReader(path, signal);
	const envelope = new Set<string>();
	const fields = new Map<string, unknown>();
	let origin: unknown;
	let visited = 0;
	try {
		await reader.expect("{");
		for (;;) {
			const key = await reader.key();
			if (envelope.has(key) || !["schemaVersion", "origin", "queue"].includes(key))
				throw new ContinuousChatCorruptError(path, "Invalid queue envelope field");
			envelope.add(key);
			if (key === "queue") {
				await reader.expect("{");
				for (;;) {
					const name = await reader.key();
					if (fields.has(name) || (!ARRAYS.includes(name) && !SCALARS.some((field) => field === name)))
						throw new ContinuousChatCorruptError(path, "Invalid queue field");
					if (ARRAYS.includes(name)) {
						fields.set(name, true);
						await reader.expect("[");
						if ((await reader.peek()) === "]") await reader.next();
						else
							for (;;) {
								await checkpointContinuousChatRecovery(signal, visited++);
								await consume(parseEntry(path, name as QueueArray, await reader.value()));
								const separator = await reader.next();
								if (separator === "]") break;
								if (separator !== ",") throw new ContinuousChatCorruptError(path, "Invalid queue array");
							}
					} else fields.set(name, await reader.value());
					const separator = await reader.next();
					if (separator === "}") break;
					if (separator !== ",") throw new ContinuousChatCorruptError(path, "Invalid queue fields");
				}
			} else {
				const value = await reader.value();
				if (key === "schemaVersion" && value !== 2)
					throw new ContinuousChatCorruptError(path, "Unsupported legacy queue envelope");
				if (key === "origin") origin = value;
			}
			const separator = await reader.next();
			if (separator === "}") break;
			if (separator !== ",") throw new ContinuousChatCorruptError(path, "Invalid queue envelope");
		}
		if (
			(await reader.next()) !== undefined ||
			envelope.size !== 3 ||
			fields.size !== SCALARS.length + ARRAYS.length ||
			fields.get("schemaVersion") !== 2 ||
			(origin !== "fresh" && origin !== "legacy-replay-v1")
		)
			throw new ContinuousChatCorruptError(path, "Incomplete legacy queue");
		for (const key of SCALARS)
			if (!isNonNegativeSafeInteger(fields.get(key)))
				throw new ContinuousChatCorruptError(path, `Invalid queue ${key}`);
		const totalMessages = fields.get("totalMessages") as number;
		const nextLeaf = fields.get("nextLeaf") as number;
		const leafStreak = fields.get("leafStreak") as number;
		if (nextLeaf > totalMessages || leafStreak > 4)
			throw new ContinuousChatCorruptError(path, "Contradictory legacy queue counters");
		signal?.throwIfAborted();
		return {
			origin,
			revision: fields.get("revision") as number,
			generation: fields.get("generation") as number,
			totalMessages,
			nextLeaf,
			leafStreak,
		};
	} finally {
		await reader.close();
	}
}

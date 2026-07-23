import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateFile } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import {
	type AppendOrchestrationEventInput,
	isOrchestrationEvent,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
} from "./contracts.ts";

const EVENT_FILE_PATTERN = /^(\d{16})\.json$/;

interface EventCursor {
	version: 1;
	lastOrdinal: number;
}

interface IdempotencyMarker {
	version: 1;
	key: string;
	ordinal: number;
}

export interface OrchestrationEventStoreOptions {
	agentDir: string;
	sessionId: string;
	now?: () => string;
	createEventId?: () => string;
}

export class OrchestrationEventStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrchestrationEventStoreError";
	}
}

export class OrchestrationConcurrencyError extends OrchestrationEventStoreError {
	constructor(expected: number, actual: number) {
		super(`Orchestration event cursor changed: expected ${expected}, actual ${actual}.`);
		this.name = "OrchestrationConcurrencyError";
	}
}

function safeSessionDirectoryName(sessionId: string): string {
	const readable = encodeURIComponent(sessionId).replaceAll("%", "_").slice(0, 80) || "session";
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return `${readable}-${digest}`;
}

function parseCursor(filePath: string): EventCursor | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || !Number.isSafeInteger(record.lastOrdinal) || Number(record.lastOrdinal) < 0) {
			return undefined;
		}
		return { version: 1, lastOrdinal: Number(record.lastOrdinal) };
	} catch {
		return undefined;
	}
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function eventFileName(ordinal: number): string {
	return `${String(ordinal).padStart(16, "0")}.json`;
}

/**
 * Append-only, one-file-per-event store. Atomic rename prevents torn records; the cursor is only an
 * optimization. If a process dies after the event rename but before the cursor update, the next
 * append observes the occupied ordinal and advances without overwriting the committed event.
 */
export class OrchestrationEventStore {
	readonly rootDir: string;
	readonly eventsDir: string;
	readonly idempotencyDir: string;
	readonly cursorPath: string;
	private readonly now: () => string;
	private readonly createEventId: () => string;
	private readonly listeners = new Set<(event: OrchestrationEvent) => void>();

	constructor(options: OrchestrationEventStoreOptions) {
		this.rootDir = stateFile(options.agentDir, "orchestration", safeSessionDirectoryName(options.sessionId));
		this.eventsDir = join(this.rootDir, "events");
		this.idempotencyDir = join(this.rootDir, "idempotency");
		this.cursorPath = join(this.rootDir, "cursor.json");
		this.now = options.now ?? (() => new Date().toISOString());
		this.createEventId = options.createEventId ?? randomUUID;
	}

	append(input: AppendOrchestrationEventInput, options: { expectedLastOrdinal?: number } = {}): OrchestrationEvent {
		const committed = withFileLockSync(this.cursorPath, (): { event: OrchestrationEvent; appended: boolean } => {
			const actual = this.synchronizeIndexesUnlocked();
			if (input.idempotencyKey) {
				const existing = this.readIdempotentEventUnlocked(input.idempotencyKey);
				if (existing) return { event: existing, appended: false };
			}
			if (options.expectedLastOrdinal !== undefined) {
				if (actual !== options.expectedLastOrdinal) {
					throw new OrchestrationConcurrencyError(options.expectedLastOrdinal, actual);
				}
			}

			const ordinal = actual + 1;
			const next: OrchestrationEvent = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				ordinal,
				eventId: this.createEventId(),
				type: input.type,
				aggregateId: input.aggregateId,
				actor: input.actor,
				occurredAt: this.now(),
				...(input.correlationId ? { correlationId: input.correlationId } : {}),
				...(input.causationId ? { causationId: input.causationId } : {}),
				...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
				payload: structuredClone(input.payload),
			};
			writeFileAtomicSync(join(this.eventsDir, eventFileName(ordinal)), serialize(next));
			if (input.idempotencyKey) this.writeIdempotencyMarkerUnlocked(input.idempotencyKey, ordinal);
			writeFileAtomicSync(this.cursorPath, serialize({ version: 1, lastOrdinal: ordinal } satisfies EventCursor));
			return { event: next, appended: true };
		});

		if (committed.appended) {
			for (const listener of this.listeners) listener(structuredClone(committed.event));
		}
		return structuredClone(committed.event);
	}

	readAll(): OrchestrationEvent[] {
		return this.readAllUnlocked();
	}

	readAfter(ordinal: number): OrchestrationEvent[] {
		const events: OrchestrationEvent[] = [];
		let previousOrdinal = ordinal;
		for (const name of this.eventFileNamesUnlocked()) {
			const match = EVENT_FILE_PATTERN.exec(name);
			if (!match) continue;
			const fileOrdinal = Number(match[1]);
			if (fileOrdinal <= ordinal) continue;
			const event = this.readEventFileUnlocked(name);
			if (event.ordinal !== fileOrdinal || event.ordinal <= previousOrdinal) {
				throw new OrchestrationEventStoreError(`Non-monotonic orchestration event ordinal in ${name}`);
			}
			previousOrdinal = event.ordinal;
			events.push(structuredClone(event));
		}
		return events;
	}

	subscribe(listener: (event: OrchestrationEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private readAllUnlocked(): OrchestrationEvent[] {
		const names = this.eventFileNamesUnlocked();
		const events: OrchestrationEvent[] = [];
		let previousOrdinal = 0;
		for (const name of names) {
			const match = EVENT_FILE_PATTERN.exec(name);
			if (!match) continue;
			const parsed = this.readEventFileUnlocked(name);
			const fileOrdinal = Number(match[1]);
			if (parsed.ordinal !== fileOrdinal || parsed.ordinal <= previousOrdinal) {
				throw new OrchestrationEventStoreError(`Non-monotonic orchestration event ordinal in ${name}`);
			}
			previousOrdinal = parsed.ordinal;
			events.push(structuredClone(parsed));
		}
		return events;
	}

	private eventFileNamesUnlocked(): string[] {
		try {
			return readdirSync(this.eventsDir)
				.filter((candidate) => EVENT_FILE_PATTERN.test(candidate))
				.sort();
		} catch {
			return [];
		}
	}

	private readEventFileUnlocked(name: string): OrchestrationEvent {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(this.eventsDir, name), "utf-8"));
		} catch (error) {
			throw new OrchestrationEventStoreError(
				`Failed to parse orchestration event ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isOrchestrationEvent(parsed)) {
			throw new OrchestrationEventStoreError(`Invalid orchestration event record: ${name}`);
		}
		return parsed;
	}

	private idempotencyPath(key: string): string {
		return join(this.idempotencyDir, `${createHash("sha256").update(key).digest("hex")}.json`);
	}

	private writeIdempotencyMarkerUnlocked(key: string, ordinal: number): void {
		writeFileAtomicSync(
			this.idempotencyPath(key),
			serialize({ version: 1, key, ordinal } satisfies IdempotencyMarker),
		);
	}

	private readIdempotentEventUnlocked(key: string): OrchestrationEvent | undefined {
		const markerPath = this.idempotencyPath(key);
		if (!existsSync(markerPath)) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
		} catch (error) {
			throw new OrchestrationEventStoreError(
				`Failed to parse orchestration idempotency marker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new OrchestrationEventStoreError("Invalid orchestration idempotency marker.");
		}
		const marker = parsed as Record<string, unknown>;
		if (marker.version !== 1 || marker.key !== key || !Number.isSafeInteger(marker.ordinal)) {
			throw new OrchestrationEventStoreError("Invalid orchestration idempotency marker.");
		}
		const ordinal = Number(marker.ordinal);
		const event = this.readEventFileUnlocked(eventFileName(ordinal));
		if (event.ordinal !== ordinal || event.idempotencyKey !== key) {
			throw new OrchestrationEventStoreError("Orchestration idempotency marker does not match its event.");
		}
		return event;
	}

	/**
	 * Reconcile only the crash tail when an event rename committed before its marker/cursor. Normal
	 * appends read directory metadata plus one marker, never the accumulated event payload prefix.
	 */
	private synchronizeIndexesUnlocked(): number {
		const names = this.eventFileNamesUnlocked();
		const highest = names.length > 0 ? Number(EVENT_FILE_PATTERN.exec(names.at(-1)!)?.[1] ?? 0) : 0;
		const cursor = parseCursor(this.cursorPath);
		if (cursor?.lastOrdinal === highest) return highest;
		if (cursor && cursor.lastOrdinal > highest) {
			throw new OrchestrationEventStoreError(
				`Orchestration cursor ${cursor.lastOrdinal} is ahead of the last committed event ${highest}.`,
			);
		}
		const rebuildFrom =
			cursor && cursor.lastOrdinal >= 0 && cursor.lastOrdinal <= highest ? cursor.lastOrdinal + 1 : 1;
		for (const name of names) {
			const ordinal = Number(EVENT_FILE_PATTERN.exec(name)?.[1] ?? 0);
			if (ordinal < rebuildFrom) continue;
			const event = this.readEventFileUnlocked(name);
			if (event.ordinal !== ordinal) {
				throw new OrchestrationEventStoreError(`Event ordinal does not match file name: ${name}`);
			}
			if (event.idempotencyKey) this.writeIdempotencyMarkerUnlocked(event.idempotencyKey, ordinal);
		}
		writeFileAtomicSync(this.cursorPath, serialize({ version: 1, lastOrdinal: highest } satisfies EventCursor));
		return highest;
	}
}

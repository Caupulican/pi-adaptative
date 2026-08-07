import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { orchestrationEventStoreDir } from "../agent-paths.ts";
import type { JsonObject } from "../autonomy/contracts.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import {
	type AppendOrchestrationEventInput,
	isOrchestrationEvent,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
	MAX_ORCHESTRATION_SNAPSHOT_IDEMPOTENCY_BYTES,
	ORCHESTRATION_EVENT_TYPES,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
	toJsonObject,
} from "./contracts.ts";

const EVENT_FILE_PATTERN = /^(\d{16})\.json$/;
const SNAPSHOT_FILE_PATTERN = /^(\d{16})\.json$/;
const DEFAULT_MAX_TAIL_EVENTS = 256;
const DEFAULT_MAX_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_IDEMPOTENCY_EVENTS = 512;
const MAX_CONFIGURED_TAIL_EVENTS = 1_024;
const MAX_CONFIGURED_TAIL_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_IDEMPOTENCY_EVENTS = 1_024;
const MAX_EVENT_DIRECTORY_ENTRIES = 2_048;
const MAX_IDEMPOTENCY_DIRECTORY_ENTRIES = 2_048;
const MAX_SNAPSHOT_DIRECTORY_ENTRIES = 8;
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_BASELINE_BYTES = 64 * 1024;
const ORCHESTRATION_ACTORS = ["human", "kernel", "runtime", "policy", "router", "worker"] as const;
const APPEND_INPUT_FIELDS = [
	"type",
	"aggregateId",
	"actor",
	"correlationId",
	"causationId",
	"idempotencyKey",
	"payload",
] as const;
const EVENT_FIELDS = [
	"schemaVersion",
	"ordinal",
	"eventId",
	"type",
	"aggregateId",
	"actor",
	"occurredAt",
	"correlationId",
	"causationId",
	"idempotencyKey",
	"payload",
] as const;
const SNAPSHOT_FIELDS = [
	"version",
	"schemaVersion",
	"throughOrdinal",
	"createdAt",
	"projection",
	"idempotencyEvents",
	"digest",
] as const;
const BASELINE_FIELDS = ["version", "throughOrdinal", "digest", "snapshotFile"] as const;

interface EventCursor {
	version: 1;
	lastOrdinal: number;
	tailBytes?: number;
}

interface SynchronizedIndexes {
	baselineOrdinal: number;
	baselineDigest: string | undefined;
	lastOrdinal: number;
	tailBytes: number;
	idempotencyEvents: Map<string, OrchestrationEvent>;
}

interface ProjectionSnapshotContent {
	version: 1;
	schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
	throughOrdinal: number;
	createdAt: string;
	projection: JsonObject;
	idempotencyEvents: OrchestrationEvent[];
}

interface ProjectionSnapshot extends ProjectionSnapshotContent {
	digest: string;
}

interface SnapshotBaseline {
	version: 1;
	throughOrdinal: number;
	digest: string;
	snapshotFile: string;
}

interface SnapshotFileSignature {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

interface VerifiedSnapshotBaseline {
	baseline: SnapshotBaseline;
	signature: SnapshotFileSignature;
	idempotencyEvents: OrchestrationEvent[];
}

export interface OrchestrationEventStoreOptions {
	agentDir: string;
	sessionId: string;
	now?: () => string;
	createEventId?: () => string;
	maxTailEvents?: number;
	maxTailBytes?: number;
	maxIdempotencyEvents?: number;
}

export interface AppendOrchestrationEventOptions {
	expectedLastOrdinal?: number;
	/** Exact event admission under the append lock, before any durable file is written. */
	validateBeforeCommit?: (event: OrchestrationEvent) => void;
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

export class OrchestrationSnapshotRequiredError extends OrchestrationEventStoreError {
	readonly throughOrdinal: number;

	constructor(throughOrdinal: number) {
		super(`Orchestration projection snapshot through ordinal ${throughOrdinal} is required.`);
		this.name = "OrchestrationSnapshotRequiredError";
		this.throughOrdinal = throughOrdinal;
	}
}

function parseCursor(filePath: string): EventCursor | undefined {
	if (!existsSync(filePath)) return undefined;
	let content: string;
	try {
		content = readBoundedTextFileSync(filePath, MAX_CURSOR_BYTES, "Orchestration cursor");
	} catch (error) {
		throw new OrchestrationEventStoreError(
			`Failed to read orchestration cursor: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || !Number.isSafeInteger(record.lastOrdinal) || Number(record.lastOrdinal) < 0) {
			return undefined;
		}
		if (record.tailBytes !== undefined && (!Number.isSafeInteger(record.tailBytes) || Number(record.tailBytes) < 0)) {
			return undefined;
		}
		return {
			version: 1,
			lastOrdinal: Number(record.lastOrdinal),
			...(record.tailBytes !== undefined ? { tailBytes: Number(record.tailBytes) } : {}),
		};
	} catch {
		return undefined;
	}
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function serializeCompact(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function serializeBounded(
	value: unknown,
	maxBytes: number,
	label: string,
	oversizedMessage = `${label} exceeds its byte limit.`,
): string {
	const serialized = serialize(value);
	if (Buffer.byteLength(serialized, "utf-8") > maxBytes) {
		throw new OrchestrationEventStoreError(oversizedMessage);
	}
	return serialized;
}

function serializeCompactBounded(value: unknown, maxBytes: number, label: string): string {
	const serialized = serializeCompact(value);
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
		throw new OrchestrationEventStoreError(`${label} exceeds its byte limit.`);
	}
	return serialized;
}

function isCanonicalIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH &&
		value.trim() === value
	);
}

function canonicalIdentifier(value: unknown, label: string): string {
	if (!isCanonicalIdentifier(value)) {
		throw new OrchestrationEventStoreError(
			`${label} must be a non-empty canonical identifier of at most ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH} characters.`,
		);
	}
	return value;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function canonicalIsoTimestamp(value: unknown, label: string): string {
	if (!isCanonicalIsoTimestamp(value)) {
		throw new OrchestrationEventStoreError(`${label} must be a canonical ISO-8601 timestamp.`);
	}
	return value;
}

function canonicalJsonObject(value: unknown, label: string): JsonObject {
	try {
		return toJsonObject(value);
	} catch (error) {
		throw new OrchestrationEventStoreError(
			`${label} must be a finite JSON object: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function hasExactFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
	const actualFields = Object.keys(record);
	return actualFields.length === fields.length && fields.every((field) => Object.hasOwn(record, field));
}

function normalizeAppendInput(input: AppendOrchestrationEventInput): AppendOrchestrationEventInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new OrchestrationEventStoreError("Orchestration append input must be an object.");
	}
	const raw = input as unknown as Record<string, unknown>;
	const unsupportedField = Object.keys(raw).find(
		(field) => !APPEND_INPUT_FIELDS.some((candidate) => candidate === field),
	);
	if (unsupportedField) {
		throw new OrchestrationEventStoreError(`Orchestration append input field '${unsupportedField}' is unsupported.`);
	}
	const type = ORCHESTRATION_EVENT_TYPES.find((candidate) => candidate === raw.type);
	if (!type) {
		throw new OrchestrationEventStoreError(`Orchestration event type '${String(raw.type)}' is invalid.`);
	}
	const actor = ORCHESTRATION_ACTORS.find((candidate) => candidate === raw.actor);
	if (!actor) {
		throw new OrchestrationEventStoreError(`Orchestration event actor '${String(raw.actor)}' is invalid.`);
	}
	const correlationId =
		raw.correlationId === undefined
			? undefined
			: canonicalIdentifier(raw.correlationId, "Orchestration correlation id");
	const causationId =
		raw.causationId === undefined ? undefined : canonicalIdentifier(raw.causationId, "Orchestration causation id");
	const idempotencyKey =
		raw.idempotencyKey === undefined
			? undefined
			: canonicalIdentifier(raw.idempotencyKey, "Orchestration idempotency key");
	return {
		type,
		aggregateId: canonicalIdentifier(raw.aggregateId, "Orchestration aggregate id"),
		actor,
		...(correlationId ? { correlationId } : {}),
		...(causationId ? { causationId } : {}),
		...(idempotencyKey ? { idempotencyKey } : {}),
		payload: canonicalJsonObject(raw.payload, "Orchestration event payload"),
	};
}

function isCanonicalOrchestrationEvent(value: unknown): value is OrchestrationEvent {
	if (!isOrchestrationEvent(value)) return false;
	if (Object.keys(value).some((field) => !EVENT_FIELDS.some((candidate) => candidate === field))) return false;
	if (!isCanonicalIdentifier(value.eventId) || !isCanonicalIdentifier(value.aggregateId)) return false;
	if (!isCanonicalIsoTimestamp(value.occurredAt)) return false;
	if (value.correlationId !== undefined && !isCanonicalIdentifier(value.correlationId)) return false;
	if (value.causationId !== undefined && !isCanonicalIdentifier(value.causationId)) return false;
	if (value.idempotencyKey !== undefined && !isCanonicalIdentifier(value.idempotencyKey)) return false;
	try {
		toJsonObject(value.payload);
		return true;
	} catch {
		return false;
	}
}

function assertCanonicalOrchestrationEvent(value: unknown): asserts value is OrchestrationEvent {
	if (!isCanonicalOrchestrationEvent(value)) {
		throw new OrchestrationEventStoreError("Constructed orchestration event is not canonical.");
	}
}

function observeListenerResult(value: unknown): void {
	if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
	let then: unknown;
	try {
		then = (value as { then?: unknown }).then;
	} catch {
		return;
	}
	if (typeof then === "function") void Promise.resolve(value).catch(() => {});
}

function boundedIdempotencyEvents(events: readonly OrchestrationEvent[], maxEvents: number): OrchestrationEvent[] {
	const selectedNewestFirst: OrchestrationEvent[] = [];
	let serializedBytes = 2;
	for (const event of [...events].sort((left, right) => right.ordinal - left.ordinal)) {
		if (selectedNewestFirst.length >= maxEvents) break;
		const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
		const nextBytes = serializedBytes + (selectedNewestFirst.length > 0 ? 1 : 0) + eventBytes;
		if (nextBytes > MAX_ORCHESTRATION_SNAPSHOT_IDEMPOTENCY_BYTES) continue;
		selectedNewestFirst.push(structuredClone(event));
		serializedBytes = nextBytes;
	}
	return selectedNewestFirst.reverse();
}

function assertExactIdempotentReplay(existing: OrchestrationEvent, input: AppendOrchestrationEventInput): void {
	const matches =
		existing.type === input.type &&
		existing.aggregateId === input.aggregateId &&
		existing.actor === input.actor &&
		existing.correlationId === (input.correlationId || undefined) &&
		existing.causationId === (input.causationId || undefined) &&
		isDeepStrictEqual(existing.payload, input.payload);
	if (!matches) {
		throw new OrchestrationEventStoreError(
			`Orchestration idempotency key '${input.idempotencyKey}' was reused with conflicting event content.`,
		);
	}
}

function eventFileName(ordinal: number): string {
	return `${String(ordinal).padStart(16, "0")}.json`;
}

function snapshotDigest(content: ProjectionSnapshotContent): string {
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function positiveSafeInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new OrchestrationEventStoreError(`${label} must be a positive safe integer.`);
	}
	if (resolved > maximum) throw new OrchestrationEventStoreError(`${label} must not exceed ${maximum}.`);
	return resolved;
}

/**
 * Append-only event tail with a replaceable full-state projection snapshot. Each immutable event is
 * its own commit record: idempotency data is derived directly from the bounded tail, while a small
 * mutable cursor remains only as a corruption high-water mark. Atomic rename prevents torn event
 * records without multiplying one transition into per-key marker files and atomic cursor rewrites.
 * Snapshot publication is two-phase (payload, then small baseline pointer), after which covered event
 * and legacy-index files are pruned. A crash at any point leaves either the old replay prefix or the
 * new verified snapshot authoritative; ordinals never reset.
 */
export class OrchestrationEventStore {
	readonly rootDir: string;
	readonly eventsDir: string;
	readonly idempotencyDir: string;
	readonly cursorPath: string;
	readonly snapshotsDir: string;
	readonly baselinePath: string;
	private readonly now: () => string;
	private readonly createEventId: () => string;
	private readonly maxTailEvents: number;
	private readonly maxTailBytes: number;
	private readonly maxIdempotencyEvents: number;
	private readonly listeners = new Set<(event: OrchestrationEvent) => void>();
	private verifiedSnapshotBaseline: VerifiedSnapshotBaseline | undefined;
	private synchronizedIndexes: SynchronizedIndexes | undefined;

	constructor(options: OrchestrationEventStoreOptions) {
		this.rootDir = orchestrationEventStoreDir(options.agentDir, options.sessionId);
		this.eventsDir = join(this.rootDir, "events");
		this.idempotencyDir = join(this.rootDir, "idempotency");
		this.cursorPath = join(this.rootDir, "cursor.json");
		this.snapshotsDir = join(this.rootDir, "snapshots");
		this.baselinePath = join(this.rootDir, "projection-baseline.json");
		this.now = options.now ?? (() => new Date().toISOString());
		this.createEventId = options.createEventId ?? randomUUID;
		this.maxTailEvents = positiveSafeInteger(
			options.maxTailEvents,
			DEFAULT_MAX_TAIL_EVENTS,
			MAX_CONFIGURED_TAIL_EVENTS,
			"maxTailEvents",
		);
		this.maxTailBytes = positiveSafeInteger(
			options.maxTailBytes,
			DEFAULT_MAX_TAIL_BYTES,
			MAX_CONFIGURED_TAIL_BYTES,
			"maxTailBytes",
		);
		this.maxIdempotencyEvents = positiveSafeInteger(
			options.maxIdempotencyEvents,
			DEFAULT_MAX_IDEMPOTENCY_EVENTS,
			MAX_CONFIGURED_IDEMPOTENCY_EVENTS,
			"maxIdempotencyEvents",
		);
	}

	append(input: AppendOrchestrationEventInput, options: AppendOrchestrationEventOptions = {}): OrchestrationEvent {
		const normalizedInput = normalizeAppendInput(input);
		if (
			options.expectedLastOrdinal !== undefined &&
			(!Number.isSafeInteger(options.expectedLastOrdinal) || options.expectedLastOrdinal < 0)
		) {
			throw new OrchestrationEventStoreError("Expected orchestration ordinal must be a non-negative safe integer.");
		}
		const committed = withFileLockSync(this.cursorPath, (): { event: OrchestrationEvent; appended: boolean } => {
			const indexes = this.synchronizeIndexesUnlocked();
			const actual = indexes.lastOrdinal;
			if (normalizedInput.idempotencyKey) {
				const existing = indexes.idempotencyEvents.get(normalizedInput.idempotencyKey);
				if (existing) {
					assertExactIdempotentReplay(existing, normalizedInput);
					return { event: existing, appended: false };
				}
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
				type: normalizedInput.type,
				aggregateId: normalizedInput.aggregateId,
				actor: normalizedInput.actor,
				occurredAt: this.now(),
				...(normalizedInput.correlationId ? { correlationId: normalizedInput.correlationId } : {}),
				...(normalizedInput.causationId ? { causationId: normalizedInput.causationId } : {}),
				...(normalizedInput.idempotencyKey ? { idempotencyKey: normalizedInput.idempotencyKey } : {}),
				payload: normalizedInput.payload,
			};
			assertCanonicalOrchestrationEvent(next);
			const serializedEvent = serializeBounded(
				next,
				this.maxTailBytes,
				"Orchestration event",
				"Orchestration event exceeds its configured tail byte limit.",
			);
			options.validateBeforeCommit?.(next);
			const nextTailBytes = indexes.tailBytes + Buffer.byteLength(serializedEvent);
			const serializedCursor = serializeBounded(
				{ version: 1, lastOrdinal: ordinal, tailBytes: nextTailBytes } satisfies EventCursor,
				MAX_CURSOR_BYTES,
				"Orchestration cursor",
			);
			writeFileAtomicSync(join(this.eventsDir, eventFileName(ordinal)), serializedEvent);
			indexes.lastOrdinal = ordinal;
			indexes.tailBytes = nextTailBytes;
			if (normalizedInput.idempotencyKey) indexes.idempotencyEvents.set(normalizedInput.idempotencyKey, next);
			// The immutable event is authoritative. The cursor is only a corruption high-water mark,
			// so a lock-protected direct overwrite avoids another tmp-file creation and rename on the
			// Windows scanner-sensitive path; a torn cursor is safely rebuilt from the event tail.
			writeFileSync(this.cursorPath, serializedCursor, "utf-8");
			return { event: next, appended: true };
		});

		if (committed.appended) {
			for (const listener of [...this.listeners]) {
				try {
					observeListenerResult(listener(structuredClone(committed.event)) as unknown);
				} catch {
					// The event is already durable. Observer failures cannot turn a committed transition into a reported failure.
				}
			}
		}
		return structuredClone(committed.event);
	}

	readAll(): OrchestrationEvent[] {
		return this.readAllUnlocked();
	}

	readAfter(ordinal: number): OrchestrationEvent[] {
		const baseline = this.readBaselineUnlocked();
		if (baseline && ordinal < baseline.throughOrdinal) {
			throw new OrchestrationSnapshotRequiredError(baseline.throughOrdinal);
		}
		const events: OrchestrationEvent[] = [];
		const names = this.eventFileNamesUnlocked();
		this.assertReadableTailUnlocked(names, baseline?.throughOrdinal ?? 0);
		let previousOrdinal = ordinal;
		for (const name of names) {
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

	readProjectionSnapshot(): { throughOrdinal: number; projection: JsonObject } | undefined {
		const snapshot = this.readProjectionSnapshotUnlocked();
		return snapshot
			? { throughOrdinal: snapshot.throughOrdinal, projection: structuredClone(snapshot.projection) }
			: undefined;
	}

	/** Replace a large replay prefix with one verified current-state snapshot and a bounded tail. */
	compactIfNeeded(throughOrdinal: number, projection: () => JsonObject): boolean {
		const baselineBeforeLock = this.readBaselineUnlocked();
		const baselineOrdinalBeforeLock = baselineBeforeLock?.throughOrdinal ?? 0;
		const cachedIndexes = this.synchronizedIndexes;
		if (
			cachedIndexes?.baselineOrdinal === baselineOrdinalBeforeLock &&
			cachedIndexes.baselineDigest === baselineBeforeLock?.digest &&
			cachedIndexes.lastOrdinal === throughOrdinal &&
			throughOrdinal - baselineOrdinalBeforeLock < this.maxTailEvents &&
			cachedIndexes.tailBytes < this.maxTailBytes
		) {
			return false;
		}
		const cursorBeforeLock = parseCursor(this.cursorPath);
		if (
			!cachedIndexes &&
			cursorBeforeLock?.lastOrdinal === throughOrdinal &&
			cursorBeforeLock.tailBytes !== undefined &&
			throughOrdinal - baselineOrdinalBeforeLock < this.maxTailEvents &&
			cursorBeforeLock.tailBytes < this.maxTailBytes
		) {
			return false;
		}
		return withFileLockSync(this.cursorPath, () => {
			const cursor = this.synchronizeIndexesUnlocked();
			if (cursor.lastOrdinal !== throughOrdinal) return false;
			const baselineOrdinal = this.readBaselineUnlocked()?.throughOrdinal ?? 0;
			const tailNames = this.eventFileNamesUnlocked().filter(
				(name) => Number(EVENT_FILE_PATTERN.exec(name)?.[1] ?? 0) > baselineOrdinal,
			);
			if (tailNames.length < this.maxTailEvents && cursor.tailBytes < this.maxTailBytes) return false;

			const retainedByKey = new Map<string, OrchestrationEvent>();
			for (const event of this.readProjectionSnapshotUnlocked()?.idempotencyEvents ?? []) {
				if (event.idempotencyKey) retainedByKey.set(event.idempotencyKey, event);
			}
			for (const name of tailNames) {
				const event = this.readEventFileUnlocked(name);
				if (event.ordinal <= throughOrdinal && event.idempotencyKey) {
					retainedByKey.set(event.idempotencyKey, event);
				}
			}
			const idempotencyEvents = boundedIdempotencyEvents([...retainedByKey.values()], this.maxIdempotencyEvents);
			const canonicalProjection = canonicalJsonObject(projection(), "Orchestration projection snapshot");
			const content: ProjectionSnapshotContent = {
				version: 1,
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				throughOrdinal,
				createdAt: canonicalIsoTimestamp(this.now(), "Orchestration projection snapshot creation time"),
				projection: canonicalProjection,
				idempotencyEvents,
			};
			const digest = snapshotDigest(content);
			const snapshotFile = eventFileName(throughOrdinal);
			const serializedSnapshot = serializeCompactBounded(
				{ ...content, digest } satisfies ProjectionSnapshot,
				MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
				"Orchestration projection snapshot",
			);
			const serializedBaseline = serializeBounded(
				{ version: 1, throughOrdinal, digest, snapshotFile } satisfies SnapshotBaseline,
				MAX_BASELINE_BYTES,
				"Orchestration snapshot baseline",
			);
			const serializedCursor = serializeBounded(
				{ version: 1, lastOrdinal: throughOrdinal, tailBytes: 0 } satisfies EventCursor,
				MAX_CURSOR_BYTES,
				"Orchestration cursor",
			);
			writeFileAtomicSync(join(this.snapshotsDir, snapshotFile), serializedSnapshot);
			writeFileAtomicSync(this.baselinePath, serializedBaseline);

			for (const name of this.idempotencyFileNamesUnlocked()) {
				this.unlinkManagedFile(join(this.idempotencyDir, name));
			}
			for (const name of this.eventFileNamesUnlocked()) {
				const ordinal = Number(EVENT_FILE_PATTERN.exec(name)?.[1] ?? 0);
				if (ordinal <= throughOrdinal) this.unlinkManagedFile(join(this.eventsDir, name));
			}
			for (const name of this.snapshotFileNamesUnlocked()) {
				if (name !== snapshotFile) this.unlinkManagedFile(join(this.snapshotsDir, name));
			}
			writeFileAtomicSync(this.cursorPath, serializedCursor);
			this.verifiedSnapshotBaseline = undefined;
			this.synchronizedIndexes = {
				baselineOrdinal: throughOrdinal,
				baselineDigest: digest,
				lastOrdinal: throughOrdinal,
				tailBytes: 0,
				idempotencyEvents: new Map(
					idempotencyEvents.map((event) => [event.idempotencyKey!, structuredClone(event)]),
				),
			};
			return true;
		});
	}

	subscribe(listener: (event: OrchestrationEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private readAllUnlocked(): OrchestrationEvent[] {
		const names = this.eventFileNamesUnlocked();
		const events: OrchestrationEvent[] = [];
		const baselineOrdinal = this.readProjectionSnapshotUnlocked()?.throughOrdinal ?? 0;
		this.assertReadableTailUnlocked(names, baselineOrdinal);
		let previousOrdinal = baselineOrdinal;
		for (const name of names) {
			const match = EVENT_FILE_PATTERN.exec(name);
			if (!match) continue;
			const fileOrdinal = Number(match[1]);
			if (fileOrdinal <= baselineOrdinal) continue;
			const parsed = this.readEventFileUnlocked(name);
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
			return readBoundedDirectoryNamesSync(
				this.eventsDir,
				MAX_EVENT_DIRECTORY_ENTRIES,
				"Orchestration events directory",
			)
				.filter((candidate) => EVENT_FILE_PATTERN.test(candidate))
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	private idempotencyFileNamesUnlocked(): string[] {
		try {
			return readBoundedDirectoryNamesSync(
				this.idempotencyDir,
				MAX_IDEMPOTENCY_DIRECTORY_ENTRIES,
				"Orchestration idempotency directory",
			).filter((candidate) => candidate.endsWith(".json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	private snapshotFileNamesUnlocked(): string[] {
		try {
			return readBoundedDirectoryNamesSync(
				this.snapshotsDir,
				MAX_SNAPSHOT_DIRECTORY_ENTRIES,
				"Orchestration snapshots directory",
			)
				.filter((candidate) => SNAPSHOT_FILE_PATTERN.test(candidate))
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	/** Event files are a contiguous append-only tail after the published snapshot. */
	private assertContiguousTailOrdinalsUnlocked(names: readonly string[], baselineOrdinal: number): void {
		let expectedOrdinal = baselineOrdinal + 1;
		for (const name of names) {
			const ordinal = Number(EVENT_FILE_PATTERN.exec(name)?.[1] ?? 0);
			// A crash after publishing the baseline but before pruning is safe: the snapshot covers these files.
			if (ordinal <= baselineOrdinal) continue;
			if (ordinal !== expectedOrdinal) {
				throw new OrchestrationEventStoreError(
					`Missing orchestration event ordinal ${expectedOrdinal} before ${name}.`,
				);
			}
			expectedOrdinal++;
		}
	}

	/** A valid cursor may lag a newly published snapshot, but it must never lead its committed tail. */
	private assertReadableTailUnlocked(names: readonly string[], baselineOrdinal: number): void {
		this.assertContiguousTailOrdinalsUnlocked(names, baselineOrdinal);
		const highestEventOrdinal = names.length > 0 ? Number(EVENT_FILE_PATTERN.exec(names.at(-1)!)?.[1] ?? 0) : 0;
		const highestCommittedOrdinal = Math.max(baselineOrdinal, highestEventOrdinal);
		const cursor = parseCursor(this.cursorPath);
		if (cursor && cursor.lastOrdinal > highestCommittedOrdinal) {
			throw new OrchestrationEventStoreError(
				`Orchestration cursor ${cursor.lastOrdinal} is ahead of the last committed event ${highestCommittedOrdinal}.`,
			);
		}
	}

	private readBaselineUnlocked(): SnapshotBaseline | undefined {
		if (!existsSync(this.baselinePath)) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				readBoundedTextFileSync(this.baselinePath, MAX_BASELINE_BYTES, "Orchestration snapshot baseline"),
			);
		} catch (error) {
			throw new OrchestrationEventStoreError(
				`Failed to parse orchestration snapshot baseline: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new OrchestrationEventStoreError("Invalid orchestration snapshot baseline.");
		}
		const baseline = parsed as Record<string, unknown>;
		if (
			!hasExactFields(baseline, BASELINE_FIELDS) ||
			baseline.version !== 1 ||
			!Number.isSafeInteger(baseline.throughOrdinal) ||
			Number(baseline.throughOrdinal) < 1 ||
			typeof baseline.digest !== "string" ||
			baseline.digest.length === 0 ||
			typeof baseline.snapshotFile !== "string" ||
			!SNAPSHOT_FILE_PATTERN.test(baseline.snapshotFile) ||
			Number(SNAPSHOT_FILE_PATTERN.exec(baseline.snapshotFile)?.[1] ?? 0) !== Number(baseline.throughOrdinal)
		) {
			throw new OrchestrationEventStoreError("Invalid orchestration snapshot baseline.");
		}
		return {
			version: 1,
			throughOrdinal: Number(baseline.throughOrdinal),
			digest: baseline.digest,
			snapshotFile: baseline.snapshotFile,
		};
	}

	private readProjectionSnapshotUnlocked(): ProjectionSnapshot | undefined {
		const baseline = this.readBaselineUnlocked();
		if (!baseline) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				readBoundedTextFileSync(
					join(this.snapshotsDir, baseline.snapshotFile),
					MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
					"Orchestration projection snapshot",
				),
			);
		} catch (error) {
			throw new OrchestrationEventStoreError(
				`Failed to parse orchestration projection snapshot: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new OrchestrationEventStoreError("Invalid orchestration projection snapshot.");
		}
		const snapshot = parsed as Record<string, unknown>;
		if (
			!hasExactFields(snapshot, SNAPSHOT_FIELDS) ||
			snapshot.version !== 1 ||
			snapshot.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION ||
			snapshot.throughOrdinal !== baseline.throughOrdinal ||
			typeof snapshot.createdAt !== "string" ||
			!snapshot.projection ||
			typeof snapshot.projection !== "object" ||
			Array.isArray(snapshot.projection) ||
			!Array.isArray(snapshot.idempotencyEvents) ||
			snapshot.idempotencyEvents.length > this.maxIdempotencyEvents ||
			Buffer.byteLength(JSON.stringify(snapshot.idempotencyEvents), "utf8") >
				MAX_ORCHESTRATION_SNAPSHOT_IDEMPOTENCY_BYTES ||
			!isCanonicalIsoTimestamp(snapshot.createdAt) ||
			!snapshot.idempotencyEvents.every(isCanonicalOrchestrationEvent) ||
			!snapshot.idempotencyEvents.every(
				(event) => event.ordinal <= baseline.throughOrdinal && event.idempotencyKey !== undefined,
			) ||
			new Set(snapshot.idempotencyEvents.map((event) => event.idempotencyKey)).size !==
				snapshot.idempotencyEvents.length ||
			typeof snapshot.digest !== "string" ||
			snapshot.digest !== baseline.digest
		) {
			throw new OrchestrationEventStoreError("Invalid orchestration projection snapshot.");
		}
		const projection = canonicalJsonObject(snapshot.projection, "Orchestration projection snapshot state");
		const content: ProjectionSnapshotContent = {
			version: 1,
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			throughOrdinal: baseline.throughOrdinal,
			createdAt: snapshot.createdAt,
			projection,
			idempotencyEvents: snapshot.idempotencyEvents.map((event) => structuredClone(event)),
		};
		if (snapshotDigest(content) !== baseline.digest) {
			throw new OrchestrationEventStoreError("Orchestration projection snapshot digest mismatch.");
		}
		return { ...content, digest: baseline.digest };
	}

	/**
	 * Appends need a verified snapshot baseline but must not deserialize its projection on every event.
	 * The baseline pointer remains small and is reread each time; an immutable snapshot is reparsed only
	 * when its pointer or filesystem identity changes.
	 */
	private readVerifiedSnapshotBaselineUnlocked(): VerifiedSnapshotBaseline | undefined {
		const baseline = this.readBaselineUnlocked();
		if (!baseline) {
			this.verifiedSnapshotBaseline = undefined;
			return undefined;
		}
		const signature = this.snapshotFileSignatureUnlocked(baseline);
		const cached = this.verifiedSnapshotBaseline;
		if (
			cached &&
			cached.baseline.throughOrdinal === baseline.throughOrdinal &&
			cached.baseline.digest === baseline.digest &&
			cached.baseline.snapshotFile === baseline.snapshotFile &&
			cached.signature.size === signature.size &&
			cached.signature.mtimeMs === signature.mtimeMs &&
			cached.signature.ctimeMs === signature.ctimeMs
		) {
			return cached;
		}
		const snapshot = this.readProjectionSnapshotUnlocked();
		if (!snapshot) {
			throw new OrchestrationEventStoreError("Orchestration projection snapshot is unavailable.");
		}
		const verifiedSignature = this.snapshotFileSignatureUnlocked(baseline);
		if (
			verifiedSignature.size !== signature.size ||
			verifiedSignature.mtimeMs !== signature.mtimeMs ||
			verifiedSignature.ctimeMs !== signature.ctimeMs
		) {
			throw new OrchestrationEventStoreError("Orchestration projection snapshot changed while being verified.");
		}
		this.verifiedSnapshotBaseline = {
			baseline,
			signature,
			idempotencyEvents: snapshot.idempotencyEvents.map((event) => structuredClone(event)),
		};
		return this.verifiedSnapshotBaseline;
	}

	private snapshotFileSignatureUnlocked(baseline: SnapshotBaseline): SnapshotFileSignature {
		try {
			const stats = statSync(join(this.snapshotsDir, baseline.snapshotFile));
			if (!stats.isFile())
				throw new OrchestrationEventStoreError("Orchestration projection snapshot is not a file.");
			return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
		} catch (error) {
			if (error instanceof OrchestrationEventStoreError) throw error;
			throw new OrchestrationEventStoreError(
				`Failed to parse orchestration projection snapshot: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private unlinkManagedFile(filePath: string): void {
		try {
			unlinkSync(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private readEventFileUnlocked(name: string): OrchestrationEvent {
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				readBoundedTextFileSync(join(this.eventsDir, name), this.maxTailBytes, `Orchestration event ${name}`),
			);
		} catch (error) {
			throw new OrchestrationEventStoreError(
				`Failed to parse orchestration event ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isCanonicalOrchestrationEvent(parsed)) {
			throw new OrchestrationEventStoreError(`Invalid orchestration event record: ${name}`);
		}
		return parsed;
	}

	/**
	 * Reconcile the bounded immutable tail into an in-memory index. Independent writers are detected
	 * from new ordinals while holding the shared lock, so normal same-process appends parse only events
	 * committed by other writers. A bounded mutable cursor remains derived corruption evidence; legacy
	 * per-key marker files are no longer needed or rewritten.
	 */
	private synchronizeIndexesUnlocked(): SynchronizedIndexes {
		const names = this.eventFileNamesUnlocked();
		const verifiedBaseline = this.readVerifiedSnapshotBaselineUnlocked();
		const baselineOrdinal = verifiedBaseline?.baseline.throughOrdinal ?? 0;
		const baselineDigest = verifiedBaseline?.baseline.digest;
		this.assertReadableTailUnlocked(names, baselineOrdinal);
		const highestEventOrdinal = names.length > 0 ? Number(EVENT_FILE_PATTERN.exec(names.at(-1)!)?.[1] ?? 0) : 0;
		const highest = Math.max(baselineOrdinal, highestEventOrdinal);
		if (
			this.synchronizedIndexes?.baselineOrdinal === baselineOrdinal &&
			this.synchronizedIndexes.baselineDigest === baselineDigest &&
			this.synchronizedIndexes.lastOrdinal > highest
		) {
			throw new OrchestrationEventStoreError(
				`Orchestration cursor ${this.synchronizedIndexes.lastOrdinal} is ahead of the last committed event ${highest}.`,
			);
		}
		const cached = this.synchronizedIndexes;
		const canExtendCached =
			cached?.baselineOrdinal === baselineOrdinal &&
			cached.baselineDigest === baselineDigest &&
			cached.lastOrdinal >= baselineOrdinal &&
			cached.lastOrdinal <= highest;
		if (canExtendCached && cached.lastOrdinal === highest) return cached;

		const indexes: SynchronizedIndexes = canExtendCached
			? cached
			: {
					baselineOrdinal,
					baselineDigest,
					lastOrdinal: baselineOrdinal,
					tailBytes: 0,
					idempotencyEvents: new Map(
						(verifiedBaseline?.idempotencyEvents ?? []).map((event) => [
							event.idempotencyKey!,
							structuredClone(event),
						]),
					),
				};
		const scanFrom = indexes.lastOrdinal + 1;
		for (const name of names) {
			const ordinal = Number(EVENT_FILE_PATTERN.exec(name)?.[1] ?? 0);
			if (ordinal < scanFrom || ordinal <= baselineOrdinal) continue;
			const event = this.readEventFileUnlocked(name);
			if (event.ordinal !== ordinal) {
				throw new OrchestrationEventStoreError(`Event ordinal does not match file name: ${name}`);
			}
			if (event.idempotencyKey) indexes.idempotencyEvents.set(event.idempotencyKey, event);
			indexes.tailBytes += statSync(join(this.eventsDir, name)).size;
			indexes.lastOrdinal = ordinal;
		}
		indexes.lastOrdinal = highest;
		this.synchronizedIndexes = indexes;
		return indexes;
	}
}

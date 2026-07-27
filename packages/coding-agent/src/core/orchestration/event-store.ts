import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { orchestrationEventStoreDir } from "../agent-paths.ts";
import type { JsonObject } from "../autonomy/contracts.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import {
	type AppendOrchestrationEventInput,
	isOrchestrationEvent,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
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
const MAX_IDEMPOTENCY_MARKER_BYTES = 64 * 1024;
/** Full current task state plus retained idempotency evidence; intentionally above the 16MiB tail cap. */
const MAX_PROJECTION_SNAPSHOT_BYTES = 32 * 1024 * 1024;

interface EventCursor {
	version: 1;
	lastOrdinal: number;
	tailBytes?: number;
}

interface SynchronizedIndexes {
	lastOrdinal: number;
	tailBytes: number;
}

interface IdempotencyMarker {
	version: 1;
	key: string;
	ordinal: number;
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
 * Append-only event tail with a replaceable full-state projection snapshot. Atomic rename prevents
 * torn records. Snapshot publication is two-phase (payload, then small baseline pointer), after which
 * covered event/idempotency files are pruned. A crash at any point leaves either the old replay prefix
 * or the new verified snapshot authoritative; ordinals never reset.
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

	append(input: AppendOrchestrationEventInput, options: { expectedLastOrdinal?: number } = {}): OrchestrationEvent {
		const committed = withFileLockSync(this.cursorPath, (): { event: OrchestrationEvent; appended: boolean } => {
			const cursor = this.synchronizeIndexesUnlocked();
			const actual = cursor.lastOrdinal;
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
			const serializedEvent = serializeBounded(
				next,
				this.maxTailBytes,
				"Orchestration event",
				"Orchestration event exceeds its configured tail byte limit.",
			);
			const serializedMarker = input.idempotencyKey
				? this.serializeIdempotencyMarker(input.idempotencyKey, ordinal)
				: undefined;
			const serializedCursor = serializeBounded(
				{
					version: 1,
					lastOrdinal: ordinal,
					tailBytes: cursor.tailBytes + Buffer.byteLength(serializedEvent),
				} satisfies EventCursor,
				MAX_CURSOR_BYTES,
				"Orchestration cursor",
			);
			writeFileAtomicSync(join(this.eventsDir, eventFileName(ordinal)), serializedEvent);
			if (input.idempotencyKey && serializedMarker) {
				this.writeIdempotencyMarkerUnlocked(input.idempotencyKey, serializedMarker);
			}
			writeFileAtomicSync(this.cursorPath, serializedCursor);
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
		const baselineBeforeLock = this.readBaselineUnlocked()?.throughOrdinal ?? 0;
		const cursorBeforeLock = parseCursor(this.cursorPath);
		if (
			cursorBeforeLock?.lastOrdinal === throughOrdinal &&
			cursorBeforeLock.tailBytes !== undefined &&
			throughOrdinal - baselineBeforeLock < this.maxTailEvents &&
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
			const idempotencyEvents = [...retainedByKey.values()]
				.sort((left, right) => left.ordinal - right.ordinal)
				.slice(-this.maxIdempotencyEvents)
				.map((event) => structuredClone(event));
			const content: ProjectionSnapshotContent = {
				version: 1,
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				throughOrdinal,
				createdAt: this.now(),
				projection: structuredClone(projection()),
				idempotencyEvents,
			};
			const digest = snapshotDigest(content);
			const snapshotFile = eventFileName(throughOrdinal);
			const serializedSnapshot = serializeBounded(
				{ ...content, digest } satisfies ProjectionSnapshot,
				MAX_PROJECTION_SNAPSHOT_BYTES,
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
					MAX_PROJECTION_SNAPSHOT_BYTES,
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
			snapshot.version !== 1 ||
			snapshot.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION ||
			snapshot.throughOrdinal !== baseline.throughOrdinal ||
			typeof snapshot.createdAt !== "string" ||
			!snapshot.projection ||
			typeof snapshot.projection !== "object" ||
			Array.isArray(snapshot.projection) ||
			!Array.isArray(snapshot.idempotencyEvents) ||
			snapshot.idempotencyEvents.length > this.maxIdempotencyEvents ||
			!snapshot.idempotencyEvents.every(isOrchestrationEvent) ||
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
		const content: ProjectionSnapshotContent = {
			version: 1,
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			throughOrdinal: baseline.throughOrdinal,
			createdAt: snapshot.createdAt,
			projection: structuredClone(snapshot.projection) as JsonObject,
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
	private readVerifiedSnapshotBaselineUnlocked(): SnapshotBaseline | undefined {
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
			return baseline;
		}
		this.readProjectionSnapshotUnlocked();
		const verifiedSignature = this.snapshotFileSignatureUnlocked(baseline);
		if (
			verifiedSignature.size !== signature.size ||
			verifiedSignature.mtimeMs !== signature.mtimeMs ||
			verifiedSignature.ctimeMs !== signature.ctimeMs
		) {
			throw new OrchestrationEventStoreError("Orchestration projection snapshot changed while being verified.");
		}
		this.verifiedSnapshotBaseline = { baseline, signature };
		return baseline;
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
		if (!isOrchestrationEvent(parsed)) {
			throw new OrchestrationEventStoreError(`Invalid orchestration event record: ${name}`);
		}
		return parsed;
	}

	private idempotencyPath(key: string): string {
		return join(this.idempotencyDir, `${createHash("sha256").update(key).digest("hex")}.json`);
	}

	private serializeIdempotencyMarker(key: string, ordinal: number): string {
		return serializeBounded(
			{ version: 1, key, ordinal } satisfies IdempotencyMarker,
			MAX_IDEMPOTENCY_MARKER_BYTES,
			"Orchestration idempotency marker",
		);
	}

	private writeIdempotencyMarkerUnlocked(key: string, serializedMarker: string): void {
		writeFileAtomicSync(this.idempotencyPath(key), serializedMarker);
	}

	private readIdempotentEventUnlocked(key: string): OrchestrationEvent | undefined {
		const markerPath = this.idempotencyPath(key);
		if (!existsSync(markerPath)) {
			return this.readProjectionSnapshotUnlocked()?.idempotencyEvents.find((event) => event.idempotencyKey === key);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				readBoundedTextFileSync(markerPath, MAX_IDEMPOTENCY_MARKER_BYTES, "Orchestration idempotency marker"),
			);
		} catch (error) {
			throw new OrchestrationEventStoreError(
				`Failed to parse orchestration idempotency marker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new OrchestrationEventStoreError("Invalid orchestration idempotency marker.");
		}
		const marker = parsed as Record<string, unknown>;
		if (
			marker.version !== 1 ||
			marker.key !== key ||
			!Number.isSafeInteger(marker.ordinal) ||
			Number(marker.ordinal) < 1
		) {
			throw new OrchestrationEventStoreError("Invalid orchestration idempotency marker.");
		}
		const ordinal = Number(marker.ordinal);
		if (!existsSync(join(this.eventsDir, eventFileName(ordinal)))) {
			const retained = this.readProjectionSnapshotUnlocked()?.idempotencyEvents.find(
				(event) => event.idempotencyKey === key && event.ordinal === ordinal,
			);
			if (retained) return retained;
		}
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
	private synchronizeIndexesUnlocked(): SynchronizedIndexes {
		const names = this.eventFileNamesUnlocked();
		const baselineOrdinal = this.readVerifiedSnapshotBaselineUnlocked()?.throughOrdinal ?? 0;
		this.assertReadableTailUnlocked(names, baselineOrdinal);
		const highestEventOrdinal = names.length > 0 ? Number(EVENT_FILE_PATTERN.exec(names.at(-1)!)?.[1] ?? 0) : 0;
		const highest = Math.max(baselineOrdinal, highestEventOrdinal);
		const cursor = parseCursor(this.cursorPath);
		if (
			cursor?.lastOrdinal === highest &&
			cursor.tailBytes !== undefined &&
			(highest > baselineOrdinal || cursor.tailBytes === 0)
		) {
			return { lastOrdinal: highest, tailBytes: cursor.tailBytes };
		}
		if (cursor && cursor.lastOrdinal > highest) {
			throw new OrchestrationEventStoreError(
				`Orchestration cursor ${cursor.lastOrdinal} is ahead of the last committed event ${highest}.`,
			);
		}
		const rebuildFrom = Math.max(
			baselineOrdinal + 1,
			cursor && cursor.lastOrdinal >= baselineOrdinal && cursor.lastOrdinal <= highest
				? cursor.lastOrdinal + 1
				: baselineOrdinal + 1,
		);
		for (const name of names) {
			const ordinal = Number(EVENT_FILE_PATTERN.exec(name)?.[1] ?? 0);
			if (ordinal < rebuildFrom || ordinal <= baselineOrdinal) continue;
			const event = this.readEventFileUnlocked(name);
			if (event.ordinal !== ordinal) {
				throw new OrchestrationEventStoreError(`Event ordinal does not match file name: ${name}`);
			}
			if (event.idempotencyKey) {
				this.writeIdempotencyMarkerUnlocked(
					event.idempotencyKey,
					this.serializeIdempotencyMarker(event.idempotencyKey, ordinal),
				);
			}
		}
		const tailBytes = names.reduce((total, name) => {
			const ordinal = Number(EVENT_FILE_PATTERN.exec(name)?.[1] ?? 0);
			if (ordinal <= baselineOrdinal) return total;
			try {
				return total + statSync(join(this.eventsDir, name)).size;
			} catch {
				return total;
			}
		}, 0);
		writeFileAtomicSync(
			this.cursorPath,
			serializeBounded(
				{ version: 1, lastOrdinal: highest, tailBytes } satisfies EventCursor,
				MAX_CURSOR_BYTES,
				"Orchestration cursor",
			),
		);
		return { lastOrdinal: highest, tailBytes };
	}
}

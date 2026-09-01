import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../src/core/autonomy/contracts.ts";
import {
	type AppendOrchestrationEventInput,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationEvent,
} from "../src/core/orchestration/contracts.ts";
import {
	OrchestrationConcurrencyError,
	OrchestrationEventStore,
	OrchestrationEventStoreError,
	OrchestrationSnapshotRequiredError,
} from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { readBoundedDirectoryNamesSync } from "../src/core/util/bounded-file.ts";
import { runSignaledWorkerThreads } from "./worker-thread-fixture.ts";

// Pass-through spy: behavior is unchanged, only the number of tail listings becomes observable.
vi.mock("../src/core/util/bounded-file.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/util/bounded-file.ts")>();
	return { ...actual, readBoundedDirectoryNamesSync: vi.fn(actual.readBoundedDirectoryNamesSync) };
});

const tempDirs: string[] = [];

function makeStore(
	sessionId = "session-1",
	retention: { maxTailEvents?: number; maxTailBytes?: number; maxIdempotencyEvents?: number } = {},
): OrchestrationEventStore {
	const agentDir = join(tmpdir(), `pi-orchestration-events-${process.pid}-${tempDirs.length}-${Date.now()}`);
	mkdirSync(agentDir, { recursive: true });
	tempDirs.push(agentDir);
	let tick = 0;
	return new OrchestrationEventStore({
		agentDir,
		sessionId,
		now: () => `2026-07-23T00:00:0${tick++}.000Z`,
		createEventId: () => `event-${tick}`,
		...retention,
	});
}

function makeAgentDir(): string {
	const agentDir = join(tmpdir(), `pi-orchestration-events-${process.pid}-${tempDirs.length}-${Date.now()}`);
	mkdirSync(agentDir, { recursive: true });
	tempDirs.push(agentDir);
	return agentDir;
}

function writeConcurrentAppendWorker(agentDir: string): string {
	const workerPath = join(agentDir, "orchestration-append-worker.mjs");
	const eventStoreModule = new URL("../src/core/orchestration/event-store.ts", import.meta.url).href;
	writeFileSync(
		workerPath,
		`import { parentPort, workerData } from "node:worker_threads";
import { OrchestrationEventStore } from ${JSON.stringify(eventStoreModule)};
const { agentDir, sessionId, writerId, iterations, sharedIdempotencyKey } = workerData;
let eventSequence = 0;
const store = new OrchestrationEventStore({
	agentDir,
	sessionId,
	createEventId: () => \`event-\${writerId}-\${eventSequence++}\`,
});
for (let index = 0; index < iterations; index++) {
	store.append({
		type: "objective.created",
		aggregateId: sharedIdempotencyKey ? "objective-shared" : \`objective-\${writerId}-\${index}\`,
		actor: "kernel",
		idempotencyKey: sharedIdempotencyKey ?? \`writer-\${writerId}-event-\${index}\`,
		payload: sharedIdempotencyKey ? { shared: true } : { writerId, index },
	});
}
parentPort.postMessage({ done: true });
`,
		"utf-8",
	);
	return workerPath;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("OrchestrationEventStore", () => {
	it("persists ordered immutable events and reads them from a fresh instance", () => {
		const store = makeStore();
		const first = store.append({
			type: "objective.created",
			aggregateId: "objective-1",
			actor: "kernel",
			payload: { title: "Overhaul harness" },
		});
		store.append({
			type: "task.created",
			aggregateId: "objective-1",
			actor: "runtime",
			causationId: first.eventId,
			payload: { taskId: "task-1" },
		});

		const reopened = new OrchestrationEventStore({
			agentDir: store.rootDir.split(`${join("state", "orchestration")}`)[0]!,
			sessionId: "session-1",
		});
		const events = reopened.readAll();
		expect(events.map((event) => event.ordinal)).toEqual([1, 2]);
		expect(events[1]).toMatchObject({ causationId: first.eventId, payload: { taskId: "task-1" } });

		events[0]!.payload.title = "mutated";
		expect(reopened.readAll()[0]?.payload.title).toBe("Overhaul harness");
	});

	it("deduplicates an idempotency key without emitting a second notification", () => {
		const store = makeStore();
		const notifications: OrchestrationEvent[] = [];
		store.subscribe((event) => notifications.push(event));
		const input = {
			type: "attempt.queued" as const,
			aggregateId: "task-1",
			actor: "runtime" as const,
			idempotencyKey: "queue-task-1-attempt-1",
			payload: { attemptId: "attempt-1" },
		};

		const first = store.append(input);
		const second = store.append(input);

		expect(second).toEqual(first);
		expect(store.readAll()).toHaveLength(1);
		expect(notifications).toHaveLength(1);
	});

	it("rejects conflicting idempotency-key reuse across stores while exact replay stays inert", () => {
		const agentDir = makeAgentDir();
		const firstStore = new OrchestrationEventStore({ agentDir, sessionId: "idempotency-content" });
		const secondStore = new OrchestrationEventStore({ agentDir, sessionId: "idempotency-content" });
		const firstInput = {
			type: "task.created" as const,
			aggregateId: "objective-1",
			actor: "runtime" as const,
			idempotencyKey: "task-created:task-1",
			correlationId: "dispatch-1",
			payload: { task: { taskId: "task-1", description: "writer-a" } },
		};
		const first = firstStore.append(firstInput);

		expect(() =>
			secondStore.append(
				{
					...firstInput,
					payload: { task: { taskId: "task-1", description: "writer-b" } },
				},
				{ expectedLastOrdinal: 0 },
			),
		).toThrow(/idempotency key.*conflicting event content/i);
		expect(secondStore.append(firstInput, { expectedLastOrdinal: 0 })).toEqual(first);
		expect(secondStore.readAll()).toEqual([first]);
	});

	it("does not amplify one durable append into per-key derived-index files", () => {
		const store = makeStore("single-write");
		const input = {
			type: "attempt.queued" as const,
			aggregateId: "task-1",
			actor: "runtime" as const,
			idempotencyKey: "queue-task-1-attempt-1",
			payload: { attemptId: "attempt-1" },
		};

		const first = store.append(input);

		expect(readdirSync(store.eventsDir)).toEqual(["0000000000000001.json"]);
		expect(existsSync(store.cursorPath)).toBe(true);
		expect(existsSync(store.idempotencyDir)).toBe(false);
		const reopened = new OrchestrationEventStore({
			agentDir: store.rootDir.split(`${join("state", "orchestration")}`)[0]!,
			sessionId: "single-write",
		});
		expect(reopened.append(input)).toEqual(first);
		expect(reopened.readAll()).toEqual([first]);
	});

	it("preserves every unique append from simultaneous independent writers", async () => {
		const agentDir = makeAgentDir();
		const sessionId = "shared-concurrent-session";
		const workerPath = writeConcurrentAppendWorker(agentDir);
		const iterationsPerWriter = 40;
		const writerIds = ["first", "second"];

		await runSignaledWorkerThreads(
			workerPath,
			writerIds.map((writerId) => ({ agentDir, sessionId, writerId, iterations: iterationsPerWriter })),
		);

		const reopened = new OrchestrationEventStore({ agentDir, sessionId });
		const events = reopened.readAll();
		expect(events).toHaveLength(iterationsPerWriter * writerIds.length);
		expect(events.map((event) => event.ordinal)).toEqual(
			Array.from({ length: events.length }, (_entry, index) => index + 1),
		);
		expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(events.length);
		expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
	}, 20_000);

	it("commits one event when independent writers race the same idempotency key", async () => {
		const agentDir = makeAgentDir();
		const sessionId = "shared-idempotency-session";
		const workerPath = writeConcurrentAppendWorker(agentDir);
		const sharedIdempotencyKey = "shared-operation";

		await runSignaledWorkerThreads(
			workerPath,
			["first", "second"].map((writerId) => ({
				agentDir,
				sessionId,
				writerId,
				iterations: 1,
				sharedIdempotencyKey,
			})),
		);

		const events = new OrchestrationEventStore({ agentDir, sessionId }).readAll();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ ordinal: 1, idempotencyKey: sharedIdempotencyKey });
	});

	it("isolates independent session event tails beneath one agent directory", () => {
		const agentDir = makeAgentDir();
		const first = new OrchestrationEventStore({ agentDir, sessionId: "session-a" });
		const second = new OrchestrationEventStore({ agentDir, sessionId: "session-b" });

		first.append({ type: "objective.created", aggregateId: "objective-a", actor: "kernel", payload: {} });
		second.append({ type: "objective.created", aggregateId: "objective-b", actor: "kernel", payload: {} });

		expect(first.rootDir).not.toBe(second.rootDir);
		expect(first.readAll()).toMatchObject([{ ordinal: 1, aggregateId: "objective-a" }]);
		expect(second.readAll()).toMatchObject([{ ordinal: 1, aggregateId: "objective-b" }]);
	});

	it("rejects a stale expected cursor", () => {
		const store = makeStore();
		store.append({ type: "objective.created", aggregateId: "objective-1", actor: "kernel", payload: {} });

		expect(() =>
			store.append(
				{ type: "objective.paused", aggregateId: "objective-1", actor: "human", payload: {} },
				{ expectedLastOrdinal: 0 },
			),
		).toThrow(OrchestrationConcurrencyError);
	});

	it("recovers when an event committed but the cursor was lost", () => {
		const store = makeStore();
		store.append({
			type: "objective.created",
			aggregateId: "objective-1",
			actor: "kernel",
			payload: {},
		});
		rmSync(store.cursorPath, { force: true });

		const second = store.append({
			type: "objective.paused",
			aggregateId: "objective-1",
			actor: "human",
			payload: {},
		});

		expect(second.ordinal).toBe(2);
		expect(store.readAll()).toHaveLength(2);
	});

	it("rejects a missing committed event rather than extending a corrupt tail", () => {
		const store = makeStore();
		store.append({ type: "objective.created", aggregateId: "objective-1", actor: "kernel", payload: {} });
		store.append({ type: "objective.paused", aggregateId: "objective-1", actor: "human", payload: {} });
		store.append({ type: "objective.resumed", aggregateId: "objective-1", actor: "human", payload: {} });
		unlinkSync(join(store.eventsDir, "0000000000000002.json"));

		expect(() => store.readAll()).toThrow("Missing orchestration event ordinal 2");
		expect(() =>
			store.append({ type: "objective.cancelled", aggregateId: "objective-1", actor: "human", payload: {} }),
		).toThrow("Missing orchestration event ordinal 2");
	});

	it("rejects a truncated final event when the valid cursor proves it was committed", () => {
		const store = makeStore();
		store.append({ type: "objective.created", aggregateId: "objective-1", actor: "kernel", payload: {} });
		store.append({ type: "objective.paused", aggregateId: "objective-1", actor: "human", payload: {} });
		unlinkSync(join(store.eventsDir, "0000000000000002.json"));

		expect(() => store.readAll()).toThrow("Orchestration cursor 2 is ahead of the last committed event 1");
		expect(() => store.readAfter(0)).toThrow("Orchestration cursor 2 is ahead of the last committed event 1");
	});

	it("propagates event directory errors instead of treating them as an empty event tail", () => {
		const store = makeStore();
		mkdirSync(store.rootDir, { recursive: true });
		writeFileSync(store.eventsDir, "not a directory\n", "utf-8");

		expect(() => store.readAll()).toThrow(/ENOTDIR|not a directory/i);
	});

	it("deduplicates from a committed event when derived indexes are absent", () => {
		const store = makeStore();
		const input = {
			type: "attempt.queued" as const,
			aggregateId: "task-1",
			actor: "runtime" as const,
			idempotencyKey: "queue-after-cursor-loss",
			payload: { attemptId: "attempt-1" },
		};
		const first = store.append(input);
		rmSync(store.cursorPath, { force: true });

		const replayed = store.append(input);

		expect(replayed).toEqual(first);
		expect(store.readAll()).toHaveLength(1);
	});

	it("compacts a bounded event tail into a verified projection without resetting ordinals", () => {
		const store = makeStore("bounded", { maxTailEvents: 2, maxTailBytes: 1_000_000 });
		const firstInput = {
			type: "objective.created" as const,
			aggregateId: "objective-1",
			actor: "kernel" as const,
			idempotencyKey: "objective-created:objective-1",
			payload: { objectiveId: "objective-1" },
		};
		const first = store.append(firstInput);
		store.append({
			type: "objective.paused",
			aggregateId: "objective-1",
			actor: "human",
			idempotencyKey: "objective-paused:objective-1",
			payload: {},
		});
		const projection = { lastOrdinal: 2, state: "paused" };

		expect(store.compactIfNeeded(2, () => projection)).toBe(true);
		expect(store.readProjectionSnapshot()).toEqual({ throughOrdinal: 2, projection });
		expect(readdirSync(store.snapshotsDir)).toEqual(["0000000000000002.json"]);
		expect(readdirSync(store.eventsDir)).toEqual([]);
		expect(() => store.readAfter(0)).toThrow(OrchestrationSnapshotRequiredError);
		expect(store.append(firstInput)).toEqual(first);

		const next = store.append({
			type: "objective.resumed",
			aggregateId: "objective-1",
			actor: "human",
			payload: {},
		});
		expect(next.ordinal).toBe(3);
		expect(store.readAfter(2)).toEqual([next]);
	});

	it("rejects non-JSON projection snapshots before publication or tail pruning", () => {
		const invalidProjections = [
			{ label: "non-finite number", projection: { lastOrdinal: 1, value: Number.NaN } as JsonObject },
			{
				label: "unsupported bigint",
				projection: { lastOrdinal: 1, value: 1n } as unknown as JsonObject,
			},
		];

		for (const candidate of invalidProjections) {
			const store = makeStore(`invalid-projection-${candidate.label}`, { maxTailEvents: 1 });
			const event = store.append({
				type: "objective.created",
				aggregateId: "objective-1",
				actor: "kernel",
				payload: {},
			});
			const cursorBefore = readFileSync(store.cursorPath, "utf8");

			expect(() => store.compactIfNeeded(1, () => candidate.projection), candidate.label).toThrow(
				OrchestrationEventStoreError,
			);
			expect(existsSync(store.baselinePath), candidate.label).toBe(false);
			expect(existsSync(store.snapshotsDir) ? readdirSync(store.snapshotsDir) : [], candidate.label).toEqual([]);
			expect(readdirSync(store.eventsDir), candidate.label).toEqual(["0000000000000001.json"]);
			expect(readFileSync(store.cursorPath, "utf8"), candidate.label).toBe(cursorBefore);
			expect(store.readAll(), candidate.label).toEqual([event]);

			const validProjection = { lastOrdinal: 1, state: "valid" };
			expect(
				store.compactIfNeeded(1, () => validProjection),
				candidate.label,
			).toBe(true);
			expect(store.readProjectionSnapshot(), candidate.label).toEqual({
				throughOrdinal: 1,
				projection: validProjection,
			});
		}
	});

	it("rejects a non-finite number injected into a published projection snapshot", () => {
		const store = makeStore("non-finite-published-projection", { maxTailEvents: 1 });
		store.append({
			type: "objective.created",
			aggregateId: "objective-1",
			actor: "kernel",
			payload: {},
		});
		expect(store.compactIfNeeded(1, () => ({ lastOrdinal: 1, value: null }))).toBe(true);
		const snapshotPath = join(store.snapshotsDir, "0000000000000001.json");
		const canonical = readFileSync(snapshotPath, "utf8");
		const forged = canonical.replace('"value":null', '"value":1e400');
		expect(forged).not.toBe(canonical);
		writeFileSync(snapshotPath, forged, "utf8");

		expect(() => store.readProjectionSnapshot()).toThrow(OrchestrationEventStoreError);
		expect(() =>
			store.append({
				type: "objective.paused",
				aggregateId: "objective-1",
				actor: "human",
				payload: {},
			}),
		).toThrow(OrchestrationEventStoreError);
	});

	it.each(["baseline", "snapshot"] as const)("rejects unsupported fields in a published %s record", (target) => {
		const store = makeStore(`unsupported-published-${target}`, { maxTailEvents: 1 });
		store.append({
			type: "objective.created",
			aggregateId: "objective-1",
			actor: "kernel",
			payload: {},
		});
		expect(store.compactIfNeeded(1, () => ({ lastOrdinal: 1 }))).toBe(true);
		const targetPath = target === "baseline" ? store.baselinePath : join(store.snapshotsDir, "0000000000000001.json");
		const parsed = JSON.parse(readFileSync(targetPath, "utf8")) as Record<string, unknown>;
		parsed.unsupported = "must not be ignored";
		writeFileSync(targetPath, `${JSON.stringify(parsed)}\n`, "utf8");

		expect(() => store.readProjectionSnapshot()).toThrow(OrchestrationEventStoreError);
	});

	it("keeps the published snapshot authoritative when an unpublished newer snapshot file is left behind", () => {
		const store = makeStore("snapshot-publication", { maxTailEvents: 1 });
		store.append({
			type: "objective.created",
			aggregateId: "objective-1",
			actor: "kernel",
			payload: {},
		});
		expect(store.compactIfNeeded(1, () => ({ lastOrdinal: 1, state: "created" }))).toBe(true);
		writeFileSync(join(store.snapshotsDir, "0000000000000002.json"), "interrupted publication\n", "utf-8");

		expect(store.readProjectionSnapshot()).toEqual({
			throughOrdinal: 1,
			projection: { lastOrdinal: 1, state: "created" },
		});
	});

	it("refuses to append when the published projection snapshot is missing", () => {
		const store = makeStore("missing-published-snapshot", { maxTailEvents: 1 });
		store.append({
			type: "objective.created",
			aggregateId: "objective-1",
			actor: "kernel",
			payload: {},
		});
		expect(store.compactIfNeeded(1, () => ({ lastOrdinal: 1, state: "created" }))).toBe(true);
		store.append({ type: "objective.paused", aggregateId: "objective-1", actor: "human", payload: {} });
		unlinkSync(join(store.snapshotsDir, "0000000000000001.json"));

		expect(() =>
			store.append({ type: "objective.resumed", aggregateId: "objective-1", actor: "human", payload: {} }),
		).toThrow("Failed to parse orchestration projection snapshot");
		expect(readdirSync(store.eventsDir)).toEqual(["0000000000000002.json"]);
	});

	it("fails loudly on a corrupt committed record", () => {
		const store = makeStore();
		const corruptPath = join(store.eventsDir, "0000000000000001.json");
		mkdirSync(dirname(corruptPath), { recursive: true });
		writeFileSync(corruptPath, "not-json\n", "utf-8");

		expect(() => store.readAll()).toThrow(OrchestrationEventStoreError);
	});

	it("keeps hostile session identifiers beneath the orchestration state root", () => {
		const store = makeStore("../../another/session");
		const orchestrationRoot = dirname(store.rootDir);
		expect(relative(orchestrationRoot, store.rootDir).split(sep)[0]).not.toBe("..");
	});

	it("rejects a structurally invalid event during replay", () => {
		const store = makeStore();
		const invalid = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			ordinal: 1,
			eventId: "event-1",
			type: "unknown.event",
			aggregateId: "objective-1",
			actor: "kernel",
			occurredAt: "2026-07-23T00:00:00.000Z",
			payload: {},
		};
		const filePath = join(store.eventsDir, "0000000000000001.json");
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(invalid), "utf-8");

		expect(() => store.readAll()).toThrow("Invalid orchestration event record");
	});

	it("rejects non-canonical append input and generated metadata before persisting an event", () => {
		const validInput = (): AppendOrchestrationEventInput => ({
			type: "notification.enqueued",
			aggregateId: "objective-1",
			actor: "runtime",
			idempotencyKey: "notification:1",
			payload: { notificationId: "notification-1", objectiveId: "objective-1", message: "done" },
		});
		const candidates: Array<{
			label: string;
			now?: () => string;
			createEventId?: () => string;
			input: AppendOrchestrationEventInput;
		}> = [
			{ label: "empty event time", now: () => "", input: validInput() },
			{ label: "non-ISO event time", now: () => "not-a-date", input: validInput() },
			{ label: "empty event id", createEventId: () => "", input: validInput() },
			{
				label: "oversized event id",
				createEventId: () => "e".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1),
				input: validInput(),
			},
			{
				label: "invalid actor",
				input: { ...validInput(), actor: "intruder" } as unknown as AppendOrchestrationEventInput,
			},
			{
				label: "invalid event type",
				input: { ...validInput(), type: "forged.event" } as unknown as AppendOrchestrationEventInput,
			},
			{
				label: "oversized aggregate id",
				input: { ...validInput(), aggregateId: "a".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1) },
			},
			{
				label: "oversized idempotency key",
				input: { ...validInput(), idempotencyKey: "i".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1) },
			},
			{
				label: "non-finite JSON number",
				input: { ...validInput(), payload: { value: Number.NaN } as AppendOrchestrationEventInput["payload"] },
			},
		];

		for (const candidate of candidates) {
			const agentDir = makeAgentDir();
			const store = new OrchestrationEventStore({
				agentDir,
				sessionId: `invalid-${candidate.label}`,
				now: candidate.now ?? (() => "2026-07-23T00:00:00.000Z"),
				createEventId: candidate.createEventId ?? (() => "event-valid"),
			});

			expect(() => store.append(candidate.input), candidate.label).toThrow(OrchestrationEventStoreError);
			expect(store.readAll(), candidate.label).toEqual([]);
		}
	});

	it("accepts canonical identifiers at the durable length boundary", () => {
		const agentDir = makeAgentDir();
		const boundaryId = "x".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		const store = new OrchestrationEventStore({
			agentDir,
			sessionId: "identifier-boundary",
			now: () => "2026-07-23T00:00:00.000Z",
			createEventId: () => boundaryId,
		});

		const event = store.append({
			type: "objective.created",
			aggregateId: boundaryId,
			actor: "kernel",
			idempotencyKey: boundaryId,
			payload: {},
		});

		expect(event).toMatchObject({ eventId: boundaryId, aggregateId: boundaryId, idempotencyKey: boundaryId });
		expect(store.readAll()).toEqual([event]);
	});

	it("keeps runtime state and the durable tail unchanged when generated event metadata is invalid", () => {
		const agentDir = makeAgentDir();
		const store = new OrchestrationEventStore({
			agentDir,
			sessionId: "runtime-invalid-event-metadata",
			now: () => "not-a-date",
			createEventId: () => "event-runtime",
		});
		const runtime = new DurableTaskRuntime({
			store,
			now: () => Date.parse("2026-07-23T00:00:00.000Z"),
			createId: () => "runtime",
		});

		expect(() =>
			runtime.createObjective({ objectiveId: "objective-runtime", title: "Runtime", description: "Runtime" }),
		).toThrow(OrchestrationEventStoreError);
		expect(runtime.getSnapshot().objectives).toEqual({});
		expect(store.readAll()).toEqual([]);
	});

	it("contains listener failures after commit and continues notifying the remaining listeners", async () => {
		const store = makeStore("listener-isolation");
		const observed: string[] = [];
		store.subscribe(() => {
			throw new Error("synchronous listener failure");
		});
		store.subscribe(async () => {
			throw new Error("asynchronous listener failure");
		});
		store.subscribe((event) => observed.push(event.eventId));

		const event = store.append({
			type: "objective.created",
			aggregateId: "objective-listener",
			actor: "kernel",
			payload: {},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(observed).toEqual([event.eventId]);
		expect(store.readAll()).toEqual([event]);
	});

	it("does not report a durable runtime commit as failed when an event listener throws", () => {
		const store = makeStore("runtime-listener-isolation");
		const runtime = new DurableTaskRuntime({ store, createId: () => "listener" });
		store.subscribe(() => {
			throw new Error("listener failure");
		});

		const objective = runtime.createObjective({
			objectiveId: "objective-listener",
			title: "Listener",
			description: "Listener",
		});

		expect(objective.objectiveId).toBe("objective-listener");
		expect(runtime.getSnapshot().objectives[objective.objectiveId]?.objective).toEqual(objective);
		expect(store.readAll()).toHaveLength(1);
	});

	it("rejects one event that cannot fit the configured bounded tail before writing it", () => {
		const store = makeStore("event-too-large", { maxTailBytes: 256 });

		expect(() =>
			store.append({
				type: "objective.created",
				aggregateId: "objective-1",
				actor: "kernel",
				payload: { unbounded: "x".repeat(1024) },
			}),
		).toThrow("exceeds its configured tail byte limit");
		expect(existsSync(join(store.eventsDir, "0000000000000001.json"))).toBe(false);
		expect(
			new OrchestrationEventStore({
				agentDir: store.rootDir.split(`${join("state", "orchestration")}`)[0]!,
				sessionId: "event-too-large",
				maxTailBytes: 256,
			}).readAll(),
		).toEqual([]);
	});

	it("runs projection admission under the append lock before changing the event tail or cursor", () => {
		const store = makeStore("precommit-admission");
		const first = store.append({
			type: "objective.created",
			aggregateId: "objective-1",
			actor: "kernel",
			payload: {},
		});
		const cursorBefore = readFileSync(store.cursorPath, "utf8");
		const eventsBefore = readdirSync(store.eventsDir);
		const notifications: OrchestrationEvent[] = [];
		store.subscribe((event) => notifications.push(event));

		expect(() =>
			store.append(
				{
					type: "objective.paused",
					aggregateId: "objective-1",
					actor: "human",
					payload: {},
				},
				{
					expectedLastOrdinal: 1,
					validateBeforeCommit: (candidate) => {
						expect(candidate).toMatchObject({ ordinal: 2, type: "objective.paused" });
						throw new Error("injected projection rejection");
					},
				},
			),
		).toThrow("injected projection rejection");
		expect(readFileSync(store.cursorPath, "utf8")).toBe(cursorBefore);
		expect(readdirSync(store.eventsDir)).toEqual(eventsBefore);
		expect(notifications).toEqual([]);

		const reopened = new OrchestrationEventStore({
			agentDir: store.rootDir.split(`${join("state", "orchestration")}`)[0]!,
			sessionId: "precommit-admission",
		});
		expect(reopened.readAll()).toEqual([first]);
		expect(
			reopened.append({
				type: "objective.paused",
				aggregateId: "objective-1",
				actor: "human",
				payload: {},
			}).ordinal,
		).toBe(2);
	});

	it("fails closed when a corrupt event file exceeds the configured bounded tail", () => {
		const store = makeStore("oversized-corrupt-event", { maxTailBytes: 256 });
		const eventPath = join(store.eventsDir, "0000000000000001.json");
		mkdirSync(store.eventsDir, { recursive: true });
		writeFileSync(eventPath, "x".repeat(257), "utf-8");

		expect(() => store.readAll()).toThrow("Orchestration event 0000000000000001.json exceeds its byte limit");
		expect(() =>
			new OrchestrationEventStore({
				agentDir: store.rootDir.split(`${join("state", "orchestration")}`)[0]!,
				sessionId: "oversized-corrupt-event",
				maxTailBytes: 256,
			}).readAll(),
		).toThrow("Orchestration event 0000000000000001.json exceeds its byte limit");
	});

	it("fails closed on a managed event-directory burst without loading an unbounded listing", () => {
		const store = makeStore("directory-burst");
		mkdirSync(store.eventsDir, { recursive: true });
		for (let index = 0; index < 2_049; index++) {
			writeFileSync(join(store.eventsDir, `burst-${String(index).padStart(4, "0")}.tmp`), "x", "utf-8");
		}

		expect(() => store.readAll()).toThrow("Orchestration events directory exceeds its entry limit");
	});

	it("caps caller-configured durable retention bounds", () => {
		const agentDir = makeAgentDir();
		expect(
			() => new OrchestrationEventStore({ agentDir, sessionId: "max-tail-events", maxTailEvents: 1_025 }),
		).toThrow("maxTailEvents must not exceed 1024");
		expect(
			() =>
				new OrchestrationEventStore({ agentDir, sessionId: "max-tail-bytes", maxTailBytes: 16 * 1024 * 1024 + 1 }),
		).toThrow("maxTailBytes must not exceed 16777216");
		expect(
			() => new OrchestrationEventStore({ agentDir, sessionId: "max-idempotency", maxIdempotencyEvents: 1_025 }),
		).toThrow("maxIdempotencyEvents must not exceed 1024");
	});
});

describe("OrchestrationEventStore read polling", () => {
	/** A second instance on the directory the latest makeStore() created, with its own retention. */
	function peer(retention: { maxTailEvents?: number } = {}): OrchestrationEventStore {
		return new OrchestrationEventStore({ agentDir: tempDirs.at(-1)!, sessionId: "session-1", ...retention });
	}

	it("answers a poll with nothing new without listing the tail, and still sees a peer's append", () => {
		const store = makeStore();
		for (const type of ["objective.created", "objective.paused", "objective.resumed"] as const) {
			store.append({ type, aggregateId: "objective-1", actor: "human", payload: {} });
		}
		const listings = vi.mocked(readBoundedDirectoryNamesSync);
		listings.mockClear();

		expect(store.readAfter(3)).toEqual([]);
		expect(store.readAfter(3)).toEqual([]);
		expect(listings).not.toHaveBeenCalled();

		peer().append({ type: "objective.cancelled", aggregateId: "objective-1", actor: "human", payload: {} });
		expect(store.readAfter(3).map((event) => event.ordinal)).toEqual([4]);
		expect(store.readAfter(4)).toEqual([]);
	});

	it("reports a truncated committed event the cursor proves instead of nothing new", () => {
		const store = makeStore();
		store.append({ type: "objective.created", aggregateId: "objective-1", actor: "kernel", payload: {} });
		store.append({ type: "objective.paused", aggregateId: "objective-1", actor: "human", payload: {} });
		unlinkSync(join(store.eventsDir, "0000000000000002.json"));

		expect(() => store.readAfter(1)).toThrow("Orchestration cursor 2 is ahead of the last committed event 1");
	});

	it("keeps a peer's compaction visible at every ordinal a poll can ask about", () => {
		const store = makeStore("session-1", { maxTailEvents: 2 });
		const compactor = new DurableTaskRuntime({ store: peer({ maxTailEvents: 2 }) });
		for (const id of ["objective-1", "objective-2", "objective-3"]) {
			compactor.createObjective({ objectiveId: id, title: id, description: "compacted by a peer" });
		}
		const through = store.readProjectionSnapshot()?.throughOrdinal;
		expect(through).toBe(2);

		expect(() => store.readAfter(1)).toThrow(OrchestrationSnapshotRequiredError);
		expect(store.readAfter(2).map((event) => event.ordinal)).toEqual([3]);
		expect(store.readAfter(3)).toEqual([]);
	});
});

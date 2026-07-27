import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationEvent } from "../src/core/orchestration/contracts.ts";
import {
	OrchestrationConcurrencyError,
	OrchestrationEventStore,
	OrchestrationEventStoreError,
	OrchestrationSnapshotRequiredError,
} from "../src/core/orchestration/event-store.ts";
import { runSignaledWorkerThreads } from "./worker-thread-fixture.ts";

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
const { agentDir, sessionId, writerId, iterations } = workerData;
let eventSequence = 0;
const store = new OrchestrationEventStore({
	agentDir,
	sessionId,
	createEventId: () => \`event-\${writerId}-\${eventSequence++}\`,
});
for (let index = 0; index < iterations; index++) {
	store.append({
		type: "objective.created",
		aggregateId: \`objective-\${writerId}-\${index}\`,
		actor: "kernel",
		idempotencyKey: \`writer-\${writerId}-event-\${index}\`,
		payload: { writerId, index },
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
		unlinkSync(store.cursorPath);

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

	it("rebuilds an idempotency marker from a committed crash tail", () => {
		const store = makeStore();
		const input = {
			type: "attempt.queued" as const,
			aggregateId: "task-1",
			actor: "runtime" as const,
			idempotencyKey: "queue-after-cursor-loss",
			payload: { attemptId: "attempt-1" },
		};
		const first = store.append(input);
		unlinkSync(store.cursorPath);

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

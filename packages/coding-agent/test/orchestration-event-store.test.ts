import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneRegistration, WorktreeSyncEpoch } from "../src/core/worktree-sync/codes.ts";
import {
	acquireIntegrationLock,
	appendAuditEvent,
	listLanes,
	OWNERLESS_LOCK_STALE_MS,
	readEpoch,
	readLane,
	readLockHolder,
	releaseIntegrationLock,
	repoSlug,
	syncStorePaths,
	writeEpoch,
	writeLane,
} from "../src/core/worktree-sync/store.ts";

const cleanups: string[] = [];

function tempStore() {
	const dir = mkdtempSync(join(tmpdir(), "pi-wt-sync-store-"));
	cleanups.push(dir);
	return syncStorePaths(dir);
}

afterEach(() => {
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function lane(overrides: Partial<LaneRegistration> = {}): LaneRegistration {
	return {
		laneKey: "adhoc-1",
		branch: "pi/wt/adhoc-1",
		worktreePath: "/tmp/wt/adhoc-1",
		status: "active",
		createdAt: "2026-07-19T00:00:00.000Z",
		updatedAt: "2026-07-19T00:00:00.000Z",
		...overrides,
	};
}

describe("worktree-sync store", () => {
	it("repoSlug is deterministic, sanitized, and distinguishes same-named repos by common-dir path", () => {
		const a = repoSlug("/home/u/My Repo!", "/home/u/My Repo!/.git");
		const b = repoSlug("/home/u/My Repo!", "/home/u/My Repo!/.git");
		const c = repoSlug("/srv/other/My Repo!", "/srv/other/My Repo!/.git");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^my-repo-[0-9a-f]{8}$/);
	});

	it("epoch roundtrips atomically and a corrupt file reads as absent (git stays the truth)", async () => {
		const paths = tempStore();
		expect(await readEpoch(paths)).toBeUndefined();
		const epoch: WorktreeSyncEpoch = {
			epoch: 3,
			mainSha: "abc",
			previousMainSha: "def",
			landedLaneKey: "g1-2",
			landedAt: "2026-07-19T01:00:00.000Z",
			changedPaths: ["src/x.ts"],
			changedPathsTruncated: false,
		};
		await writeEpoch(paths, epoch);
		expect(await readEpoch(paths)).toEqual(epoch);
		writeFileSync(paths.epochFile, "{ not json", "utf-8");
		expect(await readEpoch(paths)).toBeUndefined();
	});

	it("lane registrations write/read/list; non-json entries are ignored", async () => {
		const paths = tempStore();
		await writeLane(paths, lane({ laneKey: "b-lane", branch: "pi/wt/b-lane" }));
		await writeLane(paths, lane({ laneKey: "a-lane", branch: "pi/wt/a-lane" }));
		writeFileSync(join(paths.lanesDir, "junk.txt"), "noise", "utf-8");
		const lanes = await listLanes(paths);
		expect(lanes.map((entry) => entry.laneKey)).toEqual(["a-lane", "b-lane"]);
		expect(await readLane(paths, "a-lane")).toMatchObject({ branch: "pi/wt/a-lane" });
		expect(await readLane(paths, "missing")).toBeUndefined();
	});

	it("audit events append as parseable single JSON lines stamped with at", async () => {
		const paths = tempStore();
		await appendAuditEvent(paths, { event: "lane_created", laneKey: "x" }, "T1");
		await appendAuditEvent(paths, { event: "lock_takeover" }, "T2");
		const lines = readFileSync(paths.eventsFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toEqual({ at: "T1", event: "lane_created", laneKey: "x" });
		expect(JSON.parse(lines[1] ?? "")).toEqual({ at: "T2", event: "lock_takeover" });
	});

	it("lock: exclusive while the owner is alive; released lock is reacquirable", async () => {
		const paths = tempStore();
		const owner = { pid: 1234, hostname: "host-a", sessionId: "s1", laneKey: "adhoc-1" };
		const first = await acquireIntegrationLock(paths, owner, { isPidAlive: () => true });
		expect(first.acquired).toBe(true);
		if (!first.acquired) throw new Error("first lock acquisition failed");
		expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
		expect(await readLockHolder(paths)).toMatchObject({ pid: 1234, laneKey: "adhoc-1", token: first.token });

		const second = await acquireIntegrationLock(paths, { ...owner, pid: 99 }, { isPidAlive: () => true });
		expect(second.acquired).toBe(false);
		if (!second.acquired) {
			expect(second.holderAlive).toBe(true);
			expect(second.holder?.pid).toBe(1234);
		}

		expect(await releaseIntegrationLock(paths, first.token)).toBe(true);
		const third = await acquireIntegrationLock(paths, { ...owner, pid: 99 }, { isPidAlive: () => true });
		expect(third.acquired).toBe(true);
	});

	it("lock: a provably-dead owner is taken over, audited", async () => {
		const paths = tempStore();
		await acquireIntegrationLock(paths, { pid: 1, hostname: "host-a" }, { isPidAlive: () => true });
		const takeover = await acquireIntegrationLock(paths, { pid: 2, hostname: "host-a" }, { isPidAlive: () => false });
		expect(takeover.acquired).toBe(true);
		if (!takeover.acquired) throw new Error("takeover failed");
		const events = readFileSync(paths.eventsFile, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { event: string });
		expect(events.some((event) => event.event === "lock_takeover")).toBe(true);
		expect(await readLockHolder(paths)).toMatchObject({ pid: 2 });
	});

	it("lock: a stale release token cannot delete a successor lock", async () => {
		const paths = tempStore();
		const first = await acquireIntegrationLock(paths, { pid: 1, hostname: "host-a" }, { isPidAlive: () => true });
		expect(first.acquired).toBe(true);
		if (!first.acquired) throw new Error("first lock acquisition failed");
		const successor = await acquireIntegrationLock(
			paths,
			{ pid: 2, hostname: "host-a" },
			{ isPidAlive: (owner) => owner.pid !== 1 },
		);
		expect(successor.acquired).toBe(true);
		if (!successor.acquired) throw new Error("successor lock acquisition failed");
		expect(await releaseIntegrationLock(paths, first.token)).toBe(false);
		expect(await readLockHolder(paths)).toMatchObject({ pid: 2, token: successor.token });
	});

	it("lock: an ownerless dir is held while fresh and taken over once stale", async () => {
		const paths = tempStore();
		mkdirSync(paths.lockDir, { recursive: true });

		const fresh = await acquireIntegrationLock(paths, { pid: 2, hostname: "host-a" }, { isPidAlive: () => true });
		expect(fresh.acquired).toBe(false);

		const past = new Date(Date.now() - OWNERLESS_LOCK_STALE_MS - 1000);
		utimesSync(paths.lockDir, past, past);
		const stale = await acquireIntegrationLock(paths, { pid: 2, hostname: "host-a" }, { isPidAlive: () => true });
		expect(stale.acquired).toBe(true);
		if (!stale.acquired) throw new Error("stale lock takeover failed");
		expect(existsSync(paths.lockOwnerFile)).toBe(true);
	});
});

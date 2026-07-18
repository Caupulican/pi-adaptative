import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeInFlightWorkUnit,
	describeReloadSession,
	getInFlightWorkUnits,
	getPendingReloadBlockers,
	getReloadCoordinationDir,
	registerInFlightWork,
	resetInFlightWorkRegistryForTests,
} from "../src/core/reload-blockers.ts";

let tempDir = "";

function createTempAgentDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "pi-reload-blockers-"));
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("describeReloadSession", () => {
	it("includes pid, cwd, and session file when available", () => {
		expect(
			describeReloadSession({
				key: "session-key",
				pid: 1234,
				sessionId: "auto-learn-1",
				cwd: "/repo",
				sessionFile: "/sessions/auto-learn.jsonl",
			}),
		).toBe("session-key:auto-learn-1 pid=1234 cwd=/repo file=/sessions/auto-learn.jsonl");
	});
});

describe("getPendingReloadBlockers", () => {
	it("reports live active/background reload blockers and excludes own, stale, reloaded, and dead sessions", () => {
		const agentDir = createTempAgentDir();
		const coordinationDir = getReloadCoordinationDir(agentDir);
		const now = 1_700_000_000_000;
		writeFileSync(
			join(coordinationDir, "active-turns.json"),
			JSON.stringify({
				version: 1,
				updatedAt: new Date(now).toISOString(),
				sessions: {
					own: {
						pid: 100,
						sessionId: "foreground",
						sessionFile: "/sessions/foreground.jsonl",
						cwd: "/repo",
						active: true,
						updatedAt: now,
					},
					samePidOpaque: {
						pid: 100,
						cwd: "/repo",
						active: true,
						updatedAt: now,
					},
					peer: {
						pid: 101,
						sessionId: "peer-session",
						sessionFile: "/sessions/peer.jsonl",
						cwd: "/repo",
						active: true,
						updatedAt: now,
					},
					autoLearnPeer: {
						pid: 107,
						sessionId: "auto-learn-peer",
						sessionFile: "/sessions/auto-learn-peer.jsonl",
						cwd: "/repo",
						active: true,
						updatedAt: now,
					},
					stale: {
						pid: 102,
						sessionId: "old",
						cwd: "/repo",
						active: true,
						updatedAt: now - 6 * 60_000,
					},
					dead: {
						pid: 103,
						sessionId: "dead",
						cwd: "/repo",
						active: true,
						updatedAt: now,
					},
				},
			}),
		);
		writeFileSync(
			join(coordinationDir, "auto-reload-state.json"),
			JSON.stringify({
				version: 1,
				updatedAt: new Date(now).toISOString(),
				changes: {
					change: {
						signature: "sig",
						reason: "Pi resources changed",
						firstSeenAt: now,
						sessions: {
							coordinator: {
								pid: 104,
								sessionId: "coordinator-session",
								sessionFile: "/sessions/coordinator.jsonl",
								cwd: "/repo",
								seenAt: now,
							},
							autoLearnCoordinator: {
								pid: 108,
								sessionId: "auto-learn-coordinator",
								sessionFile: "/sessions/auto-learn-coordinator.jsonl",
								cwd: "/repo",
								seenAt: now,
							},
							reloaded: {
								pid: 105,
								sessionId: "already-reloaded",
								cwd: "/repo",
								seenAt: now,
								reloadedAt: now,
							},
						},
					},
					oldChange: {
						signature: "old",
						reason: "Old resources changed",
						firstSeenAt: now - 11 * 60_000,
						sessions: {
							oldCoordinator: { pid: 106, sessionId: "old-coordinator", cwd: "/repo", seenAt: now },
						},
					},
				},
			}),
		);

		const status = getPendingReloadBlockers({
			agentDir,
			now,
			ownPid: 100,
			ownSessionId: "foreground",
			ownSessionFile: "/sessions/foreground.jsonl",
			isProcessAlive: (pid) => pid !== 103,
		});

		expect(status.pending).toBe(true);
		expect(status.reason).toBe("Pi resources changed");
		expect(status.descriptions).toEqual([
			"coordinator:coordinator-session pid=104 cwd=/repo file=/sessions/coordinator.jsonl",
			"peer:peer-session pid=101 cwd=/repo file=/sessions/peer.jsonl",
		]);

		const includingAutoLearn = getPendingReloadBlockers({
			agentDir,
			now,
			ownPid: 100,
			ownSessionId: "foreground",
			ownSessionFile: "/sessions/foreground.jsonl",
			includeAutoLearnSessions: true,
			isProcessAlive: (pid) => pid !== 103,
		});
		expect(includingAutoLearn.descriptions).toContain(
			"autoLearnCoordinator:auto-learn-coordinator pid=108 cwd=/repo file=/sessions/auto-learn-coordinator.jsonl",
		);
		expect(includingAutoLearn.descriptions).toContain(
			"autoLearnPeer:auto-learn-peer pid=107 cwd=/repo file=/sessions/auto-learn-peer.jsonl",
		);
	});
});

describe("in-process quiesce registry", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("tracks a registered unit and clears it once deregistered", () => {
		expect(getInFlightWorkUnits("/agent-a")).toEqual([]);

		const deregister = registerInFlightWork("/agent-a", "lane", "research:lane-1");
		const units = getInFlightWorkUnits("/agent-a");
		expect(units).toHaveLength(1);
		expect(describeInFlightWorkUnit(units[0]!)).toBe("lane:research:lane-1");

		deregister();
		expect(getInFlightWorkUnits("/agent-a")).toEqual([]);
	});

	it("is safe to deregister twice (a caller may deregister on more than one exit path)", () => {
		const deregister = registerInFlightWork("/agent-a", "scout", "q");
		deregister();
		expect(() => deregister()).not.toThrow();
		expect(getInFlightWorkUnits("/agent-a")).toEqual([]);
	});

	it("scopes units by agentDir so two sessions never see each other's in-flight work", () => {
		const deregisterA = registerInFlightWork("/agent-a", "lane", "worker:1");
		const deregisterB = registerInFlightWork("/agent-b", "scout", "q");

		expect(getInFlightWorkUnits("/agent-a")).toHaveLength(1);
		expect(getInFlightWorkUnits("/agent-b")).toHaveLength(1);

		deregisterA();
		expect(getInFlightWorkUnits("/agent-a")).toEqual([]);
		expect(getInFlightWorkUnits("/agent-b")).toHaveLength(1);

		deregisterB();
		expect(getInFlightWorkUnits("/agent-b")).toEqual([]);
	});

	it("tracks multiple concurrent units for the same agentDir independently", () => {
		const deregister1 = registerInFlightWork("/agent-a", "lane", "research:1");
		const deregister2 = registerInFlightWork("/agent-a", "isolated-completion", "reflection");
		expect(getInFlightWorkUnits("/agent-a")).toHaveLength(2);

		deregister1();
		const remaining = getInFlightWorkUnits("/agent-a");
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.label).toBe("reflection");

		deregister2();
		expect(getInFlightWorkUnits("/agent-a")).toEqual([]);
	});
});

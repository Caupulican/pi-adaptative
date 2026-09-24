import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { afterEach, describe, expect, it } from "vitest";
import { priceExecutor } from "../src/core/compaction/early-compaction-economics.ts";
import { isMutatingToolCall } from "../src/core/model-router/tool-escalation.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { currentWorkUnit, openWorkUnit } from "../src/core/work-units.ts";

const owner = (manager: SessionManager, text: string) =>
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });

describe("work units", () => {
	it("keeps an enforced unit open until the owner speaks again", () => {
		const manager = SessionManager.inMemory();
		owner(manager, "fix the typo");
		expect(currentWorkUnit(manager)).toBeUndefined();
		openWorkUnit(manager, { kind: "enforced", reason: "first mutating call: edit" });
		expect(currentWorkUnit(manager)?.record.kind).toBe("enforced");
		owner(manager, "thanks, now the next one");
		expect(currentWorkUnit(manager)).toBeUndefined();
	});

	it("keeps a declared unit open across owner messages while its goal is worked", () => {
		const manager = SessionManager.inMemory();
		openWorkUnit(manager, { kind: "declared", goalId: "g1", reason: "ship it" });
		owner(manager, "keep going");
		expect(currentWorkUnit(manager, "g1")?.record).toMatchObject({ kind: "declared", goalId: "g1" });
		// Once the goal is no longer worked, the owner's message ended it.
		expect(currentWorkUnit(manager)).toBeUndefined();
	});
});

describe("the read/write line", () => {
	it("separates calls that may change the world from reads", () => {
		expect(isMutatingToolCall("read", { path: "a" })).toBe(false);
		expect(isMutatingToolCall("bash", { command: "ls -la" })).toBe(false);
		expect(isMutatingToolCall("bash", { command: "echo hi > a.txt" })).toBe(true);
		expect(isMutatingToolCall("edit", { path: "a" })).toBe(true);
	});
});

describe("executor price", () => {
	const talker = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, tierActive: false };
	it("hands work to a worker when its brief costs less than the talker's warm prefix over the learned requests", () => {
		const verdict = priceExecutor({
			talkerPrefixTokens: 150_000,
			briefTokens: 2_000,
			reportTokens: 4_000,
			requests: 12,
			talker,
			worker: talker,
		});
		expect(verdict.executor).toBe("worker");
	});

	it("keeps work on the talker when its prefix is small, or nothing is learned", () => {
		expect(
			priceExecutor({
				talkerPrefixTokens: 3_000,
				briefTokens: 2_000,
				reportTokens: 4_000,
				requests: 3,
				talker,
				worker: talker,
			}).executor,
		).toBe("root");
		expect(
			priceExecutor({
				talkerPrefixTokens: 150_000,
				briefTokens: 2_000,
				reportTokens: 4_000,
				requests: undefined,
				talker,
				worker: talker,
			}).executor,
		).toBe("root");
	});
});

describe("learned root route requests", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("counts the requests between a root route's decision and the next decision", () => {
		const dir = mkdtempSync(join(tmpdir(), "route-requests-"));
		dirs.push(dir);
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decision-ledger.sqlite") });
		const decide = (cycleId: string, route: string, at: number, executor?: string) => {
			ledger.recordRoute({
				sessionId: "s",
				cwd: "/repo",
				objectiveId: "o",
				cycleId,
				route,
				reasonCodes: [],
				decidedAt: at,
				evidenceMarker: 0,
			});
			if (executor) ledger.noteRouteExecutor("s", cycleId, executor);
		};
		const request = (at: number) =>
			ledger.recordCacheObservation({
				sessionId: "s",
				cwd: "/repo",
				lane: "lane",
				observedAt: at,
				promptTokens: 1,
				cacheReadTokens: 0,
				prefixIntact: "true",
			});
		decide("c1", "implement", 100, "root");
		for (const at of [110, 120, 130]) request(at);
		decide("c2", "implement", 200, "root");
		for (const at of [210, 220, 230, 240, 250]) request(at);
		decide("c3", "verify", 300, "worker");
		request(310);
		expect(ledger.learnedRootRouteRequests("implement")).toBe(4);
		// A route the root has not run to a next decision has nothing learned.
		expect(ledger.learnedRootRouteRequests("verify")).toBeUndefined();
	});
});

import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, WorkerResult } from "../src/core/autonomy/contracts.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { getInFlightWorkUnits, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { createDelegateStatusToolDefinition } from "../src/core/tools/delegate-status.ts";

const ctx = undefined as unknown as ExtensionContext;

/**
 * Host re-review: a managed (tmux) lane's SELF-REPORTED `changedFiles` are re-checked
 * against the session's active capability envelope on terminal, reusing `validateWorkerResult`'s
 * symlink-safe scope check (`reviewManagedLaneChangedFiles` in delegation/worker-result.ts) --
 * never a parallel path-scope implementation. Unlike an in-process worker (whose writes are
 * already envelope-enforced before the fact by `applyWorkerActions`), a tmux worker's write already
 * happened out-of-process with no backstop, so this re-check is the ONLY gate standing between an
 * out-of-scope claim and the goal/evidence machinery trusting it.
 */
function buildDeps(
	agentDir: string,
	overrides?: Partial<{
		envelope: CapabilityEnvelope | undefined;
		cwd: string;
	}>,
): { deps: BackgroundLaneControllerDeps; savedResults: Array<{ result: WorkerResult; request?: unknown }> } {
	const savedResults: Array<{ result: WorkerResult; request?: unknown }> = [];
	const sessionManager = {
		getEntries: () => [],
		appendCustomEntry: () => "entry-1",
	} as unknown as SessionManager;
	const deps = {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => overrides?.cwd ?? "/repo",
		getAgentDir: () => agentDir,
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => undefined,
		getCapabilityEnvelope: () => overrides?.envelope,
		saveWorkerResultSnapshot: (result: WorkerResult, request?: unknown) => {
			savedResults.push({ result, request });
			return `worker-result-entry-${savedResults.length}`;
		},
	} as unknown as BackgroundLaneControllerDeps;
	return { deps, savedResults };
}

describe("host re-review of a managed (tmux) lane's changed files", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("flags parentReviewRequired when a changed file is OUTSIDE the envelope's allowedPaths", () => {
		const agentDir = "/tmp/pi-test-tmux-review-out-of-scope";
		const { deps, savedResults } = buildDeps(agentDir, {
			envelope: { id: "env-1", capabilities: ["write_files"], allowedPaths: ["/repo/src"] },
		});
		const controller = new BackgroundLaneController(deps);

		controller.recordManagedLane({ laneId: "tmux-job-1", phase: "dispatch" });
		controller.recordManagedLane({
			laneId: "tmux-job-1",
			phase: "terminal",
			status: "succeeded",
			changedFiles: ["../outside/evil.ts"],
		});

		expect(savedResults).toHaveLength(1);
		expect(savedResults[0]?.result.parentReviewRequired).toBe(true);
		expect(savedResults[0]?.result.summary).toContain("parent review");
	});

	it("STILL flags parentReviewRequired for an IN-scope changed file (worker output is always untrusted)", () => {
		const agentDir = "/tmp/pi-test-tmux-review-in-scope";
		const { deps, savedResults } = buildDeps(agentDir, {
			envelope: { id: "env-1", capabilities: ["write_files"], allowedPaths: ["/repo/src"] },
		});
		const controller = new BackgroundLaneController(deps);

		controller.recordManagedLane({ laneId: "tmux-job-2", phase: "dispatch" });
		controller.recordManagedLane({
			laneId: "tmux-job-2",
			phase: "terminal",
			status: "succeeded",
			changedFiles: ["src/a.ts"],
		});

		expect(savedResults).toHaveLength(1);
		expect(savedResults[0]?.result.parentReviewRequired).toBe(true);
	});

	it("conservatively flags review when no capability envelope is configured at all", () => {
		const agentDir = "/tmp/pi-test-tmux-review-no-envelope";
		const { deps, savedResults } = buildDeps(agentDir, { envelope: undefined });
		const controller = new BackgroundLaneController(deps);

		controller.recordManagedLane({ laneId: "tmux-job-3", phase: "dispatch" });
		controller.recordManagedLane({
			laneId: "tmux-job-3",
			phase: "terminal",
			status: "succeeded",
			changedFiles: ["src/a.ts"],
		});

		expect(savedResults[0]?.result.parentReviewRequired).toBe(true);
	});

	it("does not require review for a read-only completion (no changed files)", () => {
		const agentDir = "/tmp/pi-test-tmux-review-read-only";
		const { deps, savedResults } = buildDeps(agentDir, {
			envelope: { id: "env-1", capabilities: ["write_files"], allowedPaths: ["/repo/src"] },
		});
		const controller = new BackgroundLaneController(deps);

		controller.recordManagedLane({ laneId: "tmux-job-4", phase: "dispatch" });
		controller.recordManagedLane({ laneId: "tmux-job-4", phase: "terminal", status: "succeeded", changedFiles: [] });

		expect(savedResults[0]?.result.parentReviewRequired).toBe(false);
	});

	it("a duplicate terminal report for the same laneId does not double-record the claim", () => {
		const agentDir = "/tmp/pi-test-tmux-review-duplicate-terminal";
		const { deps, savedResults } = buildDeps(agentDir, {
			envelope: { id: "env-1", capabilities: ["write_files"], allowedPaths: ["/repo/src"] },
		});
		const controller = new BackgroundLaneController(deps);

		controller.recordManagedLane({ laneId: "tmux-job-5", phase: "dispatch" });
		controller.recordManagedLane({
			laneId: "tmux-job-5",
			phase: "terminal",
			status: "succeeded",
			changedFiles: ["src/a.ts"],
		});
		// A second terminal report for the SAME external laneId: the dispatch->terminal
		// correlation was already consumed and removed, so this must be a safe no-op.
		controller.recordManagedLane({
			laneId: "tmux-job-5",
			phase: "terminal",
			status: "succeeded",
			changedFiles: ["src/a.ts"],
		});

		expect(savedResults).toHaveLength(1);
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("surfaces an out-of-scope tmux-worker mutation as UNREVIEWED through the existing delegate_status tool", async () => {
		const agentDir = "/tmp/pi-test-tmux-review-delegate-status";
		const { deps, savedResults } = buildDeps(agentDir, {
			envelope: { id: "env-1", capabilities: ["write_files"], allowedPaths: ["/repo/src"] },
		});
		const controller = new BackgroundLaneController(deps);

		controller.recordManagedLane({ laneId: "tmux-job-6", phase: "dispatch" });
		controller.recordManagedLane({
			laneId: "tmux-job-6",
			phase: "terminal",
			status: "succeeded",
			changedFiles: ["../outside/evil.ts"],
		});
		const internalLaneId = controller.getLaneRecords()[0]?.laneId;
		expect(internalLaneId).toBeDefined();

		const statusTool = createDelegateStatusToolDefinition({
			getLaneRecords: () => controller.getLaneRecords(),
			getWorkerResultSnapshots: () => savedResults.map((entry) => entry.result),
		});
		const result = await statusTool.execute("call", { laneId: internalLaneId }, undefined, undefined, ctx);
		const text = result.content
			.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
			.map((entry) => entry.text)
			.join("\n");

		expect(text).toContain("UNREVIEWED MUTATION");
		expect((result.details as { unreviewed?: boolean }).unreviewed).toBe(true);
	});
});

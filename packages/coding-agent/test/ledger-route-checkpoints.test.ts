import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceMarkerOf, LedgerRouteCheckpoints } from "../src/core/objective-execution/ledger-route-checkpoints.ts";
import type { ObjectiveRoute } from "../src/core/objective-execution/objective-route.ts";
import {
	projectBoundedCombinedState,
	repeatedRouteCount,
} from "../src/core/objective-execution/objective-route-projector.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import type { TaskRuntimeProjection } from "../src/core/orchestration/task-runtime-state.ts";
import { tempDir } from "./temp-dir.ts";

function route(
	cycle: number,
	name: ObjectiveRoute["route"],
	reasons: string[] = ["implementation_required"],
): ObjectiveRoute {
	return { schema_version: "1.0", cycle_id: `c${cycle}`, objective_id: "goal:g1", route: name, reason_codes: reasons };
}

describe("the decision ledger as a route input", () => {
	// SQLite handles close before tempDir removes their directory, whether the test passed or failed.
	const ledgers: DecisionLedgerStore[] = [];
	afterEach(() => {
		for (const ledger of ledgers.splice(0)) ledger.close();
	});

	function openCheckpoints(getSnapshot: () => TaskRuntimeProjection) {
		const ledger = new DecisionLedgerStore({
			databasePath: join(tempDir("pi-route-ledger-"), "decision-ledger.sqlite"),
		});
		ledgers.push(ledger);
		return new LedgerRouteCheckpoints({
			getLedger: () => ledger,
			sessionId: "s1",
			cwd: "/work",
			getSnapshot,
			now: () => 1000,
		});
	}

	const emptySnapshot = { objectives: {}, tasks: {}, attempts: {} } as unknown as TaskRuntimeProjection;

	it("records routes with their executor, feeds them back as history, and calls a repeat on unchanged evidence a stall", async () => {
		let snapshot = emptySnapshot;
		const checkpoints = openCheckpoints(() => snapshot);
		await checkpoints.recordRoute(route(1, "retrieve", ["evidence_retrieval_required"]));
		await checkpoints.recordRouteOutcome(route(1, "retrieve"), "root");
		expect(await checkpoints.evaluate("goal:g1")).toMatchObject({ stalled: false, stallTurns: 0 });
		await checkpoints.recordRoute(route(2, "implement"));
		await checkpoints.recordRouteOutcome(route(2, "implement"), "root");
		await checkpoints.recordRoute(route(3, "implement"));
		await checkpoints.recordRouteOutcome(route(3, "implement"), "root");
		const history = await checkpoints.recentRoutes("goal:g1", 6);
		expect(history.map((entry) => `${entry.route}:${entry.executor}`)).toEqual([
			"retrieve:root",
			"implement:root",
			"implement:root",
		]);
		expect(repeatedRouteCount(history)).toBe(2);
		expect(await checkpoints.evaluate("goal:g1")).toMatchObject({
			stalled: true,
			stallTurns: 1,
			repeatedWithoutNewEvidence: true,
			reason: "route implement repeated 2 times without new evidence",
		});
		const projection = projectBoundedCombinedState("goal:g1", snapshot, { history });
		expect(projection.history.repeated_route_count).toBe(2);
		expect(projection.history.recent_routes.at(-1)).toEqual({
			route: "implement",
			reason_codes: ["implementation_required"],
			executor: "root",
		});
		// New evidence resets the repetition: the same route is a fresh decision.
		snapshot = {
			objectives: { "goal:g1": { evidence: [{ evidenceId: "e1" }] } },
			tasks: {},
			attempts: {},
		} as unknown as TaskRuntimeProjection;
		expect(evidenceMarkerOf(snapshot, "goal:g1")).toBe(1000);
		await checkpoints.recordRoute(route(4, "implement"));
		expect(await checkpoints.evaluate("goal:g1")).toMatchObject({ stalled: false });
	});

	it.each([
		["wait_for_worker", "active_worker_in_flight"],
		["wait_for_tool", "active_tool_in_flight"],
	] as const)("a repeated %s tail on unchanged evidence is waiting, not strategy repetition", async (name, reason) => {
		const checkpoints = openCheckpoints(() => emptySnapshot);
		for (let cycle = 1; cycle <= 3; cycle++) await checkpoints.recordRoute(route(cycle, name, [reason]));

		expect(repeatedRouteCount(await checkpoints.recentRoutes("goal:g1", 8))).toBe(3);
		expect(await checkpoints.evaluate("goal:g1")).toMatchObject({
			stalled: false,
			stallTurns: 0,
			repeatedWithoutNewEvidence: false,
		});
	});

	it("negative control: an executable route repeated after waits on unchanged evidence is still a stall", async () => {
		const checkpoints = openCheckpoints(() => emptySnapshot);
		await checkpoints.recordRoute(route(1, "wait_for_worker", ["active_worker_in_flight"]));
		await checkpoints.recordRoute(route(2, "wait_for_worker", ["active_worker_in_flight"]));
		await checkpoints.recordRoute(route(3, "implement"));
		await checkpoints.recordRoute(route(4, "implement"));

		expect(await checkpoints.evaluate("goal:g1")).toMatchObject({
			stalled: true,
			repeatedWithoutNewEvidence: true,
			reason: "route implement repeated 2 times without new evidence",
		});
	});
});

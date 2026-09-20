import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function route(
	cycle: number,
	name: ObjectiveRoute["route"],
	reasons: string[] = ["implementation_required"],
): ObjectiveRoute {
	return { schema_version: "1.0", cycle_id: `c${cycle}`, objective_id: "goal:g1", route: name, reason_codes: reasons };
}

describe("the decision ledger as a route input", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("records routes with their executor, feeds them back as history, and calls a repeat on unchanged evidence a stall", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-route-ledger-"));
		dirs.push(dir);
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decision-ledger.sqlite") });
		let snapshot = { objectives: {}, tasks: {}, attempts: {} } as unknown as TaskRuntimeProjection;
		const checkpoints = new LedgerRouteCheckpoints({
			getLedger: () => ledger,
			sessionId: "s1",
			cwd: "/work",
			getSnapshot: () => snapshot,
			now: () => 1000,
		});
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
		ledger.close();
	});
});

import { describe, expect, it } from "vitest";
import { FLEET_AGING_STEP_MS, FleetQueue } from "../src/core/fleet/fleet-queue.ts";
import type { FleetPriority, WeightClass } from "../src/core/fleet/fleet-types.ts";

function queueProbe(
	queue: FleetQueue<string>,
	id: string,
	subtreeId: string,
	priority: FleetPriority = 0,
	weight: WeightClass = "probe",
): void {
	queue.push({ id, payload: id, objectiveId: "objective", subtreeId, priority, weight });
}

describe("fleet queue service order", () => {
	it("reweights a snapshot flow when its highest-priority entry leaves and breaks finish ties by arrival", () => {
		const queue = new FleetQueue<string>({ now: () => 0 });
		queueProbe(queue, "a-head", "a", 3, "heavy");
		queueProbe(queue, "b-head", "b");
		queueProbe(queue, "b-tail", "b");
		queueProbe(queue, "a-tail", "a");

		const expected = ["a-head", "b-head", "b-tail", "a-tail"];
		expect(queue.ids()).toEqual(expected);
		expect(queue.ids()).toEqual(expected);
	});

	it("charges an admitted non-head at the ready flow weight and leaves other flows uncharged", () => {
		const queue = new FleetQueue<string>({ now: () => 0 });
		queueProbe(queue, "a-head", "a", 3, "heavy");
		queueProbe(queue, "b-head", "b");
		queueProbe(queue, "b-tail", "b");
		queueProbe(queue, "a-tail", "a");
		queue.openShare({ subtreeId: "b", parentSubtreeId: "root", weight: 1.25 });

		expect(queue.dispatch("a-tail")).toBe(true);
		expect(queue.ids()).toEqual(["b-head", "a-head", "b-tail"]);
		expect(queue.delete("b-head")).toBe(true);
		expect(queue.ids()).toEqual(["b-tail", "a-head"]);
	});

	it("recalculates age and critical-path priority at the next pass using restored enqueue time", () => {
		let now = FLEET_AGING_STEP_MS;
		const queue = new FleetQueue<string>({
			now: () => now,
			claimRestored: (id) => (id === "aging" ? 0 : undefined),
		});
		queueProbe(queue, "aging", "a");
		expect(queue.entry("aging")?.enqueuedAt).toBe(0);
		queue.push({
			id: "critical",
			payload: "critical",
			objectiveId: "objective",
			subtreeId: "a",
			priority: 1,
			weight: "probe",
			criticalPath: true,
		});
		expect(queue.ids()).toEqual(["critical", "aging"]);
		now += FLEET_AGING_STEP_MS * 2;
		// Both saturate at three; higher base priority then wins inside the flow.
		expect(queue.ids()).toEqual(["critical", "aging"]);

		queueProbe(queue, "fresh", "b", 1);
		expect(queue.ids()).toEqual(["critical", "aging", "fresh"]);
	});
});

import { describe, expect, it } from "vitest";
import { ToolInvocationReport } from "../src/tool-invocation-report.ts";

function observation(
	call: string,
	execution: string,
	options: { error?: boolean; request?: string; post?: string[] } = {},
) {
	return {
		toolCallId: call,
		isError: options.error ?? false,
		details: {
			piToolInvocation: {
				version: 1,
				requestId: options.request ?? "fixture-request",
				execution,
				...(execution === "completed" ? { operationStatus: options.error ? "error" : "success" } : {}),
				postprocessingFailures: options.post ?? [],
			},
		},
	};
}

describe("receipt-derived invocation reporting", () => {
	it("conserves calls under deterministic adversarial handoff/replay permutations", () => {
		for (let seed = 1; seed <= 16; seed++) {
			const report = new ToolInvocationReport();
			const events = Array.from({ length: 30 }, (_, index) => {
				const start = { value: observation(`call-${index}`, "running"), source: "foreground" as const };
				const end = {
					value: observation(`call-${index}`, "completed", {
						error: index % 3 === 0,
						post: index % 5 === 0 ? ["progress"] : [],
					}),
					source: "background" as const,
				};
				return [start, end, start, end];
			}).flat();
			let random = seed;
			for (let index = events.length - 1; index > 0; index--) {
				random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
				const other = random % (index + 1);
				[events[index], events[other]] = [events[other]!, events[index]!];
			}
			for (const event of events) {
				report.record(event.value, event.source);
				const { current, retained } = report.snapshot();
				for (const counts of [current, retained]) {
					expect(counts.calls).toBe(
						counts.succeeded +
							counts.negative +
							counts.unknown +
							counts.notStarted +
							counts.running +
							counts.unclassified,
					);
					expect(Object.values(counts).every((count) => count >= 0 && count <= counts.calls)).toBe(true);
				}
			}
			expect(report.snapshot().current).toEqual(report.snapshot().retained);
			expect(report.snapshot().current).toMatchObject({
				calls: 30,
				succeeded: 20,
				negative: 10,
				errorResults: 10,
				postprocessing: 6,
				conflicts: 0,
				running: 0,
			});
		}
	});
	it("binds an early background terminal to the foreground call without counting the later placeholder twice", () => {
		const report = new ToolInvocationReport();
		report.record(observation("fast-background", "completed", { error: true }), "background");
		report.record(observation("fast-background", "running"));
		expect(report.snapshot()).toMatchObject({
			current: { calls: 1, negative: 1, running: 0 },
			retained: { calls: 1, negative: 1 },
		});
	});
	it("separates cycle calls from retained history and keeps late terminals in their owning cycle", () => {
		const report = new ToolInvocationReport();
		report.record(observation("old", "running"));
		report.record(observation("rejected", "not_started", { error: true }));
		report.beginCycle();
		report.record(observation("new", "completed"));
		report.record(observation("old", "completed", { error: true }), "background");
		expect(report.snapshot()).toMatchObject({
			current: { calls: 1, succeeded: 1, errorResults: 0 },
			retained: { calls: 3, notStarted: 1, negative: 1, errorResults: 2, running: 0 },
			partial: false,
		});
	});

	it("deduplicates replay, ignores delayed handoff placeholders, and never hides conflicting terminals", () => {
		const report = new ToolInvocationReport();
		const success = observation("call", "completed");
		report.record(observation("call", "running"));
		report.record(success, "background");
		expect(report.record(success)).toBe(false);
		expect(report.record(observation("call", "running"))).toBe(false);
		expect(report.snapshot().current).toMatchObject({ calls: 1, succeeded: 1, conflicts: 0 });
		report.record(observation("call", "completed", { error: true }));
		expect(report.snapshot().current).toMatchObject({
			calls: 1,
			succeeded: 0,
			unknown: 1,
			conflicts: 1,
			errorResults: 1,
		});
		report.record(success);
		expect(report.snapshot().current).toMatchObject({ calls: 1, unknown: 1, conflicts: 1, errorResults: 1 });
	});

	it("distinguishes operation outcomes, postprocessing, and unclassified old evidence", () => {
		const report = new ToolInvocationReport();
		report.record(observation("negative", "completed", { error: true }));
		report.record(observation("unknown", "unknown", { error: true }));
		report.record({ ...observation("hook", "completed", { post: ["after_hook"] }), isError: true });
		report.record({ toolCallId: "legacy", isError: false, details: { output: "ERROR: this is ordinary text" } });
		expect(report.snapshot().current).toMatchObject({
			calls: 4,
			succeeded: 1,
			negative: 1,
			unknown: 1,
			unclassified: 1,
			postprocessing: 1,
			errorResults: 3,
		});
	});

	it("keeps identical call IDs under different requests distinct and unknown older background work outside the cycle", () => {
		const report = new ToolInvocationReport();
		report.record(observation("same", "completed", { request: "first" }));
		report.record(observation("same", "completed", { request: "second" }));
		report.record(observation("previous", "completed", { error: true }), "background");
		expect(report.snapshot()).toMatchObject({
			current: { calls: 2, errorResults: 0 },
			retained: { calls: 3, errorResults: 1 },
		});
	});

	it("bounds retained bookkeeping and explicitly marks incomplete counts without dropping replay protection", () => {
		const report = new ToolInvocationReport(512);
		const first = observation("first", "running");
		report.record(first);
		for (let index = 0; index < 100; index++) report.record(observation(`call-${index}`, "completed"));
		expect(report.snapshot().partial).toBe(true);
		expect(report.snapshot().retainedBytes).toBeLessThanOrEqual(512);
		const before = report.snapshot().retained.calls;
		report.record(observation("first", "completed"));
		report.record(first);
		expect(report.snapshot().retained).toMatchObject({ calls: before, running: 0 });
		report.reset();
		expect(report.snapshot()).toMatchObject({
			current: { calls: 0 },
			retained: { calls: 0 },
			partial: false,
			retainedBytes: 0,
		});
	});
});

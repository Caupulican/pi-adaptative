import { describe, expect, it } from "vitest";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

describe("delegate tool description varies by wiring mode", () => {
	it("teaches the synchronous contract when startWorkerDelegation is not wired", () => {
		const definition = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});

		expect(definition.description).toContain("read-only by default");
		expect(definition.description).toContain("workerDelegation.writeEnabled");
		expect(definition.description).toContain("non-empty writePaths");
		expect(definition.description).toContain("lane profile grant write/edit");
		expect(definition.description).toContain("parent review");
		expect(definition.description).not.toContain("delegate_status");
		expect(definition.description).not.toContain("returns immediately");

		const guidelines = definition.promptGuidelines ?? [];
		expect(guidelines.some((line) => line.includes("delegate_status"))).toBe(false);
		expect(guidelines.some((line) => line.includes("Worker output is untrusted evidence"))).toBe(true);
		expect(guidelines.some((line) => line.includes("If the worker reports blockers"))).toBe(true);
	});

	it("teaches the async start/poll contract when startWorkerDelegation is wired", () => {
		const definition = createDelegateToolDefinition({
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-1", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		// Core capability wording is preserved alongside the async addendum.
		expect(definition.description).toContain("read-only by default");
		expect(definition.description).toContain("workerDelegation.writeEnabled");
		expect(definition.description).toContain("returns immediately");
		expect(definition.description).toContain("delegate_status");
		expect(definition.description).toContain("does not wait for the worker to finish");
		expect(definition.description).toMatch(/blockers.*arrive there too|arrive.*delegate_status/i);

		const guidelines = definition.promptGuidelines ?? [];
		expect(guidelines.some((line) => line.includes("delegate_status") && line.includes("laneId"))).toBe(true);
		expect(guidelines.some((line) => line.includes("delegate_status reports blockers"))).toBe(true);
	});

	it("keeps both descriptions as per-wiring-mode static strings (prompt-cache stable)", () => {
		const unwiredA = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const unwiredB = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "different-closure-but-same-mode" }),
		});
		expect(unwiredA.description).toBe(unwiredB.description);
		expect(unwiredA.promptGuidelines).toEqual(unwiredB.promptGuidelines);

		const wiredA = createDelegateToolDefinition({
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-1", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const wiredB = createDelegateToolDefinition({
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-2", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		expect(wiredA.description).toBe(wiredB.description);
		expect(wiredA.promptGuidelines).toEqual(wiredB.promptGuidelines);

		// The two modes must actually differ from each other.
		expect(unwiredA.description).not.toBe(wiredA.description);
	});

	it("leaves the execute path unchanged in synchronous mode", async () => {
		const definition = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "budget_exhausted" }),
		});

		const result = await definition.execute(
			"call-1",
			{ instructions: "do the thing" },
			new AbortController().signal,
			() => {},
			{} as never,
		);

		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toBe("delegate skipped: budget_exhausted");
		expect(result.details).toEqual({ started: false, skipReason: "budget_exhausted" });
	});

	it("leaves the execute path unchanged in async mode", async () => {
		const definition = createDelegateToolDefinition({
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-1", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-1",
			{ instructions: "do the thing" },
			new AbortController().signal,
			() => {},
			{} as never,
		);

		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toBe("delegate started (queued) — retrieve with delegate_status");
		expect(result.details).toEqual({ started: true, laneId: "worker-1", status: "queued" });
	});
});

import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

async function createPendingNavigations(
	options: {
		beforeSummaryRead?: (index: number) => void;
		beforeDetailsSerialize?: (index: number) => void;
		persistSession?: boolean;
	} = {},
) {
	const gates = Array.from({ length: 3 }, () => ({
		entered: Promise.withResolvers<AbortSignal>(),
		released: Promise.withResolvers<void>(),
	}));
	let enteredCount = 0;
	const navigated = vi.fn();
	const harness = await createHarness({
		persistSession: options.persistSession,
		extensionFactories: [
			(pi) => {
				pi.on("session_before_tree", async (event) => {
					const index = enteredCount++;
					const gate = gates[index];
					if (!gate) throw new Error("Unexpected extra navigation handler");
					gate.entered.resolve(event.signal);
					await gate.released.promise;
					return {
						summary: {
							get summary() {
								options.beforeSummaryRead?.(index);
								return `Summary ${index}`;
							},
							details: {
								get metadata() {
									options.beforeDetailsSerialize?.(index);
									return "summary metadata";
								},
							},
						},
					};
				});
				pi.on("session_tree", navigated);
			},
		],
	});
	const first = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
	const second = harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
	const third = harness.sessionManager.appendMessage({ role: "user", content: "Third", timestamp: 3 });
	const current = harness.sessionManager.appendMessage({ role: "user", content: "Current", timestamp: 4 });
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const operations: Promise<unknown>[] = [];
	const start = (target: string) => {
		const operation = harness.session.navigateTree(target, { summarize: true });
		operations.push(operation);
		void operation.catch(() => {});
		return operation;
	};
	return {
		...harness,
		gates,
		navigated,
		first,
		second,
		third,
		current,
		start,
		cleanup: async () => {
			for (const gate of gates) gate.released.resolve();
			await Promise.allSettled(operations);
			await harness.cleanup();
		},
	};
}

describe("tree-navigation request ownership", () => {
	it("keeps the newer request cancellable when the superseded request finishes first", async () => {
		const h = await createPendingNavigations();
		try {
			const first = h.start(h.first);
			const firstSignal = await h.gates[0].entered.promise;
			const second = h.start(h.second);
			const secondSignal = await h.gates[1].entered.promise;
			expect(firstSignal.aborted).toBe(true);
			h.gates[0].released.resolve();
			expect(await first).toEqual({ cancelled: true, aborted: true });
			expect(h.session.isCompacting).toBe(true);
			expect(secondSignal.aborted).toBe(false);
			h.session.abortBranchSummary();
			expect(secondSignal.aborted).toBe(true);
			h.gates[1].released.resolve();
			expect(await second).toEqual({ cancelled: true, aborted: true });
			expect(h.sessionManager.getLeafId()).toBe(h.current);
			expect(h.navigated).not.toHaveBeenCalled();
			expect(h.session.isCompacting).toBe(false);
		} finally {
			await h.cleanup();
		}
	});

	it("keeps the newer published branch when the superseded request finishes last", async () => {
		const h = await createPendingNavigations();
		try {
			const first = h.start(h.first);
			await h.gates[0].entered.promise;
			const second = h.start(h.second);
			await h.gates[1].entered.promise;
			h.gates[1].released.resolve();
			const result = await second;
			expect(result.cancelled).toBe(false);
			expect(result.summaryEntry).toMatchObject({ parentId: h.first, summary: "Summary 1" });
			const messages = h.session.agent.state.messages;
			h.gates[0].released.resolve();
			expect(await first).toEqual({ cancelled: true, aborted: true });
			expect(h.sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
			expect(h.session.agent.state.messages).toBe(messages);
			expect(h.navigated).toHaveBeenCalledOnce();
			expect(h.session.isCompacting).toBe(false);
		} finally {
			await h.cleanup();
		}
	});

	it("cancels pending navigation when the user selects the current leaf", async () => {
		const h = await createPendingNavigations();
		try {
			const pending = h.start(h.first);
			const signal = await h.gates[0].entered.promise;
			expect(await h.start(h.current)).toEqual({ cancelled: false });
			expect(signal.aborted).toBe(true);
			h.gates[0].released.resolve();
			expect(await pending).toEqual({ cancelled: true, aborted: true });
			expect(h.sessionManager.getLeafId()).toBe(h.current);
			expect(h.navigated).not.toHaveBeenCalled();
		} finally {
			await h.cleanup();
		}
	});

	it("does not cancel valid work for a rejected target", async () => {
		const h = await createPendingNavigations();
		try {
			const pending = h.start(h.first);
			const signal = await h.gates[0].entered.promise;
			await expect(h.start("missing-entry")).rejects.toThrow("not found");
			expect(signal.aborted).toBe(false);
			expect(h.session.isCompacting).toBe(true);
			h.gates[0].released.resolve();
			expect(await pending).toMatchObject({ cancelled: false, summaryEntry: { summary: "Summary 0" } });
			expect(h.navigated).toHaveBeenCalledOnce();
		} finally {
			await h.cleanup();
		}
	});

	it("rejects a result superseded while reading extension summary fields", async () => {
		let replacement: Promise<unknown> | undefined;
		const h = await createPendingNavigations({
			beforeSummaryRead: (index) => {
				if (index === 0) replacement = h.start(h.second);
			},
		});
		try {
			const first = h.start(h.first);
			await h.gates[0].entered.promise;
			h.gates[0].released.resolve();
			const signal = await h.gates[1].entered.promise;
			expect(await first).toEqual({ cancelled: true, aborted: true });
			expect(h.sessionManager.getLeafId()).toBe(h.current);
			expect(h.session.isCompacting).toBe(true);
			expect(signal.aborted).toBe(false);
			expect(h.navigated).not.toHaveBeenCalled();
			h.gates[1].released.resolve();
			expect(await replacement).toMatchObject({
				cancelled: false,
				summaryEntry: { parentId: h.first, summary: "Summary 1" },
			});
			expect(h.navigated).toHaveBeenCalledOnce();
		} finally {
			await h.cleanup();
		}
	});

	it("rejects a persisted summary superseded by a metadata getter during serialization", async () => {
		let replacement: Promise<unknown> | undefined;
		const h = await createPendingNavigations({
			persistSession: true,
			beforeDetailsSerialize: (index) => {
				if (index === 0) replacement = h.start(h.second);
			},
		});
		try {
			h.sessionManager.appendMessage(fauxAssistantMessage("ready"));
			h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			const leaf = h.sessionManager.getLeafId();
			const file = h.sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			const before = readFileSync(file, "utf8");
			const first = h.start(h.first);
			await h.gates[0].entered.promise;
			h.gates[0].released.resolve();
			await h.gates[1].entered.promise;
			expect(await first).toEqual({ cancelled: true, aborted: true });
			expect(h.sessionManager.getLeafId()).toBe(leaf);
			expect(readFileSync(file, "utf8")).toBe(before);
			expect(h.session.isCompacting).toBe(true);
			expect(h.navigated).not.toHaveBeenCalled();
			h.gates[1].released.resolve();
			expect(await replacement).toMatchObject({
				cancelled: false,
				summaryEntry: { parentId: h.first, summary: "Summary 1" },
			});
			expect(readFileSync(file, "utf8")).toContain("Summary 1");
			expect(readFileSync(file, "utf8")).not.toContain("Summary 0");
			expect(h.navigated).toHaveBeenCalledOnce();
			expect(h.session.isCompacting).toBe(false);
		} finally {
			await h.cleanup();
		}
	});

	it("retains a navigation started reentrantly by the predecessor's abort listener", async () => {
		const h = await createPendingNavigations();
		try {
			const first = h.start(h.first);
			const firstSignal = await h.gates[0].entered.promise;
			let reentered: ReturnType<typeof h.start> | undefined;
			firstSignal.addEventListener(
				"abort",
				() => {
					reentered = h.start(h.third);
				},
				{ once: true },
			);
			const second = h.start(h.second);
			const thirdSignal = await h.gates[1].entered.promise;
			expect(reentered).toBeDefined();
			expect(await second).toEqual({ cancelled: true, aborted: true });
			h.gates[0].released.resolve();
			expect(await first).toEqual({ cancelled: true, aborted: true });
			expect(thirdSignal.aborted).toBe(false);
			expect(h.session.isCompacting).toBe(true);
			h.gates[1].released.resolve();
			const result = await reentered;
			expect(result).toMatchObject({ cancelled: false, summaryEntry: { parentId: h.second, summary: "Summary 1" } });
			expect(h.sessionManager.getLeafId()).toBe(result?.summaryEntry?.id);
			expect(h.navigated).toHaveBeenCalledOnce();
		} finally {
			await h.cleanup();
		}
	});
});

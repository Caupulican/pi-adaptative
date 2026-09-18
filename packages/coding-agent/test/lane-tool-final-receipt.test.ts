import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { describe, expect, it, vi } from "vitest";
import { LaneToolUsage } from "../src/core/autonomy/lane-tool-usage.ts";

describe("lane final-only usage receipt", () => {
	it.each(["open", "running", "returned"] as const)(
		"retains the final result through close=%s without requiring an interim callback",
		async (closeAt) => {
			for (const interim of [false, true]) {
				const record = vi.fn();
				const checkpoint = vi.fn();
				const owner = new LaneToolUsage(record);
				owner.bindCheckpoint(checkpoint);
				let release: () => void = () => {};
				const ready = new Promise<void>((resolve) => {
					release = resolve;
				});
				const usage = { ...createEmptyUsage(), input: 10, totalTokens: 10 };
				const result = { content: [], usage, details: { evidence: "retain-this-result" } };
				const pending = owner.run("call", async () => {
					if (interim) owner.report("call", { ...createEmptyUsage(), input: 4, totalTokens: 4 });
					await ready;
					return result;
				});
				if (closeAt === "running") owner.close();
				release();
				expect(await pending).toBe(result);
				if (closeAt === "returned") owner.close();
				owner.settle("call", result.usage);
				expect(record.mock.calls.map(([delta]) => delta.totalTokens)).toEqual(interim ? [4, 6] : [10]);
				expect(checkpoint).toHaveBeenCalledTimes(interim ? 2 : 1);
				owner.close();
				expect(() => owner.report("unknown", usage)).toThrow("closed");
				expect(() => owner.report("call", usage)).toThrow("closed");
			}
		},
	);

	it("keeps a returned receipt retryable when its first durable checkpoint fails", async () => {
		const record = vi.fn();
		const checkpoint = vi.fn((): void => {
			throw new Error("fixture storage failure");
		});
		const owner = new LaneToolUsage(record);
		owner.bindCheckpoint(checkpoint);
		const usage = { ...createEmptyUsage(), input: 10, totalTokens: 10 };
		const result = await owner.run("call", async () => ({ content: [], details: {}, usage }));
		owner.close();
		expect(() => owner.settle("call", result.usage)).toThrow("fixture storage failure");
		checkpoint.mockImplementation(() => undefined);
		owner.settle("call", result.usage);
		expect(record).toHaveBeenCalledOnce();
		expect(checkpoint).toHaveBeenCalledTimes(2);
	});

	it("does not reuse a returned receipt identity before settlement", async () => {
		const owner = new LaneToolUsage();
		const usage = { ...createEmptyUsage(), input: 10, totalTokens: 10 };
		const result = { content: [], details: {}, usage };
		await owner.run("call", async () => result);
		const duplicate = vi.fn(async () => result);
		await expect(owner.run("call", duplicate)).rejects.toThrow("already active");
		expect(duplicate).not.toHaveBeenCalled();
		owner.settle("call", usage);
		await expect(owner.run("call", duplicate)).resolves.toBe(result);
		owner.settle("call", usage);
	});

	it.each([false, true])("releases an invocation without a billed result: throws=%s", async (throws) => {
		const checkpoint = vi.fn();
		const owner = new LaneToolUsage();
		owner.bindCheckpoint(checkpoint);
		const result = { content: [], details: {} };
		const pending = owner.run("call", async () => {
			if (throws) throw new Error("backend failure");
			return result;
		});
		if (throws) await expect(pending).rejects.toThrow("backend failure");
		else expect(await pending).toBe(result);
		await expect(owner.run("call", async () => result)).resolves.toBe(result);
		owner.close();
		expect(() => owner.report("call", createEmptyUsage())).toThrow("closed");
		expect(checkpoint).not.toHaveBeenCalled();
	});
});

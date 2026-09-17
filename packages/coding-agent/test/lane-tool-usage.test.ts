import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { describe, expect, it, vi } from "vitest";
import { LaneToolUsage } from "../src/core/autonomy/lane-tool-usage.ts";

describe("lane tool usage owner", () => {
	it("charges cumulative service receipts once and allows a later invocation to reuse its call id", () => {
		const record = vi.fn();
		const checkpoint = vi.fn();
		const owner = new LaneToolUsage(record);
		owner.bindCheckpoint(checkpoint);
		owner.report("call", { ...createEmptyUsage(), input: 7, output: 3, totalTokens: 10 });
		owner.report("call", { ...createEmptyUsage(), input: 107, output: 13, totalTokens: 120 });
		owner.settle("call", { ...createEmptyUsage(), input: 107, output: 13, totalTokens: 120 });
		expect(record.mock.calls.map(([usage]) => usage.totalTokens)).toEqual([10, 110]);
		expect(checkpoint).toHaveBeenCalledTimes(2);
		owner.report("call", { ...createEmptyUsage(), input: 7, output: 3, totalTokens: 10 });
		owner.settle("call");
		expect(record.mock.calls.map(([usage]) => usage.totalTokens)).toEqual([10, 110, 10]);
	});

	it("rejects malformed or decreasing reports before changing the charge", () => {
		const record = vi.fn();
		const owner = new LaneToolUsage(record);
		owner.report("call", { ...createEmptyUsage(), input: 10, totalTokens: 10 });
		expect(() => owner.report("call", { ...createEmptyUsage(), input: -1, totalTokens: 10 })).toThrow();
		expect(() => owner.settle("call", { ...createEmptyUsage(), input: 9, totalTokens: 9 })).toThrow("decrease");
		owner.settle("call", { ...createEmptyUsage(), input: 10, totalTokens: 10 });
		expect(record).toHaveBeenCalledOnce();
	});

	it.each([false, true])("retries failed receipt persistence without recharging: failFirst=%s", (failFirst) => {
		const record = vi.fn();
		const owner = new LaneToolUsage(record);
		const checkpoint = vi.fn(() => {
			if (failFirst && checkpoint.mock.calls.length === 1) throw new Error("fixture checkpoint failure");
		});
		owner.bindCheckpoint(checkpoint);
		const usage = { ...createEmptyUsage(), input: 10, totalTokens: 10 };
		if (failFirst) expect(() => owner.report("call", usage)).toThrow("checkpoint failure");
		else owner.report("call", usage);
		owner.settle("call", usage);
		expect(record).toHaveBeenCalledOnce();
		expect(checkpoint).toHaveBeenCalledTimes(failFirst ? 2 : 1);
	});

	it("does not mark a receipt settled while its checkpoint still fails", () => {
		const record = vi.fn();
		const owner = new LaneToolUsage(record);
		const checkpoint = vi.fn(() => {
			throw new Error("fixture checkpoint failure");
		});
		owner.bindCheckpoint(checkpoint);
		const usage = { ...createEmptyUsage(), input: 10, totalTokens: 10 };
		expect(() => owner.report("call", usage)).toThrow("checkpoint failure");
		expect(() => owner.settle("call", usage)).toThrow("checkpoint failure");
		expect(() => owner.settle("call")).toThrow("checkpoint failure");
		expect(record).toHaveBeenCalledOnce();
		expect(checkpoint).toHaveBeenCalledTimes(3);
	});
});

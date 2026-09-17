import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type ToolExecutionObservation,
	ToolPerformanceStore,
} from "../src/core/tool-selection/tool-performance-store.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const host = { id: "fixture", cpu: "fixture", cores: 2, totalMemGb: 8 };
const key = { modelRef: "faux/model", intentClass: "read" as const, tool: "read" };
function observation(): ToolExecutionObservation {
	return {
		key: { ...key },
		success: true,
		latencyMs: 10,
		inputTokenEstimate: 2,
		outputTokenEstimate: 3,
		hintActiveAtCallTime: true,
		at: "2026-09-17T00:00:00.000Z",
		selection: {
			firstTool: true,
			disposition: "recommend",
			recommendation: "read",
			shortlist: ["read"],
			entropy: 0.1,
			margin: 0.5,
			ranked: [{ tool: "read", probability: 0.9, utility: 0.8 }],
		},
	};
}

describe("tool evidence input capture", () => {
	it("replays the admitted values once after a failed flush and another foreign write", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-evidence-retry-"));
		const writer = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
		const peer = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host });
		try {
			const input = observation();
			writer.recordExecution(input);
			input.success = false;
			input.key.modelRef = "changed/model";
			const foreign = { ...observation(), key: { ...key, modelRef: "foreign/model" } };
			peer.recordExecution(foreign);
			const rename = vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
				throw new Error("injected replay write failure");
			});
			try {
				expect(() => writer.flush()).toThrow("injected replay write failure");
			} finally {
				rename.mockRestore();
			}
			input.key.modelRef = "changed-again/model";
			input.selection.ranked[0].tool = "wrong";
			peer.recordExecution(foreign);
			writer.flush();
			writer.flush();
			expect(peer.get(key)).toMatchObject({ sampleCount: 1, failureCount: 0 });
			expect(peer.getIntentAgreement(key.modelRef, "read")).toMatchObject({ sampleCount: 1, agreementCount: 1 });
			expect(peer.getStatsForModel("changed/model")).toEqual([]);
			expect(peer.getStatsForModel("changed-again/model")).toEqual([]);
			expect(peer.get(foreign.key).sampleCount).toBe(2);
		} finally {
			writer.close();
			peer.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	for (const foreignWrite of [false, true]) {
		it.each([false, true])(`preserves execution evidence (foreign=${foreignWrite}, mutate=%s)`, (mutate) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-evidence-input-"));
			const writer = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
			const peer = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host });
			try {
				const input = observation();
				writer.recordExecution(input);
				if (mutate) {
					input.key.modelRef = "changed/model";
					input.key.intentClass = "write";
					input.key.tool = "write";
					input.success = false;
					input.latencyMs = 999;
					input.inputTokenEstimate = 999;
					input.outputTokenEstimate = 999;
					input.hintActiveAtCallTime = false;
					input.selection.firstTool = false;
					input.selection.disposition = "abstain";
					input.selection.recommendation = "write";
					input.selection.shortlist[0] = "write";
					input.selection.ranked[0].tool = "write";
					input.selection.ranked[0].utility = -9;
				}
				if (foreignWrite) peer.recordExecution({ ...observation(), key: { ...key, modelRef: "foreign/model" } });
				writer.flush();
				expect(peer.get(key)).toMatchObject({
					sampleCount: 1,
					failureCount: 0,
					latencyEwmaMs: 10,
					inputTokenEstimateEwma: 2,
					outputTokenEstimateEwma: 3,
				});
				expect(peer.getIntentAgreement(key.modelRef, "read")).toMatchObject({
					sampleCount: 1,
					agreementCount: 1,
					hintActiveSampleCount: 1,
				});
				expect(peer.getStatsForModel("changed/model")).toEqual([]);
				expect(peer.getObservations(key.modelRef)[0]).toMatchObject({
					firstTool: true,
					succeeded: true,
					disposition: "recommend",
					recommendation: "read",
					shortlist: ["read"],
					ranked: [{ tool: "read", utility: 0.8, probability: 0.9 }],
				});
				if (foreignWrite) expect(peer.getStatsForModel("foreign/model")[0].sampleCount).toBe(1);
			} finally {
				writer.close();
				peer.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("does not freeze the caller's ranking when its observation is flushed", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ranking-input-"));
		const store = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
		try {
			const input = observation();
			store.recordExecution(input);
			store.flush();
			expect(() => {
				input.selection.ranked[0].utility = 0.2;
			}).not.toThrow();
			expect(store.getObservations()[0].ranked[0].utility).toBe(0.8);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([false, true])("captures validation identity before rebase (mutate=%s)", (mutate) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-validation-input-"));
		const writer = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
		const peer = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host });
		try {
			const input = { ...key };
			writer.recordValidation(input, "repaired");
			if (mutate) input.modelRef = "changed/model";
			peer.recordValidation({ ...key, modelRef: "foreign/model" }, "bounced");
			writer.flush();
			expect(peer.get(key).repairCount).toBe(1);
			expect(peer.getStatsForModel("changed/model")).toEqual([]);
			expect(peer.get({ ...key, modelRef: "foreign/model" }).bounceCount).toBe(1);
		} finally {
			writer.close();
			peer.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists only declared selection and ranking fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-selection-fields-"));
		const store = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host });
		try {
			const input = observation();
			const extended = {
				...input,
				selection: {
					...input.selection,
					args: "fixture-private-argument",
					ranked: [{ ...input.selection.ranked[0], output: "fixture-private-output" }],
				},
			};
			store.recordExecution(extended);
			const text = readFileSync(join(dir, "state", "tool-performance.json"), "utf8");
			expect(text.includes("fixture-private-")).toBe(false);
			expect(store.get(key).sampleCount).toBe(1);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not traverse undeclared fields or candidates beyond the retained caps", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-evidence-cap-"));
		const store = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => host, writeBehind: {} });
		try {
			const input = observation();
			input.selection.ranked = Array.from({ length: 6 }, (_, index) => ({
				tool: `read_${index}`,
				utility: 0.8,
				probability: 0.1,
			}));
			input.selection.shortlist = ["read_0", "read_1", "read_2"];
			const fail = () => {
				throw new Error("unretained data was traversed");
			};
			Object.defineProperty(input.selection.ranked, "6", { get: fail });
			Object.defineProperty(input.selection.shortlist, "3", { get: fail });
			Object.defineProperty(input.selection, "args", { enumerable: true, get: fail });
			Object.defineProperty(input.selection.ranked[0], "output", { enumerable: true, get: fail });
			expect(() => store.recordExecution(input)).not.toThrow();
			store.flush();
			expect(store.getObservations()[0].ranked).toHaveLength(6);
			expect(store.getObservations()[0].shortlist).toHaveLength(3);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

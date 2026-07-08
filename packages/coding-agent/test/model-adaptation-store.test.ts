import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ModelAdaptationRule, ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import type { HostFingerprint } from "../src/core/models/fitness-store.ts";

const hostA: HostFingerprint = { id: "host-a", cpu: "cpu-a", cores: 8, totalMemGb: 32 };
const hostB: HostFingerprint = { id: "host-b", cpu: "cpu-b", cores: 4, totalMemGb: 16 };

function tempAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-adaptation-store-"));
}

function store(agentDir: string, host: HostFingerprint = hostA): ModelAdaptationStore {
	return ModelAdaptationStore.forAgentDir(agentDir, { fingerprint: () => host });
}

function at(day: number): string {
	return new Date(Date.UTC(2026, 0, day)).toISOString();
}

function rule(index: number, lastFiredAt = at(index)): ModelAdaptationRule {
	return { mode: `mode-${index}`, text: `rule ${index}`, addedAt: at(index), lastFiredAt };
}

describe("ModelAdaptationStore", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips profiles under the agent state directory", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		const adaptation = store(agentDir);

		adaptation.save("provider/model", {
			rules: [rule(1)],
			protocol: { version: 1, variant: "pi-call", calibratedAt: at(2) },
			teachStats: { mode: { taught: 2, recurrenceBefore: 3, recurrenceAfter: 1 } },
		});

		expect(store(agentDir).get("provider/model", new Date(at(3)))).toEqual({
			rules: [rule(1)],
			protocol: { version: 1, variant: "pi-call", calibratedAt: at(2) },
			teachStats: { mode: { taught: 2, recurrenceBefore: 3, recurrenceAfter: 1 } },
		});
	});

	it("round-trips perf profiles as host-keyed model adaptation data", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		const adaptation = store(agentDir);

		adaptation.recordPerfSample(
			"provider/model",
			{
				promptTokens: 1_000,
				completionTokens: 100,
				headersToFirstTokenMs: 2_000,
				firstTokenToDoneMs: 1_000,
			},
			at(2),
		);

		expect(store(agentDir).get("provider/model", new Date(at(3))).perf).toEqual({
			prefillTokensPerSecond: 500,
			decodeTokensPerSecond: 100,
			samples: 1,
			updatedAt: at(2),
		});
	});

	it("round-trips failed protocol calibration records and removes protocol status", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		const adaptation = store(agentDir);

		adaptation.setProtocol("provider/model", {
			version: 1,
			status: "failed",
			attemptedAt: at(2),
			variantsTried: ["tool-tag", "tool-call", "fenced-json"],
		});

		expect(store(agentDir).get("provider/model", new Date(at(3))).protocol).toEqual({
			version: 1,
			status: "failed",
			attemptedAt: at(2),
			variantsTried: ["tool-tag", "tool-call", "fenced-json"],
		});
		expect(adaptation.removeProtocol("provider/model")).toBe(true);
		expect(store(agentDir).get("provider/model", new Date(at(3))).protocol).toBeUndefined();
	});

	it("enforces the five-rule cap by dropping the oldest last-fired rule", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		const adaptation = store(agentDir);

		for (let index = 1; index <= 6; index++) {
			adaptation.addRule("model", rule(index), new Date(at(10)));
		}

		expect(
			adaptation
				.get("model", new Date(at(10)))
				.rules.map((entry) => entry.mode)
				.sort(),
		).toEqual(["mode-2", "mode-3", "mode-4", "mode-5", "mode-6"]);
	});

	it("prunes rules with thirty days of firing silence on load", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		const adaptation = store(agentDir);
		adaptation.save("model", { rules: [rule(1), rule(20)], teachStats: {} });

		expect(adaptation.get("model", new Date(Date.UTC(2026, 1, 5))).rules).toEqual([rule(20)]);
		expect(store(agentDir).get("model", new Date(Date.UTC(2026, 1, 5))).rules).toEqual([rule(20)]);
	});

	it("keeps host-keyed profiles separate using fitness-store semantics", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		store(agentDir, hostA).addRule("model", { mode: "mode-a", text: "A" }, new Date(at(1)));
		store(agentDir, hostB).addRule("model", { mode: "mode-b", text: "B" }, new Date(at(1)));

		expect(
			store(agentDir, hostA)
				.get("model", new Date(at(1)))
				.rules.map((entry) => entry.mode),
		).toEqual(["mode-a"]);
		expect(
			store(agentDir, hostB)
				.get("model", new Date(at(1)))
				.rules.map((entry) => entry.mode),
		).toEqual(["mode-b"]);
	});

	it("returns clean defaults for missing or corrupt files", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		expect(store(agentDir).get("missing")).toEqual({ rules: [], teachStats: {} });

		mkdirSync(join(agentDir, "state"), { recursive: true });
		writeFileSync(join(agentDir, "state", "model-adaptation.json"), "not json", "utf-8");
		expect(store(agentDir).get("missing")).toEqual({ rules: [], teachStats: {} });
	});

	it("preserves concurrent writes by loading the latest file on each save", () => {
		const agentDir = tempAgentDir();
		dirs.push(agentDir);
		const first = store(agentDir);
		const second = store(agentDir);

		first.addRule("model-a", { mode: "mode-a", text: "A" }, new Date(at(1)));
		second.addRule("model-b", { mode: "mode-b", text: "B" }, new Date(at(1)));

		expect(
			store(agentDir)
				.getForHost()
				.map((entry) => entry.model)
				.sort(),
		).toEqual(["model-a", "model-b"]);
	});
});

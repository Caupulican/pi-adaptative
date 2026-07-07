import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { formatToolRepairHealthReport } from "../src/core/tool-repair-health.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-repair-health-"));
	dirs.push(dir);
	return dir;
}

describe("tool repair health", () => {
	it("renders persisted rules, protocol calibration, and teach stats", () => {
		const store = ModelAdaptationStore.forAgentDir(tempAgentDir(), {
			fingerprint: () => ({ id: "host", cpu: "cpu", cores: 8, totalMemGb: 32 }),
		});
		store.save("provider/model", {
			rules: [
				{
					mode: "numberFromString",
					text: "Send bare numbers.",
					addedAt: "2026-07-01T00:00:00.000Z",
					lastFiredAt: "2026-07-06T00:00:00.000Z",
				},
			],
			protocol: { version: 1, variant: "pi-call", calibratedAt: "2026-07-05T00:00:00.000Z" },
			teachStats: { numberFromString: { taught: 3, recurrenceBefore: 4, recurrenceAfter: 1 } },
		});

		const report = formatToolRepairHealthReport(store, new Date("2026-07-07T00:00:00.000Z"));

		expect(report).toContain("provider/model");
		expect(report).toContain("numberFromString");
		expect(report).toContain("Send bare numbers.");
		expect(report).toContain("protocol: v1 pi-call");
		expect(report).toContain("taught=3 before=4 after=1");
	});

	it("removes a standing rule from persistent storage", () => {
		const agentDir = tempAgentDir();
		const store = ModelAdaptationStore.forAgentDir(agentDir, {
			fingerprint: () => ({ id: "host", cpu: "cpu", cores: 8, totalMemGb: 32 }),
		});
		store.addRule("provider/model", { mode: "numberFromString", text: "Send bare numbers." });
		store.addRule("provider/model", { mode: "jsonStringParse", text: "Send raw arrays." });

		expect(store.removeRule("provider/model", "numberFromString")).toBe(true);
		expect(
			ModelAdaptationStore.forAgentDir(agentDir, {
				fingerprint: () => ({ id: "host", cpu: "cpu", cores: 8, totalMemGb: 32 }),
			})
				.get("provider/model")
				.rules.map((rule) => rule.mode),
		).toEqual(["jsonStringParse"]);
	});
});

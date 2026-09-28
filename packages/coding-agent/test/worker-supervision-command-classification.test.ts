import { describe, expect, it } from "vitest";
import { isValidationChurn } from "../src/core/supervision/worker-supervision-coordinator.ts";

describe("worker validation churn classification", () => {
	it("does not treat three distinct shell discovery commands as repeated implementation validation", () => {
		const observation = {
			recentToolNames: ["bash", "bash", "bash"],
			recentToolCalls: [
				{ name: "bash", args: { command: "rg -n GrimDex /home/caudev/.codex/sessions" } },
				{ name: "bash", args: { command: "ssh -o BatchMode=yes work pwd" } },
				{ name: "bash", args: { command: "find /mnt/d/GitHub -maxdepth 4 -type d -name GrimDex" } },
			],
			changedFileCountAtWindowStart: 0,
			changedFileCount: 0,
		};

		expect(isValidationChurn(observation as never)).toBe(false);
	});

	it("still detects repeated test and diagnostics commands without implementation progress", () => {
		const observation = {
			recentToolNames: ["bash", "bash", "bash"],
			recentToolCalls: [
				{ name: "bash", args: { command: "cargo test -p grimdex focused_case" } },
				{ name: "bash", args: { command: "npm run check" } },
				{ name: "bash", args: { command: "npx vitest run test/shorts.test.ts" } },
			],
			changedFileCountAtWindowStart: 2,
			changedFileCount: 2,
		};

		expect(isValidationChurn(observation as never)).toBe(true);
	});
});

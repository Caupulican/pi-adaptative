import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TestVerificationOutput, type VerificationRunner } from "../src/core/tools/test-verification-output.ts";

const nodeSummary =
	"# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n";

describe("runner-neutral verification lifecycle", () => {
	it.each(["tap", "spec"])("accepts a real local Node %s terminal with skipped/todo controls", (reporter) => {
		const result = spawnSync(
			process.execPath,
			[
				"--test",
				`--test-reporter=${reporter}`,
				fileURLToPath(new URL("./fixtures/node-runner.fixture.mjs", import.meta.url)),
			],
			{ timeout: 10_000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const observer = new TestVerificationOutput(["node-test"]);
		for (const byte of result.stdout) observer.append(Uint8Array.of(byte));
		expect(observer.finish(result.status)).toBe("passed");
		expect(observer.executionOutcome).toBe("executed");
	});
	it.each([
		[nodeSummary, "unconfirmed"],
		[`${nodeSummary}Tests 1 passed (1)\n`, "passed"],
		[`${nodeSummary}No test files found, exiting with code 0\n`, "no_tests"],
		[`${nodeSummary}Tests 1 failed (1)\n`, "failed"],
	] as const)("requires every declared runner stage: %s", (output, expected) => {
		const observer = new TestVerificationOutput(["node-test", "vitest"]);
		observer.append(Buffer.from(output));
		expect(observer.finish(0)).toBe(expected);
		expect(observer.executionOutcome).toBe("executed");
	});
	it.each(["", "  ", "quoted: "])("rejects missing and nested summary evidence (%j)", (prefix) => {
		const observer = new TestVerificationOutput(["node-test"]);
		observer.append(
			Buffer.from(
				prefix
					? nodeSummary
							.split("\n")
							.map((line) => prefix + line)
							.join("\n")
					: "",
			),
		);
		expect(observer.finish(0)).toBe("unconfirmed");
	});
	it.each([Buffer.from([0xff]), Buffer.from("x".repeat(20_000))])("rejects incomplete raw streams", (data) => {
		const observer = new TestVerificationOutput(["node-test"]);
		observer.append(data);
		observer.append(Buffer.from(`\n${nodeSummary}`));
		expect(observer.finish(0)).toBe("unconfirmed");
		expect(observer.finish(0)).toBe("unconfirmed");
		expect(observer.executionOutcome).toBe("unconfirmed");
		expect(() => observer.append(Buffer.from("late"))).toThrow();
	});
	it("distinguishes opaque command success from witnessed tests", () => {
		const command = new TestVerificationOutput(["command"]);
		command.append(Buffer.from("x".repeat(100_000)));
		expect(command.finish(0)).toBe("passed");
		expect(command.evidence).toBe("command");
		const mixed = new TestVerificationOutput(["command", "node-test"]);
		mixed.append(Buffer.from(nodeSummary));
		expect(mixed.finish(0)).toBe("passed");
		expect(mixed.evidence).toBe("command");
	});
	it("does not saturate summary counts into a false exact match", () => {
		const observer = new TestVerificationOutput(Array.from({ length: 1_000 }, () => "vitest"));
		observer.append(Buffer.from("Tests 1 passed (1)\n".repeat(1_001)));
		expect(observer.finish(0)).toBe("unconfirmed");
	});
	it("rejects invalid stage declarations instead of silently certifying them", () => {
		for (const runners of [[], ["unknown"], Array.from({ length: 1_001 }, () => "vitest")]) {
			expect(() => new TestVerificationOutput(runners as VerificationRunner[])).toThrow();
		}
	});
});

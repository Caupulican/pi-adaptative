import { describe, expect, it } from "vitest";
import { TestVerificationOutput } from "../src/core/tools/test-verification-output.ts";

describe("Vitest verification output", () => {
	it.each([
		["No test files found, exiting with code 1", 1, "setup_failed"],
		["Tests no tests", 1, "setup_failed"],
		["Tests 2 skipped (2)", 1, "unconfirmed"],
		["Tests 1 failed (1)", 1, "executed"],
		["Tests 1 passed (1)", 1, "executed"],
		["Tests 1 passed (1)\nNo test files found, exiting with code 1", 2, "executed"],
		["No test files found, exiting with code 1", 2, "unconfirmed"],
		["Test Files 1 failed (1)\nTests no tests", 1, "unconfirmed"],
		["Tests 1 passed (2)\nTests no tests", 1, "unconfirmed"],
		[`No test files found, exiting with code 1\n${"x".repeat(20_000)}`, 1, "unconfirmed"],
	] as const)(
		"separates repairable setup from executed and unconfirmed checks, case %#",
		(output, stages, expected) => {
			const observer = new TestVerificationOutput(Array.from({ length: stages }, () => "vitest"));
			observer.append(Buffer.from(output));
			expect(observer.executionOutcome).toBe("unconfirmed");
			observer.finish(1);
			expect(observer.executionOutcome).toBe(expected);
		},
	);

	it.each([
		["Tests 2 passed (2)", "passed"],
		["Tests 1 passed | 1 skipped (2)", "passed"],
		["Tests 1 failed | 2 passed (3)", "failed"],
		["Test Files 1 failed | 1 passed (2)\nTests 1 passed (1)", "failed"],
		["Tests 1 passed (1)\nErrors 1 error", "failed"],
		["Tests 2 skipped | 1 todo (3)", "no_tests"],
		["Tests no tests", "no_tests"],
		["No test files found, exiting with code 0", "no_tests"],
		["Tests 2 passed (3)", "unconfirmed"],
		["Tests 1 passed | 1 passed (2)", "unconfirmed"],
		["Tests 9007199254740992 passed (9007199254740992)", "unconfirmed"],
		["test name mentions Tests 1 passed (1)", "unconfirmed"],
		["Test Files 1 passed (1)", "unconfirmed"],
	] as const)("interprets only complete summary evidence: %s", (output, expected) => {
		const observer = new TestVerificationOutput(["vitest"]);
		const bytes = Buffer.from(`\u001b[32m${output}\u001b[0m`);
		for (const byte of bytes) observer.append(Uint8Array.of(byte));
		expect(observer.finish(0)).toBe(expected);
		expect(observer.finish(0)).toBe(expected);
	});

	it("requires every declared stage and preserves an empty stage beside a successful one", () => {
		const incomplete = new TestVerificationOutput(["vitest", "vitest"]);
		incomplete.append(Buffer.from("Tests 1 passed (1)\n"));
		expect(incomplete.finish(0)).toBe("unconfirmed");
		const complete = new TestVerificationOutput(["vitest", "vitest"]);
		complete.append(Buffer.from("Tests 1 passed (1)\nTests 2 passed (2)\n"));
		expect(complete.finish(0)).toBe("passed");
		const empty = new TestVerificationOutput(["vitest", "vitest"]);
		empty.append(Buffer.from("Tests 1 passed (1)\nNo test files found, exiting with code 0\n"));
		expect(empty.finish(0)).toBe("no_tests");
	});

	it.each(["No test files found, exiting with code 0", "Tests no tests"])(
		"does not mistake a test's quoted diagnostic for an empty run: %s",
		(notice) => {
			const observer = new TestVerificationOutput(["vitest"]);
			observer.append(
				Buffer.from(
					`stdout | parser.test.ts > reproduces a missing-file diagnostic\n${notice}\nTests 1 passed (1)\n`,
				),
			);
			expect(observer.finish(0)).toBe("passed");
		},
	);

	it.each([1, null])("does not certify a completed summary with exit %s", (exitCode) => {
		const observer = new TestVerificationOutput(["vitest"]);
		observer.append(Buffer.from("Tests 1 passed (1)\n"));
		expect(observer.finish(exitCode)).toBe("failed");
	});

	it("fails closed on oversized or invalid text and rejects output after completion", () => {
		for (const data of [Buffer.from("x".repeat(20_000)), Buffer.from([0xff])]) {
			const observer = new TestVerificationOutput(["vitest"]);
			observer.append(data);
			observer.append(Buffer.from("\nTests 1 passed (1)\n"));
			expect(observer.finish(0)).toBe("unconfirmed");
			expect(() => observer.append(Buffer.from("late"))).toThrow("after verification output completes");
		}
	});
});

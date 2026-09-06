import { describe, expect, it } from "vitest";
import { isPassingTestVerification, retainedVerificationDetails } from "../src/verification-obligations.ts";

describe("verification evidence strength", () => {
	it.each([undefined, "command", "tests", "unknown"])(
		"preserves validated evidence without upgrading missing proof (%s)",
		(evidence) => {
			const piVerification = { version: 1, id: "fixture-check", status: "passed", outcome: "executed", evidence };
			const retained = retainedVerificationDetails({ piVerification });
			if (evidence === "unknown") expect(retained).toBeUndefined();
			else expect(retained?.piVerification.evidence).toBe(evidence);
			expect(isPassingTestVerification(retained?.piVerification)).toBe(evidence === "tests");
		},
	);
	it.each([undefined, "setup_failed", "unconfirmed"])("never upgrades incomplete execution (%s)", (outcome) => {
		const retained = retainedVerificationDetails({
			piVerification: { version: 1, id: "fixture-check", status: "passed", outcome, evidence: "tests" },
		});
		expect(isPassingTestVerification(retained?.piVerification)).toBe(false);
	});
	it("does not execute an evidence accessor", () => {
		const record = { version: 1, id: "fixture-check", status: "passed", outcome: "executed" };
		Object.defineProperty(record, "evidence", {
			get: () => {
				throw new Error("untrusted accessor");
			},
		});
		expect(isPassingTestVerification(retainedVerificationDetails({ piVerification: record })?.piVerification)).toBe(
			false,
		);
	});
});

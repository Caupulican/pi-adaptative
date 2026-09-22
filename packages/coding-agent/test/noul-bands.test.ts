import { describe, expect, test } from "vitest";
import { settledBoolean } from "../src/core/decision/evaluation.ts";
import { noulBand, settledFromBand } from "../src/core/decision/noul.ts";
import { noulHolds, noulHoldsDecisively, settledNoul } from "../src/core/system-one/policy.ts";

describe("noul bands", () => {
	test("a required-true question reads the high end", () => {
		expect(noulBand(0.96, "required_true")).toBe("hard_pass");
		expect(noulBand(0.88, "required_true")).toBe("soft_pass");
		expect(noulBand(0.5, "required_true")).toBe("ambiguous");
		expect(noulBand(0.04, "required_true")).toBe("hard_fail");
	});

	test("a required-false question reads the same number from the other end", () => {
		expect(noulBand(0.04, "required_false")).toBe("hard_pass");
		expect(noulBand(0.12, "required_false")).toBe("soft_pass");
		expect(noulBand(0.5, "required_false")).toBe("ambiguous");
		expect(noulBand(0.9, "required_false")).toBe("hard_fail");
	});

	test("0.5 settles nothing in either direction", () => {
		expect(settledNoul(0.5, "required_true", false)).toBeUndefined();
		expect(settledNoul(0.5, "required_false", true)).toBeUndefined();
		expect(noulHolds(0.5, "required_true")).toBe(false);
		// The old cutoff: 0.51 was a yes and 0.49 a no. Neither is now.
		expect(settledNoul(0.51, "required_true", false)).toBeUndefined();
		expect(settledNoul(0.49, "required_true", false)).toBeUndefined();
	});

	test("a soft pass continues the step but is not decisive", () => {
		expect(noulHolds(0.88, "required_true")).toBe(true);
		expect(noulHoldsDecisively(0.88, "required_true")).toBe(false);
		expect(noulHoldsDecisively(0.96, "required_true")).toBe(true);
	});

	test("a confident no on a required-false question is a pass, not a failure", () => {
		expect(settledNoul(0.02, "required_false", true)).toBe(false);
		expect(noulHolds(0.02, "required_false")).toBe(false);
		expect(settledNoul(0.95, "required_false", true)).toBe(true);
	});

	test("an unrecognised band decides nothing rather than falling through to yes", () => {
		expect(settledFromBand("nonsense" as never, "required_true")).toBeUndefined();
		expect(settledFromBand("nonsense" as never, "required_false")).toBeUndefined();
	});

	test("a result carries its own direction into the settled answer", () => {
		const confidence = { value: 0.9, provenance: "native_calibrated" as const, isCalibrated: true };
		expect(
			settledBoolean({
				kind: "boolean",
				probabilityTrue: 0.02,
				direction: "required_false",
				band: "hard_pass",
				confidence,
			}),
		).toBe(false);
		expect(
			settledBoolean({
				kind: "boolean",
				probabilityTrue: 0.55,
				direction: "required_true",
				band: "ambiguous",
				confidence,
			}),
		).toBeUndefined();
	});
});

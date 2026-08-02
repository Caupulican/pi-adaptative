import { describe, expect, it } from "vitest";
import { boundedTextPreview } from "../src/core/text-preview.ts";

describe("boundedTextPreview", () => {
	it("compacts whitespace and applies one exact character bound", () => {
		const preview = boundedTextPreview("  alpha\n\t beta  ", 8);

		expect(preview).toBe("alpha b…");
		expect(preview).toHaveLength(8);
	});

	it("preserves compact text that already fits", () => {
		expect(boundedTextPreview("  alpha\n\t beta  ", 10)).toBe("alpha beta");
	});

	it("keeps zero and one-character limits bounded", () => {
		expect(boundedTextPreview("alpha", 0)).toBe("");
		expect(boundedTextPreview("alpha", 1)).toBe("…");
	});

	it("matches the established positive-limit rule across whitespace and Unicode boundaries", () => {
		const samples = ["", "   ", "a", "a  b", "\talpha\r\nbeta\u00a0gamma ", "😀alpha", "alpha😀omega"];
		for (const sample of samples) {
			for (const limit of [1, 2, 3, 8, 220]) {
				const compact = sample.replace(/\s+/g, " ").trim();
				const expected = compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
				const preview = boundedTextPreview(sample, limit);

				expect(preview).toBe(expected);
				expect(preview.length).toBeLessThanOrEqual(limit);
			}
		}
	});
});

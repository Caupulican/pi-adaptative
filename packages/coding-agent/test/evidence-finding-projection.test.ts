import { describe, expect, it } from "vitest";
import { normalizeEvidenceFinding, projectEvidenceFindings } from "../src/core/autonomy/evidence-finding-projection.ts";

describe("normalizeEvidenceFinding", () => {
	it("trims summaries once and clamps finite confidence", () => {
		expect(normalizeEvidenceFinding({ summary: "  concrete finding  ", confidence: 7 })).toEqual({
			summary: "concrete finding",
			confidence: 1,
		});
		expect(normalizeEvidenceFinding({ summary: "low", confidence: -4 })).toEqual({
			summary: "low",
			confidence: 0,
		});
		expect(normalizeEvidenceFinding({ summary: "unknown", confidence: Number.NaN })).toEqual({
			summary: "unknown",
			confidence: undefined,
		});
	});

	it("applies a caller-specific summary bound without changing the unbounded path", () => {
		const item = { summary: `  ${"x".repeat(12)}  ` };
		expect(normalizeEvidenceFinding(item, 5)?.summary).toBe("xxxxx");
		expect(normalizeEvidenceFinding(item)?.summary).toBe("x".repeat(12));
	});

	it("rejects malformed finding candidates", () => {
		for (const candidate of [null, [], {}, { summary: 42 }, { summary: "   " }]) {
			expect(normalizeEvidenceFinding(candidate)).toBeUndefined();
		}
	});
});

describe("projectEvidenceFindings", () => {
	it("numbers findings, binds one evidence source, preserves confidence, and honors the cap", () => {
		const findings = projectEvidenceFindings(
			[
				{ summary: "first", confidence: 0.75 },
				{ summary: "second", confidence: undefined },
			],
			"src-synthesis",
			2,
		);

		expect(findings).toEqual([
			{
				id: "finding-1",
				summary: "first",
				evidenceIds: ["src-synthesis"],
				confidence: 0.75,
			},
			{ id: "finding-2", summary: "second", evidenceIds: ["src-synthesis"] },
		]);
		expect(projectEvidenceFindings(findings, "src-other", 1)).toEqual([
			{ id: "finding-1", summary: "first", evidenceIds: ["src-other"], confidence: 0.75 },
		]);
	});
});

import { describe, expect, it } from "vitest";
import {
	defaultMemoryPromptInclusionReport,
	sanitizeMemoryRetrievalReportForDiagnostics,
} from "../src/core/context/memory-diagnostics.ts";
import type { MemoryRetrievalReport } from "../src/core/context/memory-retrieval.ts";

const SECRET_MARKER = "SECRET-XYZ-9f3a1c";

function secretLadenReport(): MemoryRetrievalReport {
	return {
		request: { query: `find ${SECRET_MARKER} please`, maxResults: 5 },
		providerReports: [
			{
				providerId: "pi-okf",
				status: "failed",
				rejectionReasons: [],
				resultCount: 0,
				error: `ENOENT: no such file or directory, scandir '/home/user/.pi/agent/okf-memory/${SECRET_MARKER}'`,
			},
		],
		results: [
			{
				item: {
					id: "mem-1",
					providerId: "pi-okf",
					source: "pi_native",
					kind: "fact",
					scope: "project",
					durability: "durable",
					title: `Title with ${SECRET_MARKER}`,
					summary: `Summary with ${SECRET_MARKER}`,
					content: `Full body with ${SECRET_MARKER}`,
					refs: [],
					evidenceRefs: [],
				},
				score: 1,
				reason: `local OKF match score 1.000 for ${SECRET_MARKER}`,
			},
		],
		contextItems: [
			{
				id: `memory:pi-okf:${SECRET_MARKER}`,
				kind: "memory_item",
				retentionClass: "useful",
				source: "memory",
				createdAtTurn: 0,
				summary: `[pi-okf/project/fact] Summary with ${SECRET_MARKER}`,
				tokenEstimate: 10,
				byteEstimate: 40,
			},
		],
	};
}

describe("defaultMemoryPromptInclusionReport", () => {
	it("returns the documented disabled default", () => {
		expect(defaultMemoryPromptInclusionReport()).toEqual({
			status: "disabled",
			enabled: false,
			includeInPrompt: false,
			selectedItemCount: 0,
			includedCount: 0,
			omittedCount: 0,
			blockChars: 0,
		});
	});
});

describe("sanitizeMemoryRetrievalReportForDiagnostics", () => {
	it("never leaks query/title/summary/content/error text, even when every one of them carries a marker", () => {
		const output = sanitizeMemoryRetrievalReportForDiagnostics(secretLadenReport(), {
			enabled: true,
			maxResults: 5,
		});

		expect(JSON.stringify(output)).not.toContain(SECRET_MARKER);
	});

	it("projects only the allow-listed fields", () => {
		const output = sanitizeMemoryRetrievalReportForDiagnostics(secretLadenReport(), {
			enabled: true,
			maxResults: 5,
		});

		expect(output).toEqual({
			enabled: true,
			maxResults: 5,
			providerReports: [
				{
					providerId: "pi-okf",
					status: "failed",
					rejectionReasons: [],
					resultCount: 0,
				},
			],
			selectedItemCount: 1,
		});
	});

	it("drops providerReports[].error even when present, without any redacted substitute", () => {
		const output = sanitizeMemoryRetrievalReportForDiagnostics(secretLadenReport(), {
			enabled: true,
			maxResults: 5,
		});

		expect(output.providerReports[0]).not.toHaveProperty("error");
	});

	it("does not surface a new, unknown content-bearing field added to the input report (allow-list, not deny-list)", () => {
		const report = secretLadenReport();
		// Simulate a hypothetical future field nobody has told the sanitizer about yet.
		const reportWithFutureField = {
			...report,
			providerReports: [
				{
					...report.providerReports[0],
					futureRawContentField: `leaked ${SECRET_MARKER}`,
				} as unknown as MemoryRetrievalReport["providerReports"][number],
			],
		};

		const output = sanitizeMemoryRetrievalReportForDiagnostics(reportWithFutureField, {
			enabled: true,
			maxResults: 5,
		});

		expect(JSON.stringify(output)).not.toContain(SECRET_MARKER);
		expect(output.providerReports[0]).not.toHaveProperty("futureRawContentField");
	});

	it("preserves rejectionReasons (closed enum codes) and resultCount faithfully", () => {
		const report: MemoryRetrievalReport = {
			request: { query: "", maxResults: 5 },
			providerReports: [
				{
					providerId: "pi-okf",
					status: "blocked",
					rejectionReasons: ["provider_disabled", "policy_scope_blocked"],
					resultCount: 0,
				},
			],
			results: [],
			contextItems: [],
		};

		const output = sanitizeMemoryRetrievalReportForDiagnostics(report, { enabled: false, maxResults: 5 });

		expect(output.providerReports[0]?.rejectionReasons).toEqual(["provider_disabled", "policy_scope_blocked"]);
		expect(output.selectedItemCount).toBe(0);
	});

	it("reflects settings.enabled/maxResults as given, independent of the report contents", () => {
		const output = sanitizeMemoryRetrievalReportForDiagnostics(secretLadenReport(), {
			enabled: false,
			maxResults: 12,
		});

		expect(output.enabled).toBe(false);
		expect(output.maxResults).toBe(12);
	});
});

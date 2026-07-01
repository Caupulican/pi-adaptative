/**
 * Safe observability for the local-memory retrieval / prompt-inclusion path, surfaced
 * through the existing context_audit tool. Purely additive diagnostics: no change to
 * memory retrieval, prompt injection, settings, active tools, or the system prompt (R1).
 * The central property under test is non-leakage (R3/R11/R12): context_audit must be able
 * to answer "is memory retrieval on, and did it get surfaced to the prompt" using only
 * fixed-vocabulary metadata, never any OKF content, query text, or filesystem path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRetrievalReport } from "../../src/core/context/memory-retrieval.ts";
import { formatOkfMemoryDocument } from "../../src/core/context/okf-memory.ts";
import { createHarness, type Harness } from "./harness.ts";

const SECRET_MARKER = "SECRET-XYZ-9f3a1c";

function okfDocument(title: string, description: string, body: string): string {
	return formatOkfMemoryDocument({
		type: "Design Decision",
		title,
		description,
		scope: "project",
		body,
		evidenceRefs: ["transcript:accepted-review"],
		timestamp: "2026-06-30T00:00:00Z",
	});
}

function memoryDir(harness: Harness): string {
	return join(harness.tempDir, "okf-memory");
}

function writeOkfFile(harness: Harness, filename: string, content: string): void {
	mkdirSync(memoryDir(harness), { recursive: true });
	writeFileSync(join(memoryDir(harness), filename), content, "utf8");
}

interface AuditToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
}

function lastToolResult(harness: Harness): AuditToolResultLike | undefined {
	const message = [...harness.session.messages]
		.reverse()
		.find((candidate): candidate is Extract<AgentMessage, { role: "toolResult" }> => candidate.role === "toolResult");
	return message as unknown as AuditToolResultLike | undefined;
}

function auditText(result: AuditToolResultLike | undefined): string {
	return result?.content.find((part) => part.type === "text")?.text ?? "";
}

async function runContextAudit(harness: Harness, params: Record<string, unknown> = {}): Promise<AuditToolResultLike> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("context_audit", params)], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("audit the context please");
	const result = lastToolResult(harness);
	if (!result) throw new Error("expected a context_audit toolResult");
	return result;
}

describe("context_audit: safe local-memory diagnostics (no leakage, read-only)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("R14: before any turn and with memory disabled, reports 'disabled' with no OKF directory access/creation", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
		});
		harnesses.push(harness);
		expect(existsSync(memoryDir(harness))).toBe(false);

		expect(harness.session.getMemoryPromptInclusionReport().status).toBe("disabled");

		const result = await runContextAudit(harness);

		expect(existsSync(memoryDir(harness))).toBe(false);
		expect(auditText(result)).toContain("Memory retrieval: disabled");
		expect(auditText(result)).toContain("Prompt inclusion: disabled");
		expect((result.details?.memory as { retrieval?: { enabled?: boolean } })?.retrieval?.enabled).toBe(false);
	});

	it("R13: include_disabled -- retrieval enabled, includeInPrompt false/unset", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(harness, "note.okf.md", okfDocument("Widget rollout", "Notes on widgets.", "Body about widgets."));

		await harness.session.prompt("tell me about widgets");
		const result = await runContextAudit(harness);

		expect(harness.session.getMemoryPromptInclusionReport().status).toBe("include_disabled");
		expect(auditText(result)).toContain("Prompt inclusion: include_disabled");
	});

	it("R13: no_results -- retrieval + includeInPrompt on, but nothing matched", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			settings: { contextPolicy: { memory: { enabled: true, includeInPrompt: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		// No OKF directory/files at all -- retrieval runs but finds nothing.

		await harness.session.prompt("tell me about something with no matching memory");
		const result = await runContextAudit(harness);

		expect(harness.session.getMemoryPromptInclusionReport().status).toBe("no_results");
		expect(auditText(result)).toContain("Prompt inclusion: no_results");
	});

	it("R13: included -- retrieval + includeInPrompt on, a real match", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			settings: { contextPolicy: { memory: { enabled: true, includeInPrompt: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument("Widget rollout plan", "Design decision about the widget rollout plan.", "Body."),
		);

		await harness.session.prompt("what was the widget rollout plan?");
		const result = await runContextAudit(harness);

		expect(harness.session.getMemoryPromptInclusionReport().status).toBe("included");
		expect(auditText(result)).toContain("Prompt inclusion: included");
		expect(auditText(result)).toMatch(/Prompt inclusion: included \(1 included, 0 omitted, \d+ chars\)/);
		expect(auditText(result)).toContain("Memory retrieval: enabled (max 5 results)");
		expect(auditText(result)).toContain("provider pi-okf: queried (1 result(s))");
	});

	it("R13/R14 (test-only): empty_block and failed are reachable and correctly recorded, even though real OKF documents cannot produce them", async () => {
		// Real OKF documents always yield a non-empty "[provider/scope/kind] <description>"
		// summary (parseOkfMemoryDocument requires a non-empty description), so
		// buildMemoryPromptBlock's "all summaries empty" branch, and the outer catch, are
		// structurally unreachable via any real product path. Invoking the private method
		// directly here (narrow, test-only, flagged to PM) is the only way to prove these
		// two status codes are still recorded correctly if the invariant above is ever
		// violated by a future change.
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			settings: { contextPolicy: { memory: { enabled: true, includeInPrompt: true, maxResults: 5 } } },
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as {
			_maybeAppendMemoryEvidenceBlock: (messages: AgentMessage[], report: MemoryRetrievalReport) => AgentMessage[];
		};

		const emptySummaryReport: MemoryRetrievalReport = {
			request: { query: "x", maxResults: 5 },
			providerReports: [],
			results: [],
			contextItems: [
				{
					id: "memory:pi-okf:synthetic",
					kind: "memory_item",
					retentionClass: "useful",
					source: "memory",
					createdAtTurn: 0,
					summary: "   ",
					tokenEstimate: 1,
					byteEstimate: 1,
				},
			],
		};
		internals._maybeAppendMemoryEvidenceBlock([], emptySummaryReport);
		expect(harness.session.getMemoryPromptInclusionReport().status).toBe("empty_block");

		const throwingReport = {
			request: { query: "x", maxResults: 5 },
			providerReports: [],
			results: [],
			get contextItems(): never {
				throw new Error("boom");
			},
		} as unknown as MemoryRetrievalReport;
		internals._maybeAppendMemoryEvidenceBlock([], throwingReport);
		expect(harness.session.getMemoryPromptInclusionReport().status).toBe("failed");
	});

	it("R11/R12/R6: a distinctive secret in the OKF description/body never appears in context_audit text or details (new memory section AND the pre-existing rows/preview surface)", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			settings: { contextPolicy: { memory: { enabled: true, includeInPrompt: false, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument(
				"Widget rollout plan",
				`Design decision ${SECRET_MARKER} about widgets.`,
				`Body ${SECRET_MARKER}.`,
			),
		);

		await harness.session.prompt(`what was the widget rollout plan?`);
		expect(harness.session.getMemoryRetrievalReport().contextItems.length).toBeGreaterThan(0); // non-vacuous

		const result = await runContextAudit(harness, { includePreviews: true, maxItems: 50 });

		expect(auditText(result)).not.toContain(SECRET_MARKER);
		expect(JSON.stringify(result.details ?? {})).not.toContain(SECRET_MARKER);
	});

	it("R11/R6: secret stays absent from context_audit even with includeInPrompt=true (this diagnostic stays metadata-only)", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			settings: { contextPolicy: { memory: { enabled: true, includeInPrompt: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument(
				"Widget rollout plan",
				`Design decision ${SECRET_MARKER} about widgets.`,
				`Body ${SECRET_MARKER}.`,
			),
		);

		await harness.session.prompt(`what was the widget rollout plan?`);
		expect(harness.session.getMemoryPromptInclusionReport().status).toBe("included"); // non-vacuous

		const result = await runContextAudit(harness, { includePreviews: true, maxItems: 50 });

		expect(auditText(result)).not.toContain(SECRET_MARKER);
		expect(JSON.stringify(result.details ?? {})).not.toContain(SECRET_MARKER);
	});

	it("R15: repeated reads of the getters context_audit relies on do not mutate the transcript, artifact refs, or the stored memory reports", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal"],
			settings: { contextPolicy: { memory: { enabled: true, includeInPrompt: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument("Widget rollout plan", "Design decision about the widget rollout plan.", "Body."),
		);

		await harness.session.prompt("what was the widget rollout plan?");
		// One real context_audit tool invocation (drives its own turn, as tool use does).
		await runContextAudit(harness);

		const messagesBefore = JSON.stringify(harness.session.messages);
		const branchBefore = JSON.stringify(harness.sessionManager.getBranch());
		const retrievalReportBefore = JSON.stringify(harness.session.getMemoryRetrievalReport());
		const inclusionReportBefore = JSON.stringify(harness.session.getMemoryPromptInclusionReport());

		// Repeated READS of the exact getters context_audit's diagnostics combiner calls --
		// these must never mutate anything, independent of driving further tool-use turns.
		harness.session.getMemoryRetrievalReport();
		harness.session.getMemoryPromptInclusionReport();
		harness.session.getMemoryRetrievalReport();
		harness.session.getMemoryPromptInclusionReport();

		expect(JSON.stringify(harness.session.messages)).toBe(messagesBefore);
		expect(JSON.stringify(harness.sessionManager.getBranch())).toBe(branchBefore);
		expect(JSON.stringify(harness.session.getMemoryRetrievalReport())).toBe(retrievalReportBefore);
		expect(JSON.stringify(harness.session.getMemoryPromptInclusionReport())).toBe(inclusionReportBefore);
	});
});

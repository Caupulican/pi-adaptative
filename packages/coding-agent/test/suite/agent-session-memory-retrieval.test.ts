/**
 * First live-integration slice for local context memory retrieval: observe-only, opt-in,
 * default disabled. Proves the local Pi OKF memory provider is really wired into the live
 * AgentSession transform pipeline (queried, results parsed into labeled ContextItems,
 * stored in a read-only report) WITHOUT ever changing the provider-visible message array,
 * the transcript, or touching an external provider. "Surfacing" retrieved memory into the
 * prompt itself is explicitly out of scope for this slice (see PM plan).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { Context } from "@caupulican/pi-ai";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { formatOkfMemoryDocument } from "../../src/core/context/okf-memory.ts";
import { createHarness, type Harness } from "./harness.ts";

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

/**
 * Strips non-deterministic per-run fields (message timestamps, and each harness's own
 * random tempDir embedded in the system prompt's cwd line) so two separate harness runs
 * are comparable.
 */
function normalizeContext(context: Context, tempDir: string): unknown {
	return {
		systemPrompt: context.systemPrompt?.split(tempDir).join("<tempdir>"),
		// Tool `execute` closures are unique per-harness instances (never === across
		// separate sessions even when functionally identical), so compare tool identity by
		// name/description only, not the closure itself.
		toolNames: context.tools?.map((tool) => (tool as unknown as { name: string }).name).sort(),
		messages: context.messages.map((message) => {
			const { timestamp: _timestamp, ...rest } = message as unknown as Record<string, unknown>;
			return rest;
		}),
	};
}

describe("AgentSession live local memory retrieval (observe-only, default disabled)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("R2: default disabled never queries the provider (empty report) even with a real OKF file present", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		// A real OKF file exists on disk, but the setting is off by default -- it must
		// never be read. An empty providerReports proves retrieveMemoryForContext (and
		// therefore the provider) was never even invoked, not just that it found nothing.
		writeOkfFile(harness, "note.okf.md", okfDocument("Widget rollout", "Notes on widget rollout.", "Body text."));

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("tell me about widgets");

		const report = harness.session.getMemoryRetrievalReport();
		expect(report.results).toEqual([]);
		expect(report.contextItems).toEqual([]);
		expect(report.providerReports).toEqual([]);
	});

	it("R2b: with no OKF directory at all, disabled default never creates one", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		expect(existsSync(memoryDir(harness))).toBe(false);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");

		expect(existsSync(memoryDir(harness))).toBe(false);
	});

	it("R1: provider-visible messages are identical whether memory retrieval is enabled or disabled", async () => {
		const disabledHarness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: false, maxResults: 5 } } },
		});
		const enabledHarness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5 } } },
		});
		harnesses.push(disabledHarness, enabledHarness);

		const doc = okfDocument("Widget rollout", "Notes on widget rollout.", "Body text about widgets.");
		writeOkfFile(disabledHarness, "note.okf.md", doc);
		writeOkfFile(enabledHarness, "note.okf.md", doc);

		let disabledCaptured: Context | undefined;
		disabledHarness.setResponses([
			(context) => {
				disabledCaptured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await disabledHarness.session.prompt("tell me about widgets");

		let enabledCaptured: Context | undefined;
		enabledHarness.setResponses([
			(context) => {
				enabledCaptured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await enabledHarness.session.prompt("tell me about widgets");

		expect(normalizeContext(enabledCaptured as Context, enabledHarness.tempDir)).toEqual(
			normalizeContext(disabledCaptured as Context, disabledHarness.tempDir),
		);

		// Confirm this isn't a vacuous comparison: memory retrieval really did find
		// something on the enabled side (proving the provider-visible identity above is
		// despite real, non-empty retrieval activity, not because nothing happened).
		const enabledReport = enabledHarness.session.getMemoryRetrievalReport();
		expect(enabledReport.contextItems.length).toBeGreaterThan(0);
	});

	it("enabled + a real OKF file produces a source-labeled, evidence-only ContextItem in the report", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument("Widget rollout plan", "Design decision about the widget rollout plan.", "Full body."),
		);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("what was the widget rollout plan?");

		const report = harness.session.getMemoryRetrievalReport();
		expect(report.providerReports).toEqual([
			expect.objectContaining({ providerId: "pi-okf", status: "queried", resultCount: 1 }),
		]);
		expect(report.contextItems).toHaveLength(1);
		const [item] = report.contextItems;
		expect(item.kind).toBe("memory_item");
		expect(item.retentionClass).toBe("useful"); // evidence, never authority
		expect(item.source).toBe("memory");
		expect(item.summary).toContain("pi-okf/project/design_decision");
		expect(item.primaryRef).toMatchObject({ type: "memory" });
	});

	it("R6: with no latest user message, the query degrades to empty -> zero results, no throw", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(harness, "note.okf.md", okfDocument("Widget rollout", "Notes on widget rollout.", "Body text."));

		// Directly exercise the real, installed transform with a message array that has NO
		// user-role message at all (only a toolResult) -- legitimate via the public
		// Agent.transformContext API, and valid because this is a brand-new harness whose
		// agent.state.messages is still empty (so the transform's "authoritative messages"
		// fallback uses exactly what we pass in here, not some pre-existing user turn).
		const toolResultOnly: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "bash",
				content: [{ type: "text", text: "some tool output, no user message anywhere" }],
				isError: false,
				timestamp: 0,
			},
		];

		await expect(harness.session.agent.transformContext?.(toolResultOnly)).resolves.toBeDefined();

		const report = harness.session.getMemoryRetrievalReport();
		expect(report.request.query).toBe("");
		expect(report.results).toEqual([]);
		expect(report.providerReports).toEqual([
			expect.objectContaining({ providerId: "pi-okf", status: "queried", resultCount: 0 }),
		]);
	});

	it("a malformed OKF file does not throw or block the turn; a valid sibling is still returned", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(harness, "broken.okf.md", "---\ntype: [bad\n---\nbroken body");
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument("Widget rollout plan", "Design decision about the widget rollout plan.", "Full body."),
		);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("what was the widget rollout plan?"); // must not throw

		const report = harness.session.getMemoryRetrievalReport();
		expect(report.providerReports[0]?.status).toBe("queried");
		expect(report.contextItems).toHaveLength(1);
	});

	it("the read-only getter never mutates the transcript or session state", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5 } } },
		});
		harnesses.push(harness);
		writeOkfFile(harness, "note.okf.md", okfDocument("Widget rollout", "Notes on widget rollout.", "Body text."));

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("tell me about widgets");

		const messagesBefore = JSON.stringify(harness.session.messages);
		const branchBefore = JSON.stringify(harness.sessionManager.getBranch());

		harness.session.getMemoryRetrievalReport();
		harness.session.getMemoryRetrievalReport();

		expect(JSON.stringify(harness.session.messages)).toBe(messagesBefore);
		expect(JSON.stringify(harness.sessionManager.getBranch())).toBe(branchBefore);
	});
});

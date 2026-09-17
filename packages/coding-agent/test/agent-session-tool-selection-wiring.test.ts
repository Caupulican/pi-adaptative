import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { formatToolSelectionHints } from "../src/core/tool-selection/promotion.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import type { ToolSelectionController } from "../src/core/tool-selection/tool-selection-controller.ts";
import { createHarness } from "./suite/harness.ts";

const TOOL_SHORTLIST_HEADING = "EVIDENCE-GATED TOOL SHORTLIST; observation, never directive";

/**
 * End-to-end wiring: AgentSession now supplies `getToolSelectionHints` to SystemPromptBuilder and
 * folds `formatToolSelectionReport` into `formatToolRepairHealthReport()` (the /toolhealth text),
 * both reading the SAME live `_toolSelection` controller instance real tool calls observe through.
 * See test/system-prompt-builder-tool-selection.test.ts for the SystemPromptBuilder-side rendering
 * unit tests (dep supplied directly, no AgentSession) and test/tool-selection-controller.test.ts for
 * the promotion-threshold mechanics this test's "3 successes promotes a hint" recipe relies on.
 */

function toolSelectionOf(harness: Awaited<ReturnType<typeof createHarness>>): ToolSelectionController {
	return (harness.session as unknown as { _toolSelection: ToolSelectionController })._toolSelection;
}

/** Promotes a hint for the "read" intent by driving the exact recipe
 * test/tool-selection-controller.test.ts uses: 3 successful calls clears the evidence gate. */
function promoteReadHint(toolSelection: ToolSelectionController): void {
	for (let i = 0; i < 3; i += 1) {
		toolSelection.begin(`call-${i}`, "read", {});
		toolSelection.complete(`call-${i}`, true, [{ type: "text", text: "ok" }]);
	}
}

describe("AgentSession — tool-selection wiring", () => {
	it.each([
		{ rendered: false, override: undefined },
		{ rendered: true, override: undefined },
		{ rendered: true, override: false },
		{ rendered: false, override: true },
	])("credits request hints (rendered=$rendered, extension override=$override)", async ({ rendered, override }) => {
		let hintBlock = "";
		const harness = await createHarness({
			initialActiveToolNames: ["read"],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (override === undefined) return;
						const withoutHint = event.systemPrompt.replace(
							/EVIDENCE-GATED TOOL SHORTLIST; observation, never directive\n[\s\S]*?Use task judgment\./u,
							"",
						);
						return { systemPrompt: override ? `${withoutHint}\n${hintBlock}` : withoutHint };
					});
				},
			],
		});
		try {
			const selection = toolSelectionOf(harness);
			promoteReadHint(selection);
			hintBlock = formatToolSelectionHints(selection.getActiveHints())!;
			const snapshots = vi.spyOn(selection, "observeProviderRequest");
			const admissions = vi.spyOn(selection, "begin");
			if (rendered) {
				(harness.session as unknown as { _refreshBaseSystemPrompt(): void })._refreshBaseSystemPrompt();
			}
			const path = join(harness.tempDir, "hint-fixture.txt");
			writeFileSync(path, "fixture content");
			let observedHint: boolean | undefined;
			harness.setResponses([
				(context) => {
					observedHint = context.systemPrompt?.includes("- read: `read` established for this model") === true;
					return fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Read complete."),
			]);
			await harness.session.prompt("Read the fixture once.");
			const expectedHint = override ?? rendered;
			expect(observedHint).toBe(expectedHint);
			expect(snapshots).toHaveBeenCalledTimes(2);
			expect(admissions).toHaveBeenCalledTimes(1);
			expect(admissions.mock.calls[0][3]).toBe(snapshots.mock.calls[0][0]);
			expect(snapshots.mock.calls[0][0]).not.toBe(snapshots.mock.calls[1][0]);
			expect(snapshots.mock.calls[0][2].includes("- read: `read` established for this model")).toBe(expectedHint);
			expect(selection.getReport().find((entry) => entry.intentClass === "read")).toMatchObject({
				sampleCount: 4,
				hintSampleCount: expectedHint ? 1 : 0,
			});
			// Replayed completion cannot add a fifth sample; verify persisted bytes through a fresh reader.
			selection.complete(admissions.mock.calls[0][0], true);
			const writer = (selection as unknown as { deps: { store: ToolPerformanceStore } }).deps.store;
			writer.flush();
			const reader = ToolPerformanceStore.forAgentDir(harness.tempDir, { readOnly: true });
			try {
				expect(reader.getIntentAgreement(snapshots.mock.calls[0][1], "read")).toMatchObject({
					sampleCount: 4,
					hintActiveSampleCount: expectedHint ? 1 : 0,
				});
			} finally {
				reader.close();
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("the built system prompt contains an active hint once the live controller promotes one", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		try {
			const toolSelection = toolSelectionOf(harness);
			expect(toolSelection.getActiveHints()).toEqual([]);

			promoteReadHint(toolSelection);
			expect(toolSelection.getActiveHints()).toHaveLength(1);

			// Force a rebuild against the now-promoted hint (system-prompt-stability's own invariant —
			// rebuild only on tool-surface change — is out of scope here; this pins that the SUPPLIED
			// dep reads the live controller, not that a hint appears without any rebuild trigger).
			(harness.session as unknown as { _refreshBaseSystemPrompt(): void })._refreshBaseSystemPrompt();

			expect(harness.session.systemPrompt).toContain(TOOL_SHORTLIST_HEADING);
			expect(harness.session.systemPrompt).toContain("- read: `read` established for this model");
		} finally {
			harness.cleanup();
		}
	});

	it("the built system prompt has no hint block before any evidence is recorded", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		try {
			(harness.session as unknown as { _refreshBaseSystemPrompt(): void })._refreshBaseSystemPrompt();
			expect(harness.session.systemPrompt).not.toContain(TOOL_SHORTLIST_HEADING);
		} finally {
			harness.cleanup();
		}
	});

	it("/toolhealth (formatToolRepairHealthReport) includes the tool-selection report section", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		try {
			const toolSelection = toolSelectionOf(harness);

			// Before any observation, the tool-selection section still renders (its own "no observations" line).
			const before = harness.session.formatToolRepairHealthReport();
			expect(before).toContain("Tool-selection loop: no observations recorded yet");
			expect(before).toContain("hint snapshot: n=");

			promoteReadHint(toolSelection);

			const after = harness.session.formatToolRepairHealthReport();
			expect(after).toContain("Tool-selection loop (observe -> agreement -> evidence-gated hint)");
			expect(after).toContain("hint active: prefer `read`");
			expect(after).toContain("selection: n=3");
			expect(after).toContain("execution and result hooks: n=3");
			expect(after).toContain("observation evidence write: n=3");
		} finally {
			harness.cleanup();
		}
	});
});

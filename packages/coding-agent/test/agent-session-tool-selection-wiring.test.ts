import { describe, expect, it } from "vitest";
import type { ToolSelectionController } from "../src/core/tool-selection/tool-selection-controller.ts";
import { createHarness } from "./suite/harness.ts";

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

			expect(harness.session.systemPrompt).toContain("Learned tool preferences");
			expect(harness.session.systemPrompt).toContain("read");
		} finally {
			harness.cleanup();
		}
	});

	it("the built system prompt has no hint block before any evidence is recorded", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		try {
			(harness.session as unknown as { _refreshBaseSystemPrompt(): void })._refreshBaseSystemPrompt();
			expect(harness.session.systemPrompt).not.toContain("Learned tool preferences");
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

			promoteReadHint(toolSelection);

			const after = harness.session.formatToolRepairHealthReport();
			expect(after).toContain("Tool-selection loop (observe -> agreement -> evidence-gated hint)");
			expect(after).toContain("hint active: prefer `read`");
		} finally {
			harness.cleanup();
		}
	});
});

import { type AssistantMessage, fauxAssistantMessage } from "@caupulican/pi-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { UsageActionSelectorComponent } from "../src/modes/interactive/components/usage-action-selector.ts";
import {
	misalignmentBlock,
	offerMisalignmentContinuation,
} from "../src/modes/interactive/misalignment-continuation.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function blocked(details: Record<string, unknown>): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Codex response failed" }),
		diagnostics: [{ type: "openai_codex_misalignment", timestamp: 1, details }],
	};
}

function choose(selector: UsageActionSelectorComponent, value: string): void {
	const list = selector.getSelectList();
	list.setFilter(value);
	const item = list.getSelectedItem();
	if (!item) throw new Error(`Missing selector item ${value}`);
	list.onSelect?.(item);
}

describe("Codex misalignment continuation", () => {
	beforeAll(() => initTheme("dark"));

	it("offers continuation only with both the explanation and the steer", () => {
		expect(misalignmentBlock(blocked({ detailedExplanation: "Outside the task.", steer: "Stay on task." }))).toEqual({
			detailedExplanation: "Outside the task.",
			steer: "Stay on task.",
		});
		expect(misalignmentBlock(blocked({ steer: "Stay on task." }))).toBeUndefined();
		expect(misalignmentBlock(blocked({ detailedExplanation: "Outside the task." }))).toBeUndefined();
		expect(misalignmentBlock(fauxAssistantMessage("done"))).toBeUndefined();
	});

	it("submits the steer only when the owner continues, defaulting to stop", () => {
		const selectors: UsageActionSelectorComponent[] = [];
		const submit = vi.fn(async () => {});
		const host = {
			showSelector: (create: Parameters<Parameters<typeof offerMisalignmentContinuation>[0]["showSelector"]>[0]) =>
				selectors.push(create(() => {}).component as UsageActionSelectorComponent),
			submit,
		};
		const block = { detailedExplanation: "Outside the task.", steer: "Stay on task." };

		offerMisalignmentContinuation(host, block);
		expect(selectors[0]?.render(100).join("\n")).toContain("Outside the task.");
		expect(selectors[0]?.getSelectList().getSelectedItem()?.value).toBe("stop");
		choose(selectors[0]!, "stop");
		expect(submit).not.toHaveBeenCalled();

		offerMisalignmentContinuation(host, block);
		choose(selectors[1]!, "continue");
		expect(submit).toHaveBeenCalledWith("Stay on task.");
	});
});

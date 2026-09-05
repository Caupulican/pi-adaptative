import { Container, type TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ActionTranscriptComponent } from "../src/modes/interactive/components/action-transcript.ts";
import { compactWorkPanel } from "../src/modes/interactive/components/agents-overlay.ts";
import { questionConversationText } from "../src/modes/interactive/components/question-conversation.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { createWorkbenchToolPreview } from "../src/modes/interactive/components/workbench-tool-preview.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("Workbench evidence projections", () => {
	beforeAll(() => initTheme("dark"));
	it("does not attribute a failed question tool to the user's answer", () => {
		const text = questionConversationText({}, [{ type: "text", text: "Question cancelled" }], true);
		expect(text).toBe("Question status\nQuestion cancelled");
	});
	it("updates a question nested in a collapsed action transcript without expanding ordinary tools", () => {
		const question = new ToolExecutionComponent(
			"ask_question",
			"question",
			{ questions: [{ question: "Which layout?" }] },
			{},
			undefined,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		const chat = new Container();
		chat.addChild(new ActionTranscriptComponent([question]));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
			viewportRows: () => 25,
		});
		expect(stripAnsi(view.render(110).join("\n"))).toContain("Which layout?");
		question.updateResult({ content: [{ type: "text", text: "Workbench" }], isError: false });
		const text = stripAnsi(view.render(110).join("\n"));
		expect(text).toContain("Workbench");
		expect(text).not.toContain("Waiting for your answer");
		expect(text).not.toContain("Performed 1 action");
	});
	it("retains the exact question and answer as conversation, not execution noise", () => {
		expect(
			questionConversationText({ questions: [{ question: "Which layout should we use?" }] }, [
				{ type: "text", text: "Layout: user answered: Workbench" },
			]),
		).toBe("Assistant\nWhich layout should we use?\n\nYou\nLayout: user answered: Workbench");
	});
	it("hides routine reads without reading their payload; displays edit evidence and errors", () => {
		const read = {
			isError: false,
			get content(): never {
				throw new Error("cold payload accessed");
			},
		};
		expect(createWorkbenchToolPreview("read", {}, read)).toBeUndefined();
		const edit = createWorkbenchToolPreview(
			"edit",
			{ path: "file.ts" },
			{
				isError: false,
				content: [],
				details: { diff: "-1 old\n+1 new" },
			},
		);
		const text = stripAnsi(edit?.render(100).join("\n") ?? "");
		expect(text).toContain("file.ts");
		expect(text).toContain("old");
		expect(text).toContain("new");
		expect(
			createWorkbenchToolPreview("read", {}, { isError: true, content: [{ type: "text", text: "denied" }] })
				?.render(80)
				.join("\n"),
		).toContain("denied");
	});
	it("bounds long plans around urgent work and never hides a failure behind completed rows", () => {
		const model = compactWorkPanel({
			label: "Work",
			rows: [
				...Array.from({ length: 120 }, (_, i) => ({ label: `step ${i}`, status: "completed" as const })),
				{ label: "failed verifier", status: "failed" },
				{ label: "current", status: "in_progress" },
				{ label: "next", status: "pending" },
			],
		});
		expect(model.rows?.map((row) => row.label)).toContain("failed verifier");
		expect(model.rows?.map((row) => row.label)).toContain("current");
		expect(model.rows?.length).toBeLessThanOrEqual(6);
		expect(model.hiddenRowCount).toBeGreaterThan(100);
	});
});

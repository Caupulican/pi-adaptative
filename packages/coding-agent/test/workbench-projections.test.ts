// @isolated: Mutates Chalk's process-wide color level to verify inverse emphasis.
import { Container, type TUI } from "@caupulican/pi-tui";
import chalk from "chalk";
import { beforeAll, describe, expect, it } from "vitest";
import { ActionTranscriptComponent } from "../src/modes/interactive/components/action-transcript.ts";
import { compactWorkPanel } from "../src/modes/interactive/components/agents-overlay.ts";
import { questionConversationText } from "../src/modes/interactive/components/question-conversation.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import {
	createSystemOneEvaluationPreview,
	createSystemOneSummaryPreview,
	createWorkbenchToolPreview,
} from "../src/modes/interactive/components/workbench-tool-preview.ts";
import { highlightCode, initTheme, setTheme, theme } from "../src/modes/interactive/theme/theme.ts";
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
			brand: "pi",
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
	it("paints plain execution output in the theme text color, not gray tool output", () => {
		const preview = createWorkbenchToolPreview(
			"bash",
			{},
			{
				isError: false,
				content: [{ type: "text", text: "hello from the command" }],
			},
		);
		const rendered = preview?.render(100).join("\n") ?? "";
		expect(rendered).toContain(theme.fg("text", "hello from the command"));
		expect(rendered).not.toContain(theme.fg("toolOutput", "hello from the command"));
	});
	it("syntax-colors known-language execution code through theme tokens", () => {
		const preview = createWorkbenchToolPreview(
			"write",
			{ path: "file.ts", content: "const n = 1" },
			{ isError: false, content: [] },
		);
		const rendered = preview?.render(100).join("\n") ?? "";
		expect(stripAnsi(rendered)).toContain("const n = 1");
		expect(rendered).toContain(theme.fg("syntaxKeyword", "const"));
		expect(rendered).toContain(theme.fg("toolDiffAdded", "+"));
		expect(rendered).toContain(highlightCode(" ", "typescript", { plainColor: "text" })[0]);
	});
	it("does not syntax-color command output or error text", () => {
		const command = createWorkbenchToolPreview(
			"bash",
			{ command: "const n = 1" },
			{
				isError: false,
				content: [{ type: "text", text: "const n = 1" }],
			},
		);
		const commandRendered = command?.render(100).join("\n") ?? "";
		expect(commandRendered).toContain(theme.fg("text", "const n = 1"));
		expect(commandRendered).not.toContain(theme.fg("syntaxKeyword", "const"));

		const error = createWorkbenchToolPreview(
			"edit",
			{ path: "file.ts" },
			{ isError: true, content: [{ type: "text", text: "const denied" }] },
		);
		const errorRendered = error?.render(100).join("\n") ?? "";
		expect(stripAnsi(errorRendered)).toContain("const denied");
		expect(errorRendered).not.toContain(theme.fg("syntaxKeyword", "const"));
	});
	it("recolors an existing execution preview after theme invalidation", () => {
		initTheme("dark");
		const preview = createWorkbenchToolPreview(
			"write",
			{ path: "file.ts", content: "const n = 1" },
			{ isError: false, content: [] },
			{ kind: "root", label: "root", modelRef: "openai/model" },
		);
		if (!preview) throw new Error("Missing write preview");
		const original = preview.render(100).join("\n");
		try {
			for (const name of ["light", "dark", "light"]) {
				expect(setTheme(name).success).toBe(true);
				preview.invalidate();
				const rendered = preview.render(100).join("\n");
				expect(stripAnsi(rendered)).toBe(stripAnsi(original));
				expect(rendered).toContain(theme.fg("toolTitle", "write · file.ts"));
				expect(rendered).toContain(theme.fg("toolDiffAdded", "+1"));
				expect(rendered).toContain(theme.fg("muted", "root · model"));
				expect(rendered).toContain(theme.fg("syntaxKeyword", "const"));
			}
		} finally {
			setTheme("dark");
		}
	});
	it("recolors System One evidence and summaries with the execution pane", () => {
		initTheme("dark");
		const record = {
			evaluationId: "eval-1",
			programId: "system-one:postflight",
			label: "postflight",
			startedAt: 0,
			endedAt: 10,
			durationMs: 10,
			outcome: "ok" as const,
			verdict: "pass",
			reasons: ["verified evidence"],
		};
		const evidence = createSystemOneEvaluationPreview(record);
		const summary = createSystemOneSummaryPreview([record]);
		evidence.render(120);
		summary.render(120);
		try {
			expect(setTheme("light").success).toBe(true);
			for (const component of [evidence, summary]) component.invalidate();
			const detail = evidence.render(120).join("\n");
			expect(detail).toContain(theme.fg("customMessageLabel", "◆ System One postflight"));
			expect(detail).toContain(theme.fg("toolOutput", "verified evidence"));
			const total = summary.render(120).join("\n");
			expect(total).toContain(theme.fg("customMessageLabel", "◆ System One · 1 evaluation · avg 0.0s"));
			expect(total).toContain(theme.fg("dim", "postflight"));
		} finally {
			setTheme("dark");
		}
	});

	it("ignores diff-shaped command details and keeps unknown-language writes plain", () => {
		const command = createWorkbenchToolPreview(
			"bash",
			{ path: "file.ts" },
			{
				isError: false,
				content: [{ type: "text", text: "const stdout = 1" }],
				details: { diff: "+1 const forged = 1" },
			},
		);
		const output = command?.render(100).join("\n") ?? "";
		expect(output).toContain(theme.fg("text", "const stdout = 1"));
		expect(output).not.toContain("forged");
		const write = createWorkbenchToolPreview(
			"write",
			{ path: "file.unknown", content: "const prose = 1" },
			{ isError: false, content: [] },
		);
		const plain = write?.render(100).join("\n") ?? "";
		expect(plain).toContain(theme.fg("text", "const prose = 1"));
		expect(plain).not.toContain(theme.fg("syntaxKeyword", "const"));
	});
	it("keeps multiline syntax state separately for removed and added source", () => {
		const preview = createWorkbenchToolPreview(
			"edit",
			{ path: "file.ts" },
			{
				isError: false,
				content: [],
				details: { diff: "-1 /*\n-2 const old = 1\n-3 */\n+1 const fresh = 2\n+2 /*\n+3 const comment = 3\n+4 */" },
			},
		);
		const rendered = preview?.render(100).join("\n") ?? "";
		expect(rendered).toContain(theme.fg("syntaxComment", "const old = 1"));
		expect(rendered).toContain(theme.fg("syntaxComment", "const comment = 3"));
		expect(
			rendered.match(new RegExp(theme.fg("syntaxKeyword", "const").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
		).toHaveLength(1);
		expect(stripAnsi(rendered)).toContain("+1 const fresh = 2");
	});
	it("retains changed-word emphasis alongside source colors and on unknown-language edits", () => {
		initTheme("dark");
		const previousLevel = chalk.level;
		chalk.level = 3;
		try {
			for (const path of ["file.ts", "file.unknown"]) {
				const preview = createWorkbenchToolPreview(
					"edit",
					{ path },
					{
						isError: false,
						content: [],
						details: { diff: "-1 const value = old;\n+1 const value = fresh;" },
					},
				);
				const rendered = preview?.render(100).join("\n") ?? "";
				expect(rendered).toContain(theme.inverse("old"));
				expect(rendered).toContain(theme.inverse("fresh"));
				expect(rendered).not.toContain(theme.inverse("const"));
				expect(stripAnsi(rendered)).toContain("const value = fresh;");
				if (path.endsWith(".ts")) expect(rendered).toContain(theme.fg("syntaxKeyword", "const"));
			}
		} finally {
			chalk.level = previousLevel;
		}
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

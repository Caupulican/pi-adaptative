import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, TUI } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditsDiff, type Edit } from "../src/core/tools/edit-diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

function createLargeEdits(lines: string[]): Edit[] {
	const targets = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
	return targets.map((lineNumber) => ({
		oldText: `${lines[lineNumber - 1]}\n${lines[lineNumber]}\n${lines[lineNumber + 1]}`,
		newText: `${lines[lineNumber - 1]}\n${lines[lineNumber]} changed\n${lines[lineNumber + 1]}`,
	}));
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the large diff in the call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const root = new Container();
		for (let i = 0; i < 200; i++) {
			root.addChild(new Text(`history ${i}`, 0, 0));
		}

		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-1",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();

		const stringify = vi.spyOn(JSON, "stringify");
		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const callOnlyRender = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"10 blocks",
			() => tui.requestRender(true),
		);
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).not.toContain("line 950 changed");
		expect(
			stringify.mock.calls.some(
				([value]) =>
					typeof value === "object" &&
					value !== null &&
					"edits" in value &&
					(value as { edits?: unknown }).edits === edits,
			),
		).toBe(false);

		component.setExpanded(true);
		tui.requestRender();
		const expandedRender = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"line 950 changed",
			() => tui.requestRender(true),
		);
		expect(expandedRender).toContain("line 50 changed");

		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: { ...diff, phase: "edited" },
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();

		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);

		const settledRender = component.render(80).join("\n");
		expect(settledRender).toContain("line 50 changed");
		expect(settledRender).toContain("line 950 changed");
		expect(settledRender).not.toContain("Successfully replaced");
	});

	it("reconstructs the boxed preview from a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines).slice(0, 2);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}
		await rm(filePath, { force: true });

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-replay",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: { ...diff, phase: "edited" },
				isError: false,
			},
			false,
		);
		await waitForRender();
		await waitForRender();

		const collapsed = component.render(80).join("\n");
		expect(collapsed).toContain("2 blocks");
		expect(collapsed).not.toContain("line 150 changed");

		component.setExpanded(true);
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("line 50 changed");
		expect(rendered).toContain("line 150 changed");
	});

	it("reuses the preview's compact validated match plan during execution", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-plan-reuse-"));
		tempDirs.push(dir);
		const filePath = join(dir, "bounded-edit.txt");
		const lines = Array.from({ length: 5_000 }, (_, index) =>
			index === 3_499 ? "const bounded_target = true;" : `const line_${index + 1} = ${index + 1};`,
		);
		await writeFile(filePath, lines.join("\n"), "utf8");

		const definition = createEditToolDefinition(dir);
		const args = {
			path: "bounded-edit.txt",
			edits: [
				{
					oldText: "const bounded_target = true;",
					newText: "const bounded_target = false;",
					range: { startLine: 3_300, endLine: 3_700 },
				},
			],
		};

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const component = new ToolExecutionComponent("edit", "execute-plan", args, {}, definition, tui, dir);
		tui.addChild(component);
		tui.start();
		component.setArgsComplete();
		await waitForRenderedText(
			() => component.render(80).join("\n"),
			"bounded_target = false",
			() => {
				component.setExpanded(true);
				tui.requestRender(true);
			},
		);

		const result = await definition.execute("execute-plan", args, undefined, undefined, {} as ExtensionContext);
		expect(result.details?.matchPlanReused).toBe(true);
		expect((await readFile(filePath, "utf8")).split("\n")[3_499]).toBe("const bounded_target = false;");
		tui.stop();
	});

	it("discards a preview plan when the same-length source changes before execution", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-plan-stale-"));
		tempDirs.push(dir);
		const filePath = join(dir, "stale-preview.txt");
		await writeFile(filePath, "aaaa\ntarget\nzzzz\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const args = {
			path: "stale-preview.txt",
			edits: [{ oldText: "target", newText: "TARGET" }],
		};
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const component = new ToolExecutionComponent("edit", "stale-plan", args, {}, definition, tui, dir);
		tui.addChild(component);
		tui.start();
		component.setArgsComplete();
		await waitForRenderedText(
			() => component.render(80).join("\n"),
			"TARGET",
			() => {
				component.setExpanded(true);
				tui.requestRender(true);
			},
		);

		await writeFile(filePath, "aa\ntarget\nzzzzzz\n", "utf8");
		const result = await definition.execute("stale-plan", args, undefined, undefined, {} as ExtensionContext);

		expect(result.details?.matchPlanReused).toBe(false);
		expect(await readFile(filePath, "utf8")).toBe("aa\nTARGET\nzzzzzz\n");
		tui.stop();
	});

	it("shows a preflight error without rendering a diff when the edits do not apply", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-preflight-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		await writeFile(filePath, "line 0\nline 1\n", "utf8");

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-2",
			{
				path: filePath,
				edits: [{ oldText: "does not exist", newText: "replacement" }],
			},
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"Could not find",
			() => tui.requestRender(true),
		);
		expect(rendered).not.toContain("+1 ");
		expect(rendered).not.toContain("-1 ");
	});
});

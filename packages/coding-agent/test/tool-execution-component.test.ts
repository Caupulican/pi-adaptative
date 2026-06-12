import { join, resolve } from "node:path";
import { Text, type TUI, visibleWidth } from "@caupulican/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import {
	getToolPanelActionKey,
	getToolPanelResultActionKeys,
	ToolPanelRegistry,
} from "../src/modes/interactive/components/tool-panel-registry.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("session-scoped tool panel keys isolate tenants", () => {
		const first = getToolPanelActionKey({ sessionId: "a", sessionFile: "/tmp/a.jsonl", cwd: "/repo" }, "read", {
			path: "README.md",
		});
		const second = getToolPanelActionKey({ sessionId: "b", sessionFile: "/tmp/b.jsonl", cwd: "/repo" }, "read", {
			path: "README.md",
		});
		const sameSessionOtherFile = getToolPanelActionKey(
			{ sessionId: "a", sessionFile: "/tmp/a.jsonl", cwd: "/repo" },
			"read",
			{ path: "CHANGELOG.md" },
		);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(sameSessionOtherFile).toBeDefined();
		expect(first).not.toEqual(second);
		expect(first).not.toEqual(sameSessionOtherFile);
	});

	test("background_script status reuses the start panel by job name", () => {
		const scope = { sessionId: "a", sessionFile: "/tmp/a.jsonl", cwd: "/repo" };
		const start = getToolPanelActionKey(scope, "background_script", {
			action: "start",
			name: "build-watch",
		});
		const status = getToolPanelActionKey(scope, "background_script", {
			action: "status",
			id: "build-watch",
		});
		const logs = getToolPanelActionKey(scope, "background_script", {
			action: "logs",
			id: "build-watch",
		});

		expect(start).toBeDefined();
		expect(status).toEqual(start);
		expect(logs).toEqual(start);
		expect(getToolPanelActionKey(scope, "background_script", { action: "list" })).toBeUndefined();
	});

	test("background_script in-place reuse supersedes earlier active calls for the same job", () => {
		const scope = { sessionId: "a", sessionFile: "/tmp/a.jsonl", cwd: "/repo" };
		const key = getToolPanelActionKey(scope, "background_script", { action: "start", name: "build-watch" });
		expect(key).toBeDefined();
		const registry = new ToolPanelRegistry();
		const panel = new ToolExecutionComponent(
			"background_script",
			"tool-script-1",
			{ action: "start", name: "build-watch" },
			{},
			createBaseToolDefinition("background_script"),
			createFakeTui(),
			process.cwd(),
		);

		registry.register("tool-script-1", panel, key);
		expect(registry.getReusable(key)).toBeUndefined();
		expect(registry.getReusable(key, { allowActive: true })).toBe(panel);

		registry.replaceActiveForAction("tool-script-2", panel, key as string);

		expect(registry.getActive("tool-script-1")).toBeUndefined();
		expect(registry.getActive("tool-script-2")).toBe(panel);
	});

	test("background_script result aliases allow status by generated job id to reuse the start panel", () => {
		const scope = { sessionId: "a", sessionFile: "/tmp/a.jsonl", cwd: "/repo" };
		const startKey = getToolPanelActionKey(scope, "background_script", { action: "start", name: "build-watch" });
		const statusKey = getToolPanelActionKey(scope, "background_script", { action: "status", id: "job-123" });
		const aliases = getToolPanelResultActionKeys(scope, "background_script", {
			details: { job: { id: "job-123", name: "build-watch" } },
		});
		const registry = new ToolPanelRegistry();
		const panel = new ToolExecutionComponent(
			"background_script",
			"tool-script-1",
			{ action: "start", name: "build-watch" },
			{},
			createBaseToolDefinition("background_script"),
			createFakeTui(),
			process.cwd(),
		);

		registry.register("tool-script-1", panel, startKey);
		registry.finish("tool-script-1");
		registry.registerAliases(panel, aliases);

		expect(statusKey).toBeDefined();
		expect(registry.getReusable(statusKey)).toBe(panel);
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("shortens absolute tool paths relative to cwd, including parent traversals", () => {
		const cwd = resolve("/tmp/pi-path-display/repo/src");
		const insidePath = join(cwd, "index.ts");
		const siblingPath = resolve(cwd, "../../shared/lib.ts");
		const inside = new ToolExecutionComponent(
			"read",
			"tool-path-1",
			{ path: insidePath },
			{},
			undefined,
			createFakeTui(),
			cwd,
		);
		const sibling = new ToolExecutionComponent(
			"edit",
			"tool-path-2",
			{ path: siblingPath },
			{},
			undefined,
			createFakeTui(),
			cwd,
		);

		const insideRendered = stripAnsi(inside.render(120).join("\n"));
		const siblingRendered = stripAnsi(sibling.render(120).join("\n"));
		expect(insideRendered).toContain("index.ts");
		expect(insideRendered).not.toContain(insidePath);
		expect(siblingRendered).toContain("../../shared/lib.ts");
		expect(siblingRendered).not.toContain(siblingPath);
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back to human custom labels when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Custom Tool");
		expect(rendered).not.toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("uses extension-provided labels for fallback tool titles", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition("learning_auto_learn_state"),
			label: "Auto Learn State",
		};

		const component = new ToolExecutionComponent(
			"learning_auto_learn_state",
			"tool-6b",
			{ action: "read" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Auto Learn State");
		expect(rendered).not.toContain("learning_auto_learn_state");
	});

	test("can reset a reusable tool panel to the latest invocation", () => {
		const firstDefinition: ToolDefinition = { ...createBaseToolDefinition("first_tool"), label: "First Tool" };
		const secondDefinition: ToolDefinition = { ...createBaseToolDefinition("second_tool"), label: "Second Tool" };
		const component = new ToolExecutionComponent(
			"first_tool",
			"tool-reset-1",
			{ path: "first.txt" },
			{},
			firstDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "first result" }], details: {}, isError: false }, false);

		component.resetInvocation("second_tool", "tool-reset-2", { path: "second.txt" }, secondDefinition);
		component.updateResult(
			{ content: [{ type: "text", text: "second result" }], details: {}, isError: false },
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Second Tool");
		expect(rendered).toContain("second result");
		expect(rendered).not.toContain("First Tool");
		expect(rendered).not.toContain("first result");
	});

	test("assigns default tool groups from tool names", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-default-group",
			{},
			{},
			createBaseToolDefinition("custom_tool"),
			createFakeTui(),
			process.cwd(),
		);
		expect(component.toolGroup).toBe("custom_tool");

		component.resetInvocation("second_tool", "tool-default-group-reset", {}, createBaseToolDefinition("second_tool"));
		expect(component.toolGroup).toBe("second_tool");
	});

	test("allows explicit blank tool group opt-out", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-blank-group",
			{},
			{},
			{ ...createBaseToolDefinition("custom_tool"), toolGroup: "" },
			createFakeTui(),
			process.cwd(),
		);
		expect(component.toolGroup).toBeUndefined();
	});

	test("removes tools from grouped components for reusable panel relocation", () => {
		const first = new ToolExecutionComponent(
			"custom_tool",
			"tool-group-first",
			{},
			{},
			createBaseToolDefinition("custom_tool"),
			createFakeTui(),
			process.cwd(),
		);
		const second = new ToolExecutionComponent(
			"custom_tool",
			"tool-group-second",
			{},
			{},
			createBaseToolDefinition("custom_tool"),
			createFakeTui(),
			process.cwd(),
		);
		const group = new ToolGroupComponent("custom_tool", [first, second]);

		expect(group.getToolCount()).toBe(2);
		expect(group.removeTool(first)).toBe(true);
		expect(group.getToolCount()).toBe(1);
		expect(group.getOnlyTool()).toBe(second);
		expect(group.removeTool(first)).toBe(false);
		expect(group.removeTool(second)).toBe(true);
		expect(group.getToolCount()).toBe(0);
	});

	test("renders grouped call summaries without result output", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition("summary_tool"),
			label: "Summary Tool",
			toolGroup: "summary",
		};
		const component = new ToolExecutionComponent(
			"summary_tool",
			"tool-summary",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden grouped result" }], details: {}, isError: false },
			false,
		);
		const summary = stripAnsi(component.renderCallSummary(120).join("\n"));
		expect(summary).toContain("Summary Tool");
		expect(summary).not.toContain("hidden grouped result");
	});

	test("keeps collapsed grouped bash summaries within render width when adding expand hint", () => {
		const command = `printf 'WSL_ADDRS\n'; ip -4 -o addr show scope global | sed 's/\\// /g' || true
printf '\nWINDOWS_IPV4\n'; powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object InterfaceAlias,IPAddress,PrefixLength | Format-Table -AutoSize" 2>/dev/null | tr -d '\r' || true`;
		const component = new ToolExecutionComponent(
			"bash",
			"tool-group-long-bash",
			{ command, timeout: 15 },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const group = new ToolGroupComponent("bash", [component]);

		const lines = group.render(112);

		expect(stripAnsi(lines.join("\n"))).toContain("to expand");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(112);
		}
	});

	test("keeps collapsed grouped npm version checks within render width when adding expand hint", () => {
		const firstCommand = `npm view @caupulican/pi-ai versions --json | tail -c 1000 && printf '\n---\n' && npm view @caupulican/pi-agent-core versions --json | tail -c 1000 && printf '\n---\n' && npm view @caupulican/pi-tui versions --json | tail -c 1000`;
		const secondCommand = `cd /mnt/d/GitHub/mine/pi-adaptative && npm view @caupulican/pi-adaptative@0.80.2 dependencies --json && printf '\n---dist-tags---\n' && npm view @caupulican/pi-adaptative dist-tags --json`;
		const components = [firstCommand, secondCommand].map(
			(command, index) =>
				new ToolExecutionComponent(
					"bash",
					`tool-group-npm-version-${index}`,
					{ command, timeout: 60 },
					{},
					createBashToolDefinition(process.cwd()),
					createFakeTui(),
					process.cwd(),
				),
		);
		const group = new ToolGroupComponent("bash", components);

		const lines = group.render(112);

		expect(stripAnsi(lines.join("\n"))).toContain("to expand");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(112);
		}
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: "read resource ../AGENTS.md",
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "GEMINI.md",
			path: join(process.cwd(), "GEMINI.md"),
			content: "Hidden Gemini instructions",
			compact: "read resource GEMINI.md",
			hidden: "Hidden Gemini instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}

	test("bounds the fallback result view when a tool has no renderer", () => {
		const lines: string[] = [];
		for (let index = 0; index < 4000; index++) lines.push(`fallback-line-${String(index).padStart(4, "0")}`);
		const component = new ToolExecutionComponent(
			"mystery_tool",
			"tool-fallback-1",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: lines.join("\n") }], isError: false });

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered).toContain("fallback-line-0000");
		expect(rendered).not.toContain("fallback-line-3999");
		expect(rendered).toMatch(/truncated for display/i);
	});

	test("bounds the fallback result view when a custom renderer throws", () => {
		const lines: string[] = [];
		for (let index = 0; index < 4000; index++) lines.push(`payload-line-${String(index).padStart(4, "0")}`);
		const throwingDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderResult: () => {
				throw new Error("renderer bug");
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-fallback-2",
			{},
			{},
			throwingDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: lines.join("\n") }], isError: false });

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered).toContain("payload-line-0000");
		expect(rendered).not.toContain("payload-line-3999");
		expect(rendered).toMatch(/truncated for display/i);
	});

	test("caps oversized result details retained after execution completes", () => {
		const seenDetails: unknown[] = [];
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderResult: (result) => {
				seenDetails.push(result.details);
				return new Text("custom result", 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-retention-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult({
			content: [{ type: "text", text: "ok" }],
			isError: false,
			details: { payload: "x".repeat(200_000) },
		});

		const retained = seenDetails[seenDetails.length - 1] as Record<string, unknown>;
		expect(retained.piToolResultDetailsTruncated).toBe(true);
	});

	test("keeps small result details intact after execution completes", () => {
		const seenDetails: unknown[] = [];
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderResult: (result) => {
				seenDetails.push(result.details);
				return new Text("custom result", 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-retention-2",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult({
			content: [{ type: "text", text: "ok" }],
			isError: false,
			details: { summary: "kept", lines: 3 },
		});

		expect(seenDetails[seenDetails.length - 1]).toEqual({ summary: "kept", lines: 3 });
	});

	test("does not cap details on partial result updates", () => {
		const seenDetails: unknown[] = [];
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderResult: (result) => {
				seenDetails.push(result.details);
				return new Text("custom result", 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-retention-3",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const partialPayload = { payload: "x".repeat(200_000) };
		component.updateResult(
			{ content: [{ type: "text", text: "running" }], isError: false, details: partialPayload },
			true,
		);

		expect(seenDetails[seenDetails.length - 1]).toBe(partialPayload);
	});
});

import { Text, type TUI } from "@caupulican/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTui(): TUI {
	return {
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	} as unknown as TUI;
}

function render(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("header-only collapsed tool output", () => {
	beforeAll(() => initTheme(undefined, false));

	for (const scenario of [
		{ title: "completed extension result", isPartial: false, isError: false },
		{ title: "partial extension result", isPartial: true, isError: false },
		{ title: "failed extension result", isPartial: false, isError: true },
	] as const) {
		it(`hides a ${scenario.title} until Ctrl+O expansion`, () => {
			const definition: ToolDefinition = {
				name: "custom_tool",
				label: "Custom Tool",
				description: "fixture",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
				renderCall: () => new Text("custom header", 0, 0),
				renderResult: (result) => new Text(result.content.find((block) => block.type === "text")?.text ?? "", 0, 0),
			};
			const component = new ToolExecutionComponent(
				"custom_tool",
				`collapse-${scenario.title}`,
				{},
				{},
				definition,
				createTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: "secret result body" }], isError: scenario.isError },
				scenario.isPartial,
			);

			const collapsed = render(component);
			expect(collapsed).toContain("custom header");
			expect(collapsed).toContain("to expand");
			expect(collapsed).not.toContain("secret result body");

			component.setExpanded(true);
			expect(render(component)).toContain("secret result body");
		});
	}

	it("hides unknown-tool fallback output until expansion", () => {
		const component = new ToolExecutionComponent(
			"unknown_tool",
			"collapse-unknown",
			{ query: "visible argument" },
			{},
			undefined,
			createTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "secret fallback body" }], isError: false });

		const collapsed = render(component);
		expect(collapsed).toContain("visible argument");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("secret fallback body");

		component.setExpanded(true);
		expect(render(component)).toContain("secret fallback body");
	});

	it("does not materialize a collapsed history payload just to render its hint", () => {
		let reads = 0;
		const result = { isError: false } as {
			content: Array<{ type: string; text: string }>;
			isError: boolean;
		};
		Object.defineProperty(result, "content", {
			get: () => {
				reads++;
				return [{ type: "text", text: "lazy secret" }];
			},
		});
		const component = new ToolExecutionComponent(
			"unknown_tool",
			"collapse-lazy",
			{},
			{ deferResultUntilExpanded: true },
			undefined,
			createTui(),
			process.cwd(),
		);

		component.updateResult(result);
		expect(render(component)).toContain("to expand");
		expect(reads).toBe(0);
		component.setExpanded(true);
		expect(render(component)).toContain("lazy secret");
		expect(reads).toBe(1);
	});

	it("hides direct shell output while running and after failure until expansion", () => {
		const component = new BashExecutionComponent("pwd && rg needle", createTui());
		component.appendOutput("/secret/cwd\nsecret rg match");

		expect(render(component)).toContain("to expand");
		expect(render(component)).not.toContain("/secret/cwd");
		expect(render(component)).not.toContain("secret rg match");

		component.setComplete(2, false);
		const failed = render(component);
		expect(failed).toContain("exit 2");
		expect(failed).not.toContain("secret rg match");

		component.setExpanded(true);
		expect(render(component)).toContain("secret rg match");
	});
});

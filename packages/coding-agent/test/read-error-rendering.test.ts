import { describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("read error rendering", () => {
	it("does not syntax-highlight an error according to the requested file extension", () => {
		initTheme("dark");
		const definition = createReadToolDefinition(process.cwd());
		const error = "Offset 120 is beyond end of file (96 lines total)";
		const component = definition.renderResult?.(
			{ content: [{ type: "text", text: error }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			{
				args: { path: "config.exs", offset: 120, limit: 130 },
				toolCallId: "read-error",
				invalidate: () => {},
				lastComponent: undefined,
				state: undefined,
				cwd: process.cwd(),
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: true,
				showImages: false,
				isError: true,
			},
		);
		if (!component) throw new Error("Missing read result renderer");
		const rendered = component.render(120).join("\n");

		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});
});

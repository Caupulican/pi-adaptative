import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ExtensionUiHost } from "../src/modes/interactive/extension-ui-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("extension UI host widgets", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps native host widgets mounted when extension widgets reload", () => {
		const above = new Container();
		const below = new Container();
		const host = new ExtensionUiHost({
			getSession: () => ({}) as never,
			ui: {
				tui: { requestRender() {} },
				widgetContainerAbove: above,
				widgetContainerBelow: below,
			},
		} as never);
		host.setHostWidget("native", new Text("native orchestration", 0, 0), "belowEditor");
		host.createExtensionUIContext().setWidget("extension", ["extension widget"], { placement: "belowEditor" });

		expect(stripAnsi(below.render(80).join("\n"))).toContain("native orchestration");
		expect(stripAnsi(below.render(80).join("\n"))).toContain("extension widget");

		const clearExtensionWidgets = Reflect.get(ExtensionUiHost.prototype, "clearExtensionWidgets") as (
			this: ExtensionUiHost,
		) => void;
		clearExtensionWidgets.call(host);
		expect(stripAnsi(below.render(80).join("\n"))).toContain("native orchestration");
		expect(stripAnsi(below.render(80).join("\n"))).not.toContain("extension widget");

		host.clearHostWidgets();
		expect(below.children).toHaveLength(0);
	});
});

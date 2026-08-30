import type { AgentMessage } from "@caupulican/pi-agent-core";
import { Container } from "@caupulican/pi-tui";
import { describe, expect, it } from "vitest";
import type { MessageRenderOptions } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("P1l: CustomMessageComponent outputPad plumbing", () => {
	it("passes the real neighbouring-component pad value (not the unplumbed default of 0) to a custom renderer", () => {
		initTheme("dark");
		const ctx = Object.create((InteractiveMode as any).prototype);
		ctx.chatContainer = new Container();
		ctx.toolOutputExpanded = false;
		ctx.getMarkdownThemeWithSettings = () => getMarkdownTheme();

		let seenOptions: MessageRenderOptions | undefined;
		Object.defineProperty(ctx, "session", {
			value: {
				peekPathAliasTable: () => ({ cwd: process.cwd(), entries: [] }),
				extensionRunner: {
					getMessageRenderer: () => (_message: unknown, options: MessageRenderOptions) => {
						seenOptions = options;
						return undefined;
					},
				},
			},
		});

		const message: AgentMessage = {
			role: "custom",
			customType: "test-widget",
			content: [],
			display: true,
		} as unknown as AgentMessage;

		(InteractiveMode as any).prototype.addMessageToChat.call(ctx, message);

		expect(seenOptions?.outputPad).toBe(1);
	});
});

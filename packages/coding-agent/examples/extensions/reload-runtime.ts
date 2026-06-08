/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from a command and an LLM-callable tool.
 * Tool-triggered reload is sequential so the next provider request in the same
 * active run sees the refreshed tool definitions.
 */

import type { ExtensionAPI } from "@caupulican/pi-adaptative";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload.
	// Treat reload as terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, and themes",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// LLM-callable tool. Treat reload as terminal for this handler too:
	// old in-memory extension state should not be used after await ctx.reload().
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, and themes",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await ctx.reload();
			return {
				content: [{ type: "text", text: "Reloaded runtime. Refreshed tools are available on the next turn." }],
				details: {},
			};
		},
	});
}

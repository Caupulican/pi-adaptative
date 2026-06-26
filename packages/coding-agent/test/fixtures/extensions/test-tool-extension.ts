/**
 * Test fixture extension that registers a tool.
 */

import { Type } from "typebox";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";

export const testToolExtensionFactory: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "test_tool",
		label: "Test Tool",
		description: "A test tool for extension testing",
		parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
		execute: async (_toolCallId, params: { message: string }) => ({
			content: [{ type: "text" as const, text: `Test tool executed: ${params.message}` }],
			details: { message: params.message },
		}),
	});
};

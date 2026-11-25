import { expect, it } from "vitest";
import type { ToolCall } from "../src/types.ts";
import { parseStreamingJson, settleToolArguments, stageToolArguments } from "../src/utils/json-parse.ts";

it("keeps tool previews current across escapes and restores plain argument data at completion", () => {
	const call: ToolCall = { type: "toolCall", id: "write", name: "write", arguments: {} };
	let raw = "";
	const append = (delta: string) => {
		raw += delta;
		stageToolArguments(call, raw, delta);
		expect(call.arguments).toEqual(parseStreamingJson(raw));
	};

	append(`{"path":"demo","content":"${"x".repeat(4096)}`);
	const first = call.arguments;
	first.content = "extension edit";
	append(" suffix  ");
	append(String.raw`\nthat\"works`);
	append("\\uD8");
	append("3D\\uDE00");
	append('","mode":"append"}');
	expect(first.content).toBe("extension edit");

	call.arguments = parseStreamingJson(raw);
	settleToolArguments(call);
	expect(Object.getOwnPropertyDescriptor(call, "arguments")).toMatchObject({
		writable: true,
		enumerable: true,
		value: JSON.parse(raw),
	});
});

import { describe, expect, it } from "vitest";
import { TEXT_TOOL_PROTOCOL_ENVELOPE_DELIMITERS } from "../src/utils/tool-repair/text-protocol.ts";
import { TextProtocolLiveFilter } from "../src/utils/tool-repair/text-protocol-live-filter.ts";

function projectByChunks(text: string, chunkSize: number): string {
	const filter = new TextProtocolLiveFilter();
	for (let offset = 0; offset < text.length; offset += chunkSize) {
		filter.advance(text.slice(offset, offset + chunkSize));
	}
	return filter.finish(text);
}

describe("TextProtocolLiveFilter", () => {
	it("suppresses every supported envelope across every single-character boundary", () => {
		const cases = TEXT_TOOL_PROTOCOL_ENVELOPE_DELIMITERS.map(
			({ opener, closer }) =>
				`before ${opener}${opener.startsWith("```") ? "\n" : ">"}{"name":"read"}${closer} after`,
		);
		for (const text of cases) expect(projectByChunks(text, 1), text).toBe("before  after");
	});

	it("releases false opener prefixes without swallowing prose", () => {
		const text = "a <pi:no b <tool_x c ```typescript d <functor e";
		for (let size = 1; size <= 9; size += 1) expect(projectByChunks(text, size)).toBe(text);
	});

	it("keeps an unfinished envelope hidden at stream end", () => {
		const text = 'safe <tool_call>{"name":"read"}';
		for (let size = 1; size <= 7; size += 1) expect(projectByChunks(text, size)).toBe("safe ");
	});

	it("reconciles a non-append provider final snapshot once", () => {
		const filter = new TextProtocolLiveFilter();
		filter.advance("stale partial");
		expect(filter.finish("final <pi:call>{}</pi:call> prose")).toBe("final  prose");
	});
});

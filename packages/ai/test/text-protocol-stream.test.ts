import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, stream } from "../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../src/types.ts";
import { parseTextToolCalls } from "../src/utils/tool-repair/text-protocol.ts";

function makeTool(name = "echo"): Tool {
	return {
		name,
		description: "Echo a value",
		parameters: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		} as Tool["parameters"],
	};
}

const ENVELOPE_TELLTALES = ["<pi:call", "</pi:call", "<tool_call", "</tool_call", "<function", "</function"];

function assertNoEnvelopeLeak(text: string, where: string): void {
	for (const telltale of ENVELOPE_TELLTALES) {
		expect(text, `${where} leaked "${telltale}"`).not.toContain(telltale);
	}
}

/** Collects every event a wrapped stream emits, checking as it goes that no forwarded
 * text_delta/partial ever exposes raw envelope markup, mirroring what a live UI would see. */
async function drainAndAssertNoLiveLeak(assistantStream: AsyncIterable<AssistantMessageEvent>): Promise<{
	events: AssistantMessageEvent[];
	deltasByIndex: Map<number, string[]>;
	finalMessage: AssistantMessage | undefined;
}> {
	const events: AssistantMessageEvent[] = [];
	const deltasByIndex = new Map<number, string[]>();
	let finalMessage: AssistantMessage | undefined;

	for await (const event of assistantStream) {
		events.push(event);
		if ("partial" in event) {
			for (const block of event.partial.content) {
				if (block.type === "text") assertNoEnvelopeLeak(block.text, `${event.type} partial`);
			}
		}
		if (event.type === "text_delta") {
			assertNoEnvelopeLeak(event.delta, "text_delta.delta");
			const list = deltasByIndex.get(event.contentIndex) ?? [];
			list.push(event.delta);
			deltasByIndex.set(event.contentIndex, list);
		}
		if (event.type === "text_end") {
			// text_end.content is intermediate (pre-done) reporting only; envelope markup must
			// still never appear here even though the authoritative "done" swap may show it.
			assertNoEnvelopeLeak(event.content, "text_end.content");
		}
		if (event.type === "done") finalMessage = event.message;
	}

	return { events, deltasByIndex, finalMessage };
}

describe("text tool-call protocol streaming (live-leak guard)", () => {
	const registrations: Array<{ unregister(): void }> = [];

	afterEach(() => {
		for (const registration of registrations.splice(0)) registration.unregister();
	});

	it("never streams raw envelope markup live and still parses the final call", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 1, max: 2 } });
		registrations.push(registration);
		const tools = [makeTool("echo")];
		const rawText = 'Let me call the tool.\n<pi:call name="echo">{"value":"hi"}</pi:call>\nAll done.';
		registration.setResponses([fauxAssistantMessage(rawText)]);

		const { deltasByIndex, finalMessage } = await drainAndAssertNoLiveLeak(
			stream(registration.getModel(), { systemPrompt: "base", messages: [], tools }, { textToolCallProtocol: true }),
		);

		// Prose before and after the envelope streams live; the envelope's own markup never does.
		const streamedProse = (deltasByIndex.get(0) ?? []).join("");
		expect(streamedProse).toBe("Let me call the tool.\n\nAll done.");

		// The done-event swap is authoritative and unaffected by live buffering: it still carries
		// the surviving prose text block alongside the parsed call, exactly like the non-streaming
		// parseTextToolCalls result.
		const expected = parseTextToolCalls(rawText, tools);
		expect(finalMessage?.stopReason).toBe("toolUse");
		expect(finalMessage?.content).toHaveLength(1 + expected.calls.length);
		expect(finalMessage?.content[0]).toMatchObject({ type: "text", text: expected.text });
		expect(finalMessage?.content.filter((block) => block.type === "toolCall")).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
	});

	it("streams plain prose with no envelope exactly as received", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 1, max: 3 } });
		registrations.push(registration);
		const tools = [makeTool("echo")];
		const rawText = "Just some ordinary prose, no tool call here at all.";
		registration.setResponses([fauxAssistantMessage(rawText)]);

		const { deltasByIndex, finalMessage } = await drainAndAssertNoLiveLeak(
			stream(registration.getModel(), { systemPrompt: "base", messages: [], tools }, { textToolCallProtocol: true }),
		);

		expect((deltasByIndex.get(0) ?? []).join("")).toBe(rawText);
		expect(finalMessage?.content).toMatchObject([{ type: "text", text: rawText }]);
	});

	it("resumes live streaming for prose that follows a closed envelope in the same block", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 1, max: 2 } });
		registrations.push(registration);
		const tools = [makeTool("read"), makeTool("write")];
		const rawText =
			'First <pi:call name="read">{"value":"a"}</pi:call> middle <tool_call>{"name":"write","arguments":{"value":"b"}}</tool_call> last';
		registration.setResponses([fauxAssistantMessage(rawText)]);

		const { deltasByIndex, finalMessage } = await drainAndAssertNoLiveLeak(
			stream(registration.getModel(), { systemPrompt: "base", messages: [], tools }, { textToolCallProtocol: true }),
		);

		// Both envelopes are fully suppressed live; the prose spans before, between, and after
		// them all reach the live view (order preserved, envelope text excluded).
		expect((deltasByIndex.get(0) ?? []).join("")).toBe("First  middle  last");
		expect(finalMessage?.content?.filter((block) => block.type === "toolCall")).toHaveLength(2);
	});

	it("releases a false-positive opener prefix once more text proves it does not match", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 1, max: 1 } });
		registrations.push(registration);
		const tools = [makeTool("echo")];
		// "```typescript" shares a prefix with the fenced-envelope openers but is not one.
		const rawText = "Here is a snippet:\n```typescript\nconst x = 1;\n```\nThat's all.";
		registration.setResponses([fauxAssistantMessage(rawText)]);

		const { deltasByIndex, finalMessage } = await drainAndAssertNoLiveLeak(
			stream(registration.getModel(), { systemPrompt: "base", messages: [], tools }, { textToolCallProtocol: true }),
		);

		expect((deltasByIndex.get(0) ?? []).join("")).toBe(rawText);
		expect(finalMessage?.content).toMatchObject([{ type: "text", text: rawText }]);
	});

	it("leaves a non-text-protocol stream's events byte-untouched", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 1, max: 3 } });
		registrations.push(registration);
		const tools = [makeTool("echo")];
		const rawText = '<pi:call name="echo">{"value":"hi"}</pi:call>';

		registration.setResponses([fauxAssistantMessage(rawText)]);
		const disabledEvents: AssistantMessageEvent[] = [];
		for await (const event of stream(
			registration.getModel(),
			{ systemPrompt: "base", messages: [], tools },
			{ textToolCallProtocol: false },
		)) {
			disabledEvents.push(event);
		}
		const disabledDeltas = disabledEvents
			.filter(
				(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta",
			)
			.map((event) => event.delta)
			.join("");
		expect(disabledDeltas).toBe(rawText);

		registration.setResponses([fauxAssistantMessage(rawText)]);
		const noToolsEvents: AssistantMessageEvent[] = [];
		for await (const event of stream(
			registration.getModel(),
			{ systemPrompt: "base", messages: [], tools: [] },
			{ textToolCallProtocol: true },
		)) {
			noToolsEvents.push(event);
		}
		const noToolsDeltas = noToolsEvents
			.filter(
				(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta",
			)
			.map((event) => event.delta)
			.join("");
		expect(noToolsDeltas).toBe(rawText);
	});
});

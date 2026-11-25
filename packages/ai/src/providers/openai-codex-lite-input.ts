/** Encodes Codex Responses Lite tool namespaces and the accepted input preamble. */
import type { NamespaceTool, ResponseInput, Tool } from "openai/resources/responses/responses.js";
import { freezeOwnedJson, providerInputPrefix, recordProviderInput } from "../history-work.ts";

const codexLiteInputs = new WeakMap<readonly unknown[], { key: string; wire: ResponseInput }>();
const codexLiteMessageInputs = new WeakMap<ResponseInput, ResponseInput>();

/** Lite's tool and instruction items are part of the same signed-off input prefix as its messages. */
export function withCodexLitePreamble(messages: ResponseInput, preamble: ResponseInput): ResponseInput {
	const proof = providerInputPrefix(messages);
	if (!proof) return [...preamble, ...messages];
	const key = JSON.stringify(preamble);
	const prior = proof.previous && codexLiteInputs.get(proof.previous);
	const samePreamble = prior?.key === key;
	const prefix = samePreamble ? prior.wire.slice(0, preamble.length) : preamble;
	for (const item of prefix) freezeOwnedJson(item);
	const wire = prefix.concat(messages);
	Object.freeze(wire);
	recordProviderInput(wire, proof.source, samePreamble ? proof.count + prefix.length : 0, prior?.wire);
	codexLiteInputs.set(messages, { key, wire });
	// Keep the encoder's exact predecessor available while its assembled input is accepted.
	codexLiteMessageInputs.set(wire, messages);
	return wire;
}

export function groupCodexResponsesLiteTools(tools: Tool[]): Tool[] {
	if (tools.length === 0) return [];

	const functions: NamespaceTool.Function[] = tools.map((tool) => {
		if (tool.type !== "function") {
			throw new Error(`Unsupported Responses Lite tool type: ${tool.type}`);
		}
		return tool;
	});

	return [
		{
			type: "namespace",
			name: "functions",
			description: "",
			tools: functions,
		},
	];
}

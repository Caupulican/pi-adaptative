import { type AssistantMessage, createEmptyUsage, type Message } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { detailsWithRuleIds, RuleHookDelivery } from "../src/core/rule-hooks/rule-hook-delivery.ts";
import { sessionCapabilities } from "../src/core/session-standing.ts";

function batch(timestamp: number, ...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "goal", arguments: {} })),
		api: "openai-responses",
		provider: "fixture",
		model: "root",
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

it.each(["add_evidence", "satisfy_requirement"])(
	"delivers the rule with %s and preserves completion preflight",
	(action) => {
		const first = batch(1, "evidence", "finish");
		const messages: Message[] = [first];
		const hooks = new RuleHookDelivery({
			getMessages: () => messages,
			standing: () => sessionCapabilities({ kind: "root" }),
		});
		const collect = (assistantMessage: AssistantMessage, toolCallId: string) =>
			hooks.collect({ toolName: "goal", args: { action }, cwd: ".", assistantMessage, toolCallId });
		const blocks = collect(first, "evidence");
		expect(blocks).toHaveLength(1);
		const rule = blocks[0]!;
		expect(rule.text).toContain("Noticed items are defects");
		const proof: Message = {
			role: "toolResult",
			toolName: "goal",
			toolCallId: "evidence",
			timestamp: 2,
			isError: false,
			details: detailsWithRuleIds({}, [rule.id]),
			content: [{ type: "text", text: rule.text }],
		};
		messages.push(proof);
		expect(hooks.refusalFor("noticed-items", "finish")).toEqual({
			text: `Rule ${rule.id} is delivered with an earlier call of this batch.`,
			ruleIds: [],
		});

		const next = batch(3, "more-evidence", "finish-after-reading");
		messages.push(next);
		expect(collect(next, "more-evidence")).toEqual([]);
		expect(hooks.refusalFor("noticed-items", "finish-after-reading")).toBeUndefined();

		messages.splice(0, messages.length, batch(4, "finish-without-context"));
		expect(hooks.refusalFor("noticed-items", "finish-without-context")).toEqual({
			text: rule.text,
			ruleIds: [rule.id],
		});
	},
);

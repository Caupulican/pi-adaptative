import { describe, expect, it } from "vitest";
import { CacheCustody } from "../src/core/context/cache-custody.ts";
import {
	compareRequestPrefix,
	exactMessageFingerprint,
	exactProviderFingerprint,
	type LaneRequestPrefix,
	messageFingerprint,
} from "../src/core/request-snapshot-fingerprints.ts";
import { advanceMessageContentRevision } from "../src/kernel/message-revision.ts";

function prefix(
	system: unknown,
	tools: unknown,
	messages: readonly unknown[],
	requestOnlyMessageRange: { readonly start: number; readonly count: number },
	boundedSystem = "system",
	boundedTools = "tools",
): LaneRequestPrefix {
	return {
		system: boundedSystem,
		exactSystem: exactProviderFingerprint(system),
		tools: boundedTools,
		exactTools: exactProviderFingerprint(tools),
		reasoning: "reasoning-digest",
		messages: messages.map(messageFingerprint),
		exactMessages: messages.map(exactMessageFingerprint),
		requestOnlyMessageRange,
	};
}

function user(text: string) {
	return { role: "user", content: text };
}

describe("request prefix proof for replaceable request-only projections", () => {
	it("routes only the typed qualification through CacheCustody and retains a false prefix", () => {
		const custody = new CacheCustody();
		const facts = {
			lane: "fixture",
			prefixIntact: false as const,
			requestOnlyProjectionReplacement: true as const,
			firstDivergentKind: "user",
			firstDivergentIndex: 1,
			reasoning: "same",
		};

		expect(custody.classify(facts)).toMatchObject({
			classification: "sanctioned",
			kind: "request-only-projection",
		});
		custody.classify({ lane: "reasoning-drift", prefixIntact: true, reasoning: "same" });
		expect(custody.classify({ ...facts, lane: "reasoning-drift", reasoning: "changed" })).toMatchObject({
			classification: "unsanctioned",
			kind: "user",
		});
		expect(
			custody.classify({ ...facts, lane: "unqualified", requestOnlyProjectionReplacement: undefined }),
		).toMatchObject({ classification: "unsanctioned", kind: "user" });
	});

	it("qualifies a changed projection and ordinary appended history", () => {
		const previous = prefix("system", [], [user("head"), user("knowledge-old"), user("history")], {
			start: 1,
			count: 1,
		});
		const current = prefix("system", [], [user("head"), user("knowledge-new"), user("history"), user("appended")], {
			start: 1,
			count: 1,
		});

		expect(compareRequestPrefix(previous, current, [user("head"), user("knowledge-new")])).toEqual({
			prefixIntact: false,
			firstDivergentIndex: 1,
			firstDivergentKind: "user",
			requestOnlyProjectionReplacement: true,
		});
	});

	it("qualifies removal of a known projection while keeping history aligned", () => {
		const previous = prefix("system", [], [user("head"), user("knowledge"), user("history")], {
			start: 1,
			count: 1,
		});
		const current = prefix("system", [], [user("head"), user("history")], { start: 1, count: 0 });

		expect(
			compareRequestPrefix(previous, current, [user("head"), user("history")]).requestOnlyProjectionReplacement,
		).toBe(true);
	});

	it("keeps ordinary append intact without issuing a projection qualification", () => {
		const previous = prefix("system", [], [user("head"), user("knowledge"), user("history")], {
			start: 1,
			count: 1,
		});
		const current = prefix("system", [], [user("head"), user("knowledge"), user("history"), user("appended")], {
			start: 1,
			count: 1,
		});

		expect(compareRequestPrefix(previous, current, []).prefixIntact).toBe(true);
		expect(compareRequestPrefix(previous, current, []).requestOnlyProjectionReplacement).toBeUndefined();
	});

	it.each([
		"unrelated history edit",
		"system prompt edit",
		"tool surface edit",
		"reasoning edit",
		"shifted projection interval",
	])("does not qualify when there is a simultaneous %s", (reason) => {
		const originalMessages = [user("head"), user("knowledge-old"), user("history")];
		const currentMessages = [user("head"), user("knowledge-new"), user("history")];
		const previous = prefix("system", [], originalMessages, { start: 1, count: 1 });
		let system = "system";
		let tools: unknown = [];
		let range = { start: 1, count: 1 };
		let reasoning = "reasoning-digest";
		if (reason === "unrelated history edit") currentMessages[2] = user("changed history");
		if (reason === "system prompt edit") system = "changed system";
		if (reason === "tool surface edit") tools = [{ name: "changed" }];
		if (reason === "reasoning edit") reasoning = "changed reasoning";
		if (reason === "shifted projection interval") range = { start: 2, count: 1 };
		const current = {
			...prefix(system, tools, currentMessages, range),
			reasoning,
		};

		expect(compareRequestPrefix(previous, current, currentMessages).requestOnlyProjectionReplacement).toBeUndefined();
	});

	it("uses full prompt and message content beyond diagnostic fingerprint windows", () => {
		const oldSystem = `system:${"a".repeat(40_000)}`;
		const newSystem = `${oldSystem.slice(0, -1)}b`;
		const manyBlocks = Array.from({ length: 300 }, (_, index) => ({ type: "text", text: `block-${index}` }));
		const oldMessage = { role: "user", content: manyBlocks };
		const newBlocks = manyBlocks.slice();
		newBlocks[299] = { type: "text", text: "changed tail block" };
		const newMessage = { role: "user", content: newBlocks };
		const previous = prefix(oldSystem, [], [user("head"), user("knowledge-old"), oldMessage], {
			start: 1,
			count: 1,
		});
		const current = prefix(newSystem, [], [user("head"), user("knowledge-new"), newMessage], {
			start: 1,
			count: 1,
		});

		expect(previous.system).toBe(current.system);
		expect(previous.messages[2]).toBe(current.messages[2]);
		expect(compareRequestPrefix(previous, current, []).requestOnlyProjectionReplacement).toBeUndefined();
	});

	it("reports long-tail system and message rewrites without a knowledge change", () => {
		const oldSystem = `system:${"a".repeat(40_000)}`;
		const newSystem = `${oldSystem.slice(0, -1)}b`;
		const blocks = Array.from({ length: 300 }, (_, index) => ({ type: "text", text: `block-${index}` }));
		const oldMessage = { role: "user", content: blocks };
		const changedBlocks = blocks.slice();
		changedBlocks[299] = { type: "text", text: "changed tail block" };
		const newMessage = { role: "user", content: changedBlocks };
		const previous = prefix(oldSystem, [], [oldMessage], { start: 0, count: 0 });
		const messageOnlyCurrent = prefix(oldSystem, [], [newMessage], { start: 0, count: 0 });
		const systemOnlyCurrent = prefix(newSystem, [], [oldMessage], { start: 0, count: 0 });

		expect(previous.system).toBe(systemOnlyCurrent.system);
		expect(previous.messages[0]).toBe(messageOnlyCurrent.messages[0]);
		expect(compareRequestPrefix(previous, messageOnlyCurrent, []).prefixIntact).toBe(false);
		expect(compareRequestPrefix(previous, messageOnlyCurrent, []).firstDivergentIndex).toBe(0);
		expect(compareRequestPrefix(previous, systemOnlyCurrent, []).firstDivergentKind).toBe("system");
	});

	it("preserves provider argument key order and invalidates same-object edits by revision", () => {
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { first: 1, second: 2 } }],
		};
		const before = exactMessageFingerprint(message);
		message.content[0]!.arguments = { second: 2, first: 1 };
		advanceMessageContentRevision(message);
		const after = exactMessageFingerprint(message);

		expect(before).not.toBe(after);
	});

	it("does not qualify knowledge replacement alongside reordered provider arguments", () => {
		const oldCall = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { first: 1, second: 2 } }],
		};
		const reorderedCall = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { second: 2, first: 1 } }],
		};
		const previous = prefix("system", [], [user("head"), user("knowledge-old"), oldCall], {
			start: 1,
			count: 1,
		});
		const current = prefix("system", [], [user("head"), user("knowledge-new"), reorderedCall], {
			start: 1,
			count: 1,
		});

		expect(previous.messages[2]).toBe(current.messages[2]);
		expect(compareRequestPrefix(previous, current, []).requestOnlyProjectionReplacement).toBeUndefined();
	});

	it("rechecks an edited message object after its published content revision", () => {
		const editable = user("before edit") as { role: string; content: string };
		const previous = prefix("system", [], [user("head"), user("knowledge-old"), editable], {
			start: 1,
			count: 1,
		});
		editable.content = "after edit";
		advanceMessageContentRevision(editable);
		const current = prefix("system", [], [user("head"), user("knowledge-new"), editable], {
			start: 1,
			count: 1,
		});

		expect(previous.messages[2]).toBe(current.messages[2]);
		expect(compareRequestPrefix(previous, current, []).requestOnlyProjectionReplacement).toBeUndefined();
	});

	it("fails closed on accessors and oversized proof structures", () => {
		const accessor = Object.defineProperty({}, "unsafe", { enumerable: true, get: () => "value" });
		let hookRead = false;
		const jsonHook = Object.defineProperty({}, "toJSON", {
			get() {
				hookRead = true;
				return () => "value";
			},
		});
		const oversized = Array.from({ length: 100_001 }, () => 0);
		expect(exactProviderFingerprint(accessor)).toBeUndefined();
		expect(exactProviderFingerprint(jsonHook)).toBeUndefined();
		expect(hookRead).toBe(false);
		expect(exactProviderFingerprint(oversized)).toBeUndefined();
	});
});

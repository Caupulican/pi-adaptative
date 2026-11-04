import { dirname } from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { getReadmePath } from "../../config.ts";
import type { AgentMessage } from "../../kernel/index.ts";
import { RULE_IDS_DETAIL_KEY } from "../../kernel/session/message-retention.ts";
import { isRecordObject, isStringArray } from "../util/value-guards.ts";
import { formatRuleHook, loadRuleHooks, RULE_MARKER_PREFIX } from "./rule-hook-catalog.ts";

export interface RuleHookDeliveryDeps {
	/**
	 * The messages the model will actually receive on its next request, read fresh: compaction and branch changes
	 * replace them, and under ICM continuous chat only the running turn's own messages ride the wire (the owner of that
	 * windowing is `continuousChatRequestHistory`), so a rule delivered in an earlier turn is not in context any more.
	 */
	getMessages(): readonly AgentMessage[];
	/** A worker session receives only the rules that are not `rootOnly`. */
	isRootSession(): boolean;
	/** The harness package directory; defaults to the directory of the installed README. */
	packageRoot?: string;
}

/** A finished tool call whose result may gain rule blocks. */
export interface RuleHookDeliveryCall {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly args: unknown;
	readonly cwd: string;
	/** The assistant message that requested the call. */
	readonly assistantMessage: AssistantMessage;
}

/** One rule delivered with a call's result: the text block to append and the id that goes into the result's details. */
export interface RuleHookBlock {
	readonly id: string;
	readonly text: string;
}

/** A refused action that carries a rule: the refusal text, and the ids of the rules it delivers (none for a pointer). */
export interface RuleHookRefusal {
	readonly text: string;
	readonly ruleIds: readonly string[];
}

/**
 * The details of a result that delivered rules: the tool's own details plus the delivered ids under
 * {@link RULE_IDS_DETAIL_KEY}, as an immutable property like the other host-owned details keys. The ids sit in
 * details because that is what survives when the result's text is packed or summarized.
 */
export function detailsWithRuleIds(details: unknown, ruleIds: readonly string[]): Record<string, unknown> {
	const descriptors: PropertyDescriptorMap =
		details && typeof details === "object" ? Object.getOwnPropertyDescriptors(details) : {};
	delete descriptors[RULE_IDS_DETAIL_KEY];
	return Object.defineProperties(
		{},
		{
			...descriptors,
			[RULE_IDS_DETAIL_KEY]: { value: [...ruleIds], enumerable: true, writable: false, configurable: false },
		},
	);
}

/** A rule appended in the batch that is still being executed, before its result lands in the messages. */
interface PendingDelivery {
	readonly toolCallId: string;
	readonly assistantTimestamp: number;
}

/**
 * Delivers rule hooks. When a trigger tool call finishes successfully and its rule is not already in the
 * context, the rule text is returned for the caller to append to that call's result, so it is cached with the
 * prefix like any other history. Nothing blocks and the model makes no decision. A `preflight` rule is asked for
 * by the host check that is about to accept an action (`refusalFor`): that check refuses once, with the rule as
 * the refusal text, and accepts the repeated action.
 *
 * A rule is in the context when a tool result of the messages (a refusal included) lists its id in
 * `details.piRuleIds`, or when it was delivered earlier in the batch that is still running: the results of one assistant message land
 * together, so two trigger calls of one batch would otherwise both find the rule absent. That in-memory set is
 * keyed to the batch (the assistant message and call that delivered), so it needs no invalidation hook. Once
 * the batch has ended its results either carry the ids, and the message scan sees them, or they are gone
 * (compaction or a branch change replaced them), and the rule is delivered again.
 */
export class RuleHookDelivery {
	private readonly deps: RuleHookDeliveryDeps;
	private readonly packageRoot: string;
	private readonly pending = new Map<string, PendingDelivery>();

	constructor(deps: RuleHookDeliveryDeps) {
		this.deps = deps;
		this.packageRoot = deps.packageRoot ?? dirname(getReadmePath());
	}

	/**
	 * The rule blocks to append to the result of a successful call, possibly none; the caller also records their ids
	 * in that result's details ({@link detailsWithRuleIds}). Synchronous end to end:
	 * the check and the pending record cannot interleave with a sibling call's.
	 */
	collect(call: RuleHookDeliveryCall): RuleHookBlock[] {
		const triggered = loadRuleHooks().filter(
			(hook) =>
				hook.trigger.kind === "tool-call" &&
				hook.trigger.tools.includes(call.toolName) &&
				(!hook.rootOnly || this.deps.isRootSession()) &&
				(hook.trigger.matches?.({ ...call, packageRoot: this.packageRoot }) ?? true),
		);
		if (triggered.length === 0) return [];
		const messages = this.deps.getMessages();
		this.forgetEndedBatches(messages);
		const inContext = deliveredRuleIds(messages);
		const blocks: RuleHookBlock[] = [];
		for (const hook of triggered) {
			if (inContext.has(hook.id) || this.pending.has(hook.id)) continue;
			blocks.push({ id: hook.id, text: formatRuleHook(hook, { packageRoot: this.packageRoot }) });
			this.pending.set(hook.id, {
				toolCallId: call.toolCallId,
				assistantTimestamp: call.assistantMessage.timestamp,
			});
		}
		return blocks;
	}

	/**
	 * The refusal for the call `toolCallId` of a `preflight` rule, or undefined when the rule is already
	 * in the context and the check may accept. The first refusal carries the rule and its id (the refused result lists
	 * it in its details) and marks it delivered for the running batch; another such call of that batch refuses with a
	 * pointer to it instead of repeating the rule, and lists no id.
	 */
	refusalFor(topic: string, toolCallId: string): RuleHookRefusal | undefined {
		const hook = loadRuleHooks().find(
			(candidate) => candidate.topic === topic && candidate.trigger.kind === "preflight",
		);
		if (!hook) throw new Error(`Rule hook ${topic} is not a preflight rule.`);
		if (hook.rootOnly && !this.deps.isRootSession()) return undefined;
		const messages = this.deps.getMessages();
		this.forgetEndedBatches(messages);
		if (deliveredRuleIds(messages).has(hook.id)) return undefined;
		// The model issued this call before it could read the rule an earlier call of the batch carries.
		if (this.pending.has(hook.id)) {
			return { text: `Rule ${hook.id} is delivered with an earlier call of this batch.`, ruleIds: [] };
		}
		// The batch is the last assistant message's. A call it did not request cannot be tracked; the message
		// scan alone then dedupes, since the refusal result lands before any repeated call can run.
		const last = messages.findLast((message) => message.role === "assistant");
		if (
			last?.role === "assistant" &&
			last.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
		) {
			this.pending.set(hook.id, { toolCallId, assistantTimestamp: last.timestamp });
		}
		return { text: formatRuleHook(hook, { packageRoot: this.packageRoot }), ruleIds: [hook.id] };
	}

	/** Drops pending deliveries whose batch is no longer the one the last assistant message requested. */
	private forgetEndedBatches(messages: readonly AgentMessage[]): void {
		if (this.pending.size === 0) return;
		const last = messages.findLast((message) => message.role === "assistant");
		for (const [id, delivery] of this.pending) {
			const running =
				last?.role === "assistant" &&
				last.timestamp === delivery.assistantTimestamp &&
				last.content.some((block) => block.type === "toolCall" && block.id === delivery.toolCallId);
			if (!running) this.pending.delete(id);
		}
	}
}

/**
 * Ids of the rules delivered in tool results of `messages`: the ids a result lists in `details.piRuleIds`. A refusal
 * is an error result and counts, since delivering the rule is what it is for. A result with no such list is read as
 * recorded before the ids moved to details, by the `RULE <id>` line its text starts with.
 */
function deliveredRuleIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const recorded = isRecordObject(message.details) ? message.details[RULE_IDS_DETAIL_KEY] : undefined;
		if (isStringArray(recorded)) {
			for (const id of recorded) ids.add(id);
			continue;
		}
		for (const block of message.content) {
			if (block.type !== "text") continue;
			// comms-legacy-decoder: a session recorded before details.piRuleIds carries the id only in the marker line.
			if (!block.text.startsWith(RULE_MARKER_PREFIX)) continue;
			// comms-legacy-decoder: first line of that marker block.
			const lineEnd = block.text.indexOf("\n");
			ids.add(block.text.slice(RULE_MARKER_PREFIX.length, lineEnd < 0 ? undefined : lineEnd));
		}
	}
	return ids;
}

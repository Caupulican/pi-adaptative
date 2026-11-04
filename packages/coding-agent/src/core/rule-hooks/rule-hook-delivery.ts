import { dirname } from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { getReadmePath } from "../../config.ts";
import type { AgentMessage } from "../../kernel/index.ts";
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
 * A rule is in the context when a tool-result text block of the messages (a refusal included) starts with its
 * `RULE <id>` line, or when it was delivered earlier in the batch that is still running: the results of one assistant message land
 * together, so two trigger calls of one batch would otherwise both find the rule absent. That in-memory set is
 * keyed to the batch (the assistant message and call that delivered), so it needs no invalidation hook. Once
 * the batch has ended its results either carry the marker, and the message scan sees it, or they are gone
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
	 * The text blocks to append to the result of a successful call, possibly none. Synchronous end to end:
	 * the check and the pending record cannot interleave with a sibling call's.
	 */
	collect(call: RuleHookDeliveryCall): string[] {
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
		const blocks: string[] = [];
		for (const hook of triggered) {
			if (inContext.has(hook.id) || this.pending.has(hook.id)) continue;
			blocks.push(formatRuleHook(hook, { packageRoot: this.packageRoot }));
			this.pending.set(hook.id, {
				toolCallId: call.toolCallId,
				assistantTimestamp: call.assistantMessage.timestamp,
			});
		}
		return blocks;
	}

	/**
	 * The text for the call `toolCallId` of a `preflight` rule to refuse with, or undefined when the rule is already
	 * in the context and the check may accept. The first refusal carries the rule and marks it delivered for the
	 * running batch; another such call of that batch refuses with a pointer to it instead of repeating the rule.
	 */
	refusalFor(topic: string, toolCallId: string): string | undefined {
		const hook = loadRuleHooks().find(
			(candidate) => candidate.topic === topic && candidate.trigger.kind === "preflight",
		);
		if (!hook) throw new Error(`Rule hook ${topic} is not a preflight rule.`);
		if (hook.rootOnly && !this.deps.isRootSession()) return undefined;
		const messages = this.deps.getMessages();
		this.forgetEndedBatches(messages);
		if (deliveredRuleIds(messages).has(hook.id)) return undefined;
		// The model issued this call before it could read the rule an earlier call of the batch carries.
		if (this.pending.has(hook.id)) return `Rule ${hook.id} is delivered with an earlier call of this batch.`;
		// The batch is the last assistant message's. A call it did not request cannot be tracked; the message
		// scan alone then dedupes, since the refusal result lands before any repeated call can run.
		const last = messages.findLast((message) => message.role === "assistant");
		if (
			last?.role === "assistant" &&
			last.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
		) {
			this.pending.set(hook.id, { toolCallId, assistantTimestamp: last.timestamp });
		}
		return formatRuleHook(hook, { packageRoot: this.packageRoot });
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
 * Ids of the rules delivered in tool results of `messages`: a text block whose first line is exactly `RULE <id>`.
 * A refusal is an error result and counts, since delivering the rule is what it is for.
 */
function deliveredRuleIds(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			if (!block.text.startsWith(RULE_MARKER_PREFIX)) continue;
			const lineEnd = block.text.indexOf("\n");
			ids.add(block.text.slice(RULE_MARKER_PREFIX.length, lineEnd < 0 ? undefined : lineEnd));
		}
	}
	return ids;
}

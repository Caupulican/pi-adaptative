/**
 * Runs extension context handlers over the provider projection and restores every host transient record an extension rewrote or
 * dropped. A host record is a transient record the harness wrote: reconciliation reads its content and `details` to decide whether
 * the record is still on the wire, so a handler's edit to either is reverted, not marked. A handler may not add a message the
 * harness owns (a host record, or a message under the custom type of one), in the request messages or in its transient messages;
 * such a message is refused. The binding owns the log state: each action and kind is logged once per session.
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import { TOOL_FAILURE_LEDGER_TRANSIENT_KIND } from "../../kernel/tool-failure-memory.ts";
import { classifyTransientRecord } from "../../kernel/transient-records.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { VERIFICATION_OBLIGATION_TRANSIENT_KIND } from "../../kernel/verification-obligations.ts";
import { isHostReservedCustomType, isUnchangedCustomMessage } from "../turn-origin.ts";
import type { ExtensionRunner } from "./runner.ts";

/** What the memory controller supplies to a bound projection: its memory generation and its provider-visibility filter. */
export interface ExtensionContextBinding {
	generation(): number;
	filter(messages: AgentMessage[]): AgentMessage[];
}

type GuardReport = (action: "restored" | "refused", kind: string) => void;

const REPORT_MESSAGES = {
	restored: "a context handler rewrote or dropped a host record; the host's record was restored",
	refused: "a context handler returned a message under a host-owned record type; the message was refused",
} as const;

/** The custom type of a harness transient record (one the reconciliation reader classifies as transient), else undefined. */
function hostRecordKind(message: AgentMessage): string | undefined {
	return message.role === "custom" && classifyTransientRecord(message.content, message.details).transient
		? message.customType
		: undefined;
}

const PLANNER_TRANSIENT_KINDS: ReadonlySet<string> = new Set([
	TOOL_FAILURE_LEDGER_TRANSIENT_KIND,
	VERIFICATION_OBLIGATION_TRANSIENT_KIND,
]);

/**
 * The custom type of a message the harness owns, else undefined: a host record, a custom message under the type of one, a
 * type the host reserves (extension context output is not checked by the write-path refusal) or a planner transient kind.
 */
function hostOwnedKind(message: AgentMessage, hostKinds: ReadonlySet<string>): string | undefined {
	if (message.role !== "custom") return undefined;
	const owned =
		hostKinds.has(message.customType) ||
		hostRecordKind(message) !== undefined ||
		isHostReservedCustomType(message.customType) ||
		PLANNER_TRANSIENT_KINDS.has(message.customType);
	return owned ? message.customType : undefined;
}

function hostRecordKinds(messages: readonly AgentMessage[]): Set<string> {
	const kinds = new Set<string>();
	for (const message of messages) {
		const kind = hostRecordKind(message);
		if (kind !== undefined) kinds.add(kind);
	}
	return kinds;
}

/** The key a handler's output pairs on: role, custom type and timestamp (content-derived for host records, so it survives cloning). */
function pairingKey(message: AgentMessage): string {
	return message.role === "custom"
		? `custom\u0000${message.customType}\u0000${message.timestamp}`
		: `${message.role}\u0000${message.timestamp}`;
}

function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

/**
 * The handler's messages with every host record restored. Each input message claims the first unclaimed output message with its key,
 * so the handler's own additions keep their place. A claimed host record the handler left unchanged stays as returned; one it changed
 * is replaced by the original. A host record the handler dropped returns right after its nearest preceding input message that
 * survived, or at the head when none did. A message the handler added that the harness owns is refused.
 */
function restoreHostRecords(
	input: readonly AgentMessage[],
	output: readonly AgentMessage[],
	hostKinds: ReadonlySet<string>,
	report: GuardReport,
): AgentMessage[] {
	const claimable = new Map<string, number[]>();
	for (const [index, message] of output.entries()) appendTo(claimable, pairingKey(message), index);
	const survivors = input.map((message) => ({ message, index: claimable.get(pairingKey(message))?.shift() }));
	const inputOf = new Map<number, AgentMessage>();
	for (const { message, index } of survivors) if (index !== undefined) inputOf.set(index, message);

	// Keyed by the output index of the anchoring survivor; -1 is the head.
	const returnAfter = new Map<number, AgentMessage[]>();
	let anchor = -1;
	for (const { message, index } of survivors) {
		if (index !== undefined) {
			anchor = index;
			continue;
		}
		const kind = hostRecordKind(message);
		if (kind === undefined) continue;
		report("restored", kind);
		appendTo(returnAfter, anchor, message);
	}

	const result: AgentMessage[] = [...(returnAfter.get(-1) ?? [])];
	output.forEach((message, index) => {
		const original = inputOf.get(index);
		if (original === undefined) {
			const owned = hostOwnedKind(message, hostKinds);
			if (owned === undefined) result.push(message);
			else report("refused", owned);
		} else {
			const kind = hostRecordKind(original);
			if (kind !== undefined && !isUnchangedCustomMessage(original, message)) {
				report("restored", kind);
				result.push(original);
			} else {
				result.push(message);
			}
		}
		result.push(...(returnAfter.get(index) ?? []));
	});
	return result;
}

/** The handler's transient messages without the ones the harness owns: each becomes a reconciliation slot under its custom type. */
function refuseHostOwnedTransients(
	transients: readonly AgentMessage[],
	hostKinds: ReadonlySet<string>,
	report: GuardReport,
): AgentMessage[] {
	return transients.filter((message) => {
		const owned = hostOwnedKind(message, hostKinds);
		if (owned === undefined) return true;
		report("refused", owned);
		return false;
	});
}

async function runContextHandlers(
	runner: ExtensionRunner,
	filtered: AgentMessage[],
	report: GuardReport,
): Promise<{ messages: AgentMessage[]; transientMessages: AgentMessage[] }> {
	const plan = await runner.emitContext(filtered);
	const hostKinds = hostRecordKinds(filtered);
	return {
		messages: restoreHostRecords(filtered, plan.messages, hostKinds, report),
		transientMessages: refuseHostOwnedTransients(plan.transientMessages, hostKinds, report),
	};
}

/**
 * Binds the extension context projection to one memory controller: the function the provider request planner calls on every request.
 * It applies the binding's visibility filter before and after the handlers, and the handlers' output passes the host-record guard.
 */
export function bindExtensionContextProjection(getRunner: () => ExtensionRunner, binding: ExtensionContextBinding) {
	const reported = new Set<string>();
	const report: GuardReport = (action, kind) => {
		const key = `${action}\u0000${kind}`;
		if (reported.has(key)) return;
		reported.add(key);
		harnessLog.warn("extensions", REPORT_MESSAGES[action], { actor: "context handler", kind });
	};
	return async (messages: AgentMessage[]) => {
		const runner = getRunner();
		const generation = binding.generation();
		const filtered = binding.filter(messages);
		const projection = runner.hasHandlers("context")
			? await runContextHandlers(runner, filtered, report)
			: { messages: filtered, transientMessages: [] as AgentMessage[] };
		return {
			messages: binding.filter(projection.messages),
			transientMessages: binding.filter(projection.transientMessages),
			isCurrent: () => getRunner() === runner && binding.generation() === generation,
		};
	};
}

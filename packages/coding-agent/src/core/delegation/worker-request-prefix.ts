/** Re-anchors a worker's carried request marks to its authenticated request scope and current transcript branch. */

import type { Api, Model } from "@caupulican/pi-ai";
import { countHistoryWork, historyWorkFallback } from "@caupulican/pi-ai/history-work";
import type { AgentContext, ProviderRequestPrefixState } from "../../kernel/loop-config.ts";
import {
	MessageHistoryMirror,
	type MessageHistoryVersion,
	messageContentEpoch,
	messageContentRevision,
	messageHistoryVersion,
	unchangedMessagePrefix,
} from "../../kernel/message-revision.ts";
import { convertMessage } from "../../kernel/messages.ts";
import { projectToolsForProvider } from "../../kernel/provider-tool-projection.ts";
import { stringifySessionJson } from "../../kernel/session/session-json.ts";
import { createToolFailureContextMemory } from "../../kernel/tool-failure-memory.ts";
import { ToolFailureRecoveryHistory } from "../../kernel/tool-failure-recovery-gate.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { VerificationHistory } from "../../kernel/verification-obligations.ts";
import { exactToolsFingerprint } from "../request-snapshot-fingerprints.ts";

interface WorkerPrefixScope {
	readonly accountKey: string;
	readonly provider: string;
	readonly api: Api;
	readonly modelId: string;
	readonly baseUrl: string;
	readonly systemPrompt: string;
	readonly tools: string;
}

function scopeFor(
	model: Model<Api>,
	accountKey: string | undefined,
	context: AgentContext,
): WorkerPrefixScope | undefined {
	if (!accountKey) return undefined;
	let tools: string | undefined;
	try {
		tools = exactToolsFingerprint(projectToolsForProvider(context.tools) ?? []);
	} catch {
		return undefined;
	}
	if (!tools) return undefined;
	return {
		accountKey,
		provider: model.provider,
		api: model.api,
		modelId: model.id,
		baseUrl: model.baseUrl,
		systemPrompt: context.systemPrompt,
		tools,
	};
}

function sameScope(previous: WorkerPrefixScope | undefined, current: WorkerPrefixScope | undefined): boolean {
	return (
		previous !== undefined &&
		current !== undefined &&
		previous.accountKey === current.accountKey &&
		previous.provider === current.provider &&
		previous.api === current.api &&
		previous.modelId === current.modelId &&
		previous.baseUrl === current.baseUrl &&
		previous.systemPrompt === current.systemPrompt &&
		previous.tools === current.tools
	);
}

/** Compare the rendered body and the source role/custom identity the carried marks index. */
function providerView(message: AgentMessage | undefined): string | undefined {
	if (!message) return undefined;
	const rendered = convertMessage(message);
	if (!rendered) return undefined;
	return stringifySessionJson([
		message.role,
		message.role === "custom" ? message.customType : undefined,
		rendered.content,
		rendered.role === "toolResult" ? rendered.toolCallId : undefined,
		rendered.role === "toolResult" ? rendered.toolName : undefined,
		rendered.role === "toolResult" ? rendered.isError : undefined,
	]);
}

function readProviderView(history: readonly AgentMessage[], message: AgentMessage | undefined): string | undefined {
	countHistoryWork(history, "oldRowsRead");
	try {
		const view = providerView(message);
		if (view !== undefined) countHistoryWork(history, "oldBytesRecompressed", Buffer.byteLength(view));
		return view;
	} catch {
		// A foreign message can contain unusual getters or an unserializable body.
		return undefined;
	}
}

function branchCurrent(assertBranch: (() => void) | undefined): boolean {
	try {
		if (!assertBranch) return false;
		assertBranch();
		return true;
	} catch {
		return false;
	}
}

export class WorkerRequestPrefix {
	readonly state: ProviderRequestPrefixState = {
		sentPrefixCount: 0,
		sanitizerSentPrefixCount: 0,
		sanitizerMemory: createToolFailureContextMemory(),
		reconcileRequestScope: (model, accountKey, context) => this.reconcileScope(model, accountKey, context),
		acceptSource: (messages) => this.acceptSource(messages),
	};
	readonly historyState = {
		workingHistory: new MessageHistoryMirror(),
		toolFailureRecoveryHistory: new ToolFailureRecoveryHistory(),
		verificationHistory: new VerificationHistory(),
	};
	private acceptedStable:
		| {
				rows: readonly AgentMessage[];
				length: number;
				version: MessageHistoryVersion;
		  }
		| undefined;
	/** Snapshot the accepted mutable suffix before edits can change the comparison baseline. */
	private acceptedSuffix: { message: AgentMessage; view: string | undefined }[] = [];
	private acceptedEpoch = 0;
	private scope: WorkerPrefixScope | undefined;
	private assertBranch: (() => void) | undefined;
	private runHistory: readonly AgentMessage[] | undefined;
	private runHistoryVersion: MessageHistoryVersion | undefined;
	private startingRun = false;

	acceptSource(messages: readonly AgentMessage[]): void {
		if (!this.scope || !branchCurrent(this.assertBranch)) return;
		const canonical = this.runHistory;
		const before = this.runHistoryVersion;
		const after = canonical ? messageHistoryVersion(messages, canonical.length) : undefined;
		const stableLength = before && after ? unchangedMessagePrefix(before, after) : 0;
		const stableVersion = stableLength > 0 ? messageHistoryVersion(messages, stableLength) : undefined;
		this.acceptedStable =
			canonical && stableVersion ? { rows: canonical, length: stableLength, version: stableVersion } : undefined;
		this.acceptedSuffix = [];
		for (let index = stableLength; index < messages.length; index++) {
			const message = messages[index]!;
			this.acceptedSuffix.push({ message, view: readProviderView(messages, message) });
			countHistoryWork(messages, "copiedRows");
		}
		this.acceptedEpoch = messageContentEpoch();
	}

	beginRun(assertBranch: () => void, canonical?: readonly AgentMessage[]): this {
		if (!branchCurrent(this.assertBranch)) this.reset();
		this.assertBranch = assertBranch;
		this.runHistory = canonical;
		this.runHistoryVersion = undefined;
		this.startingRun = true;
		return this;
	}

	private reconcileScope(model: Model<Api>, accountKey: string | undefined, context: AgentContext): void {
		const scope = branchCurrent(this.assertBranch) ? scopeFor(model, accountKey, context) : undefined;
		if (!sameScope(this.scope, scope)) this.reset();
		else if (this.startingRun) this.reanchor(context.messages);
		if (this.startingRun && this.runHistory && context.messages === this.historyState.workingHistory.messages) {
			this.runHistoryVersion = messageHistoryVersion(context.messages, this.runHistory.length);
		}
		this.scope = scope;
		this.startingRun = false;
	}

	private reanchor(history: readonly AgentMessage[]): void {
		const { state } = this;
		const mark = Math.max(state.sentPrefixCount, state.sanitizerSentPrefixCount);
		const acceptedStable = this.acceptedStable;
		const stableLength = acceptedStable?.length ?? 0;
		const length = Math.min(mark, stableLength + this.acceptedSuffix.length, history.length);
		const canonical = this.runHistory;
		const current =
			canonical && history === this.historyState.workingHistory.messages
				? messageHistoryVersion(history, Math.min(history.length, canonical.length))
				: undefined;
		let shared =
			acceptedStable && current ? Math.min(length, unchangedMessagePrefix(acceptedStable.version, current)) : 0;
		if (shared < Math.min(length, stableLength) || (!current && length > 0)) {
			historyWorkFallback(history, "worker-history-unproven");
		}
		while (shared < length) {
			const stable = shared < stableLength;
			const suffix = stable ? undefined : this.acceptedSuffix[shared - stableLength];
			const accepted = stable ? acceptedStable?.rows[shared] : suffix?.message;
			if (!accepted || messageContentRevision(accepted) > this.acceptedEpoch) break;
			const previous = readProviderView(history, accepted);
			if (
				previous === undefined ||
				(suffix && previous !== suffix.view) ||
				previous !== readProviderView(history, history[shared])
			)
				break;
			shared++;
		}
		if (state.sentPrefixCount > shared) state.sentPrefixCount = shared;
		if (state.sanitizerSentPrefixCount > shared) {
			state.sanitizerSentPrefixCount = shared;
			state.sanitizerMemory = createToolFailureContextMemory();
		}
	}

	private reset(): void {
		this.scope = undefined;
		this.acceptedStable = undefined;
		this.acceptedSuffix = [];
		this.state.sentPrefixCount = 0;
		this.state.sanitizerSentPrefixCount = 0;
		this.state.sanitizerMemory = createToolFailureContextMemory();
	}
}

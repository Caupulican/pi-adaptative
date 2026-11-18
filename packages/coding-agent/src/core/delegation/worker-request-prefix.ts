/** Re-anchors a worker's carried request marks to its authenticated request scope and current transcript branch. */

import type { Api, Model } from "@caupulican/pi-ai";
import type { AgentContext, ProviderRequestPrefixState } from "../../kernel/loop-config.ts";
import { messageContentEpoch, messageContentRevision } from "../../kernel/message-revision.ts";
import { convertMessage } from "../../kernel/messages.ts";
import { projectToolsForProvider } from "../../kernel/provider-tool-projection.ts";
import { stringifySessionJson } from "../../kernel/session/session-json.ts";
import { createToolFailureContextMemory } from "../../kernel/tool-failure-memory.ts";
import type { AgentMessage } from "../../kernel/types.ts";
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
	};
	/** The last accepted source extent; message objects can still be edited in place. */
	private source: readonly AgentMessage[] = [];
	private acceptedEpoch = 0;
	private scope: WorkerPrefixScope | undefined;
	private assertBranch: (() => void) | undefined;
	private startingRun = false;

	acceptSource(messages: readonly AgentMessage[]): void {
		this.source = messages;
		this.acceptedEpoch = messageContentEpoch();
	}

	beginRun(assertBranch: () => void): this {
		if (!branchCurrent(this.assertBranch)) this.reset();
		this.assertBranch = assertBranch;
		this.startingRun = true;
		return this;
	}

	private reconcileScope(model: Model<Api>, accountKey: string | undefined, context: AgentContext): void {
		const scope = branchCurrent(this.assertBranch) ? scopeFor(model, accountKey, context) : undefined;
		if (!sameScope(this.scope, scope)) this.reset();
		else if (this.startingRun) this.reanchor(context.messages);
		this.scope = scope;
		this.startingRun = false;
	}

	private reanchor(history: readonly AgentMessage[]): void {
		const { state } = this;
		const source = this.source;
		const mark = Math.max(state.sentPrefixCount, state.sanitizerSentPrefixCount);
		const length = Math.min(mark, source.length, history.length);
		let shared = 0;
		while (shared < length) {
			const accepted = source[shared];
			if (!accepted || messageContentRevision(accepted) > this.acceptedEpoch) break;
			const previous = providerView(accepted);
			if (previous === undefined || previous !== providerView(history[shared])) break;
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
		this.source = [];
		this.state.sentPrefixCount = 0;
		this.state.sanitizerSentPrefixCount = 0;
		this.state.sanitizerMemory = createToolFailureContextMemory();
	}
}

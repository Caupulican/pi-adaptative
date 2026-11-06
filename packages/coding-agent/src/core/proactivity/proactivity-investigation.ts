import type { Api, Context, Message, Model } from "@caupulican/pi-ai";
import { resolveModelCost } from "@caupulican/pi-ai/usage";
import {
	type AgentLoopConfig,
	type AgentTool,
	AgentToolPolicyDeniedError,
	type AgentToolResult,
} from "../../kernel/index.ts";
import type { RequestPreflightContext } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { createLaneToolSurface, type LaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import { affordableOutputTokenLimit } from "../cost-guard.ts";
import { LaneMemoryCapacityTracker } from "../delegation/lane-memory-capacity.ts";
import type { MemoryReadReceipt, WorkerMemoryReadOptions } from "../memory/worker-memory-tools.ts";
import { usageDeltaFromProviderUsage } from "../orchestration/attempt-usage.ts";
import {
	createReadOperationFactory,
	LOCAL_READ_DEADLINE_MS,
	type ReadOperationFactory,
	type ReadSourceReceipt,
	readDigest,
} from "../tools/read-operation-context.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { type ProactivityInvestigationHost, ProactivityReadAuthority } from "./proactivity-read-authority.ts";
import { RAISE_NOTE_TOOL_NAME } from "./proactivity-review.ts";

const MAX_READ_ATTEMPTS = 3;
const MAX_RESULT_BYTES = 8 * 1024;
const MAX_TOTAL_RESULT_BYTES = 16 * 1024;
const NOTE_RESULT_RESERVE_BYTES = 512;

interface InvestigationOptions {
	model: Model<Api>;
	maxOutputTokens: number;
	signal: AbortSignal;
	assertCurrent(): void;
	isNoteRaised(): boolean;
}

interface InvestigationEvidence {
	readonly id: string;
	readonly tool: string;
	readonly sourceDigest: string;
	readonly deliveredDigest: string;
	readonly complete: boolean;
	readonly sources: readonly { readonly ref: string; readonly revision: string }[];
	readonly observedAt: number;
	readonly workClass: "metered-source-io" | "native-process" | "native-memory";
}

interface CapturedRead {
	readonly callId: string;
	readonly description: InvestigationEvidence;
	readonly receipt: ReadSourceReceipt | MemoryReadReceipt;
}

/** One review's read attempts, source receipts, text allowance and adoption checks. */
export class ProactivityInvestigation {
	readonly tools: AgentTool[];
	readonly beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
	private readonly authority: ProactivityReadAuthority;
	private readonly surface: LaneToolSurface;
	private readonly capacity: LaneMemoryCapacityTracker;
	private readonly options: InvestigationOptions;
	private readonly attempts = new Map<string, { tool: string; ordinal: number; executed: boolean }>();
	private readonly verifiedSources = new Set<string>();
	private readonly receipts = new Map<string, ReadSourceReceipt | MemoryReadReceipt>();
	private readonly evidence: CapturedRead[] = [];
	private readonly visibleEvidence = new Set<string>();
	private readonly projected = new Set<string>();
	private readonly received = new Set<string>();
	private totalBytes = 0;
	private failure: Error | undefined;
	private closed = false;
	private ioDeadline: number | undefined;
	private readFactory: ReadOperationFactory | undefined;

	constructor(host: ProactivityInvestigationHost, options: InvestigationOptions) {
		this.options = options;
		this.authority = new ProactivityReadAuthority(host);
		this.capacity = new LaneMemoryCapacityTracker({
			model: options.model,
			compactionReserveTokens: 0,
			maxOutputTokens: options.maxOutputTokens,
			remainingTokenAllowance: () => this.surface.gateway?.remainingTokenBudget(),
		});
		const isCurrent = (): boolean => {
			try {
				this.assertContext();
				return true;
			} catch {
				return false;
			}
		};
		const readOperation: ReadOperationFactory = (tool, callId, signal) => {
			this.readFactory ??= createReadOperationFactory({
				signal: options.signal,
				deadlineAt: this.readDeadline(),
				isCurrent,
				authorizePath: async (path) => this.authority.authorizePath(path),
				authorizeSubtree: async (path) => this.authority.authorizePath(path, true),
				observe: (receipt) => this.captureReceipt(receipt.toolCallId, receipt),
			});
			return this.readFactory(tool, callId, signal);
		};
		const shared = host.getSharedLaneToolOptions?.();
		this.surface = createLaneToolSurface({
			cwd: this.authority.cwd,
			readOnly: true,
			grant: this.authority.grant,
			toolManifests: this.authority.manifests,
			deniedPaths: this.authority.grant.deniedPaths,
			memoryBroker: this.authority.manifests.some((manifest) => manifest.capabilities.includes("memory.query"))
				? host.createLaneMemoryBroker(this.capacity.source)
				: undefined,
			memoryReadOptions: (callId): WorkerMemoryReadOptions => ({
				signal: options.signal,
				deadlineAt: this.readDeadline(),
				admission: "native-only",
				maxImageBytes: 0,
				observe: (receipt) => this.captureReceipt(callId, receipt),
			}),
			sharedToolOptions: {
				read: { fileEncodings: shared?.read?.fileEncodings, readOperation },
				grep: { readOperation },
				find: { readOperation },
				ls: { readOperation },
				repoRead: { readOperation },
			},
			checkEdge: async (tool, args, cwd) => {
				await host.settleOwnerPolicy?.();
				this.assertHealthy();
				// The owner's own review, on read tools only, carries no third party's words of its own.
				return host.checkOperation?.(tool, args, cwd, false);
			},
			bindTool: (tool) =>
				wrapToolExecution(tool, (executor) => ({
					...executor,
					execute: async (callId, args, signal, onUpdate) => {
						this.assertHealthy();
						const attempt = this.attempts.get(callId) ?? this.registerAttempt(callId, tool.name);
						if (
							attempt.tool !== tool.name ||
							attempt.executed ||
							attempt.ordinal > MAX_READ_ATTEMPTS ||
							options.isNoteRaised()
						)
							throw new AgentToolPolicyDeniedError("This review's read allowance is closed.");
						attempt.executed = true;
						const result = await executor.execute(callId, args, signal, onUpdate);
						this.assertHealthy();
						if (result.content.some((part) => part.type !== "text"))
							throw new Error("Proactive reads require text-only evidence.");
						const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
						const receipt = this.receipts.get(callId);
						const sourceDigest = readDigest(text);
						if (
							receipt &&
							sourceDigest !== ("resultDigest" in receipt ? receipt.resultDigest : receipt.textDigest)
						) {
							this.failure = new Error("Proactive source receipt does not match its delivered text.");
							throw this.failure;
						}
						if (receipt) this.verifiedSources.add(callId);
						return result;
					},
				})),
		});
		this.tools = this.surface.tools.map((tool) =>
			wrapToolExecution(tool, (executor) => ({
				...executor,
				execute: async (callId, args, signal, onUpdate) => {
					const result = await executor.execute(callId, args, signal, onUpdate);
					return this.projectResult(callId, tool.name, result);
				},
			})),
		);
		this.beforeToolCall = async (context, signal) => {
			this.assertHealthy();
			if (context.toolCall.name === RAISE_NOTE_TOOL_NAME) return undefined;
			const attempt =
				this.attempts.get(context.toolCall.id) ?? this.registerAttempt(context.toolCall.id, context.toolCall.name);
			if (attempt.ordinal > MAX_READ_ATTEMPTS || options.isNoteRaised())
				return { block: true, reason: "This review's read allowance is closed." };
			return this.surface.beforeToolCall(context, signal);
		};
	}

	private projectResult(callId: string, toolName: string, result: AgentToolResult<unknown>): AgentToolResult<unknown> {
		this.assertHealthy();
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const receipt = this.receipts.get(callId);
		const sourceDigest = receipt
			? "resultDigest" in receipt
				? receipt.resultDigest
				: receipt.textDigest
			: readDigest(text);
		const usable =
			receipt &&
			this.verifiedSources.has(callId) &&
			!("disposition" in receipt && receipt.disposition !== "read") &&
			!result.isError;
		const id = `e${this.evidence.length + 1}`;
		const complete = usable && ("coverage" in receipt ? receipt.coverage === "complete" : receipt.complete);
		const prefix = usable
			? `[Evidence ${id}; source observation; check scope and truncation]\n`
			: "[No usable source evidence]\n";
		const limit = Math.min(MAX_RESULT_BYTES, MAX_TOTAL_RESULT_BYTES - NOTE_RESULT_RESERVE_BYTES - this.totalBytes);
		if (limit <= Buffer.byteLength(prefix) + 80) throw new Error("Proactive result text allowance is exhausted.");
		const bodyLimit = limit - Buffer.byteLength(prefix);
		const bytes = Buffer.from(text);
		const clipped = bytes.length > bodyLimit;
		const suffix = clipped ? "\n[Partial result: text limit reached]" : "";
		const body = clipped
			? new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bodyLimit - Buffer.byteLength(suffix)), {
					stream: true,
				})
			: text;
		const delivered = prefix + body + suffix;
		this.totalBytes += Buffer.byteLength(delivered);
		this.projected.add(callId);
		if (usable)
			this.evidence.push({
				callId,
				receipt,
				description: Object.freeze({
					id,
					tool: toolName,
					sourceDigest,
					deliveredDigest: readDigest(delivered),
					complete: complete === true && !clipped && readDigest(text) === sourceDigest,
					sources: Object.freeze(
						"sourceRef" in receipt
							? [Object.freeze({ ref: receipt.sourceRef, revision: receipt.resultDigest })]
							: receipt.sources,
					),
					observedAt: "observedAt" in receipt ? receipt.observedAt : Date.now(),
					workClass: "workClass" in receipt ? receipt.workClass : "native-memory",
				}),
			});
		return { ...result, content: [{ type: "text", text: delivered }] };
	}

	private registerAttempt(id: string, tool: string) {
		const attempt = { tool, ordinal: this.attempts.size + 1, executed: false };
		this.attempts.set(id, attempt);
		return attempt;
	}

	private readDeadline(): number {
		this.ioDeadline ??= Date.now() + LOCAL_READ_DEADLINE_MS;
		return this.ioDeadline;
	}

	private captureReceipt(callId: string, receipt: ReadSourceReceipt | MemoryReadReceipt): void {
		if (this.receipts.has(callId)) throw new Error("A proactive read issued duplicate source receipts.");
		this.assertHealthy();
		this.receipts.set(callId, receipt);
	}

	onMessage(message: Message): void {
		this.assertHealthy();
		if (message.role === "assistant") {
			this.surface.gateway?.recordUsage(usageDeltaFromProviderUsage(message.usage));
			for (const part of message.content)
				if (part.type === "toolCall" && part.name !== RAISE_NOTE_TOOL_NAME) {
					if (this.attempts.has(part.id)) throw new Error("A proactive read repeated an invocation identity.");
					this.registerAttempt(part.id, part.name);
				}
		} else if (message.role === "toolResult") {
			if (this.received.has(message.toolCallId)) throw new Error("A proactive tool result was delivered twice.");
			this.received.add(message.toolCallId);
			const captured = this.evidence.find((entry) => entry.callId === message.toolCallId);
			if (
				captured &&
				readDigest(message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")) !==
					captured.description.deliveredDigest
			)
				throw new Error("Proactive evidence changed after final result projection.");
			const bytes = message.content.reduce(
				(sum, part) => sum + (part.type === "text" ? Buffer.byteLength(part.text) : MAX_RESULT_BYTES + 1),
				0,
			);
			if (!this.projected.has(message.toolCallId)) this.totalBytes += bytes;
			if (bytes > MAX_RESULT_BYTES || this.totalBytes > MAX_TOTAL_RESULT_BYTES)
				throw new Error("Proactive tool results exceed the text allowance.");
		}
	}

	noteRequest(context: Context): void {
		this.capacity.noteRequestAccepted(context);
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			const captured = this.evidence.find((entry) => entry.callId === message.toolCallId);
			if (
				captured &&
				readDigest(message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")) ===
					captured.description.deliveredDigest
			)
				this.visibleEvidence.add(captured.description.id);
		}
	}

	preflight(request: RequestPreflightContext): { maxTokens: number } {
		this.assertHealthy();
		this.surface.gateway?.assertBudgetAvailable();
		const remaining = this.surface.gateway?.remainingTokenBudget();
		const inputTokens = estimateProviderRequestTokens(request.context, request.model);
		let maxTokens = Math.min(
			request.maxTokens ?? request.model.maxTokens,
			remaining === undefined ? Infinity : remaining - inputTokens,
		);
		const maxCostUsd = this.authority.grant.budget.maxCostUsd;
		if (maxCostUsd !== undefined)
			maxTokens = affordableOutputTokenLimit({
				inputTokens,
				maxOutputTokens: maxTokens,
				cost: resolveModelCost(request.model, inputTokens),
				remainingUsd: Math.max(0, maxCostUsd - (this.surface.gateway?.getUsage().costUsd ?? 0)),
			});
		if (maxTokens < 1) throw new Error("Proactive request exceeds its inherited token allowance.");
		return { maxTokens };
	}

	private assertContext(): void {
		this.options.signal.throwIfAborted();
		this.options.assertCurrent();
		this.authority.assertCurrent();
		if (this.closed) throw new Error("Proactive investigation is closed.");
		if (this.failure) throw this.failure;
		this.surface?.assertHealthy();
	}

	assertHealthy(): void {
		this.assertContext();
		if (this.ioDeadline !== undefined && Date.now() >= this.ioDeadline)
			throw new Error("Proactive read deadline expired before adoption.");
		if (this.evidence.some(({ receipt }) => !receipt.isCurrent()))
			throw new Error("Proactive source authority changed.");
	}

	validateEvidenceForNote(ids: readonly string[]): void {
		this.assertHealthy();
		if ((this.evidence.length > 0 && ids.length === 0) || ids.some((id) => !this.visibleEvidence.has(id)))
			throw new Error("A note after investigation must cite source evidence already delivered to the model.");
	}

	async revalidate(): Promise<void> {
		this.assertHealthy();
		for (const { receipt } of this.evidence) {
			const valid =
				"resultDigest" in receipt
					? await receipt.revalidate(this.options.signal)
					: await receipt.revalidate({
							signal: this.options.signal,
							deadlineAt: this.readDeadline(),
							admission: "native-only",
						});
			if (!valid) throw new Error("Proactive source evidence changed before delivery.");
			this.assertHealthy();
		}
	}

	evidenceDetails(): readonly InvestigationEvidence[] {
		return this.evidence.map((entry) => entry.description);
	}

	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.surface.dispose();
	}
}

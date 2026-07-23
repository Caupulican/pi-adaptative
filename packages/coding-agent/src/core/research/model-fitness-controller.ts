import { createHash } from "node:crypto";
import type { Usage } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session.ts";
import { FitnessStore, type StoredFitnessReport } from "../models/fitness-store.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { LaneModelResolver } from "./lane-model-resolver.ts";
import { type ModelFitnessReport, runModelFitnessProbe } from "./model-fitness.ts";

export interface ModelFitnessControllerDeps {
	isDisposed(): boolean;
	getSessionId(): string;
	getAgentDir(): string;
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
}

function deriveSpawnedUsageReportId(kind: string, sessionId: string, identity: string): string {
	const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
	return `${kind}:${sessionId}:${digest}`;
}

/** Owns model-fitness execution, cancellation, accounting, and host-keyed persistence. */
export class ModelFitnessController {
	private readonly abortController = new AbortController();
	private readonly deps: ModelFitnessControllerDeps;
	private readonly models: LaneModelResolver;

	constructor(deps: ModelFitnessControllerDeps, models: LaneModelResolver) {
		this.deps = deps;
		this.models = models;
	}

	abort(): void {
		this.abortController.abort();
	}

	async run(args: {
		model: string;
		trials?: number;
		toolCallId?: string;
	}): Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }> {
		if (this.deps.isDisposed()) return { started: false, skipReason: "session_disposed" };
		const resolved = this.models.resolveModel(args.model.trim() || undefined);
		if (!resolved) return { started: false, skipReason: "model_unresolved_or_unauthenticated" };
		const capability = this.models.capabilityProfile(resolved);
		const deregisterInFlight = registerInFlightWork(
			this.deps.getAgentDir(),
			"lane",
			`fitness:${resolved.provider}/${resolved.id}`,
		);
		try {
			const spent: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const report = await runModelFitnessProbe({
				trials: args.trials,
				signal: this.abortController.signal,
				capacityProbe:
					resolved.provider === "ollama" && resolved.contextWindow > 0
						? { registeredContextWindow: resolved.contextWindow }
						: undefined,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const callStarted = Date.now();
					const completion = await this.deps.runIsolatedCompletion({
						systemPrompt,
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model: resolved,
						thinkingLevel: "off",
						maxTokens: capability.laneMaxOutputTokens,
						signal,
						cacheRetention: "short",
						laneKind: "fitness",
					});
					const callMs = Date.now() - callStarted;
					spent.input += completion.usage.input;
					spent.output += completion.usage.output;
					spent.cacheRead += completion.usage.cacheRead;
					spent.cacheWrite += completion.usage.cacheWrite;
					spent.totalTokens += completion.usage.totalTokens;
					spent.cost.input += completion.usage.cost.input;
					spent.cost.output += completion.usage.cost.output;
					spent.cost.cacheRead += completion.usage.cost.cacheRead;
					spent.cost.cacheWrite += completion.usage.cost.cacheWrite;
					spent.cost.total += completion.usage.cost.total;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
						outputTokens: completion.usage.output,
						evalMs: callMs,
					};
				},
			});
			const modelRef = `${resolved.provider}/${resolved.id}`;
			if (!this.deps.isDisposed() && (spent.cost.total > 0 || spent.totalTokens > 0)) {
				const identity = args.toolCallId
					? `toolcall:${args.toolCallId}`
					: `${modelRef} ${args.trials ?? "default"}`;
				const reportId = deriveSpawnedUsageReportId("model-fitness", this.deps.getSessionId(), identity);
				this.deps.addSpawnedUsage(spent, { label: "model-fitness", reportId });
			}
			try {
				if (!this.deps.isDisposed()) FitnessStore.forAgentDir(this.deps.getAgentDir()).save(modelRef, report);
			} catch {
				// Best-effort persistence must not fail the probe.
			}
			return { started: true, model: modelRef, report };
		} finally {
			deregisterInFlight();
		}
	}

	getStoredReports(): StoredFitnessReport[] {
		try {
			return FitnessStore.forAgentDir(this.deps.getAgentDir()).getForHost();
		} catch {
			return [];
		}
	}
}

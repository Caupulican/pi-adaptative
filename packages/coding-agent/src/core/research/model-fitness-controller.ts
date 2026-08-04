import { addUsage, createEmptyUsage } from "@caupulican/pi-agent-core/usage";
import type { Usage } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session.ts";
import { runIsolatedTextCompletion } from "../isolated-text-completion.ts";
import { FitnessStore, type StoredFitnessReport } from "../models/fitness-store.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import { reportSpawnedUsage } from "../spawned-usage.ts";
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
			const spent = createEmptyUsage();
			const report = await runModelFitnessProbe({
				trials: args.trials,
				signal: this.abortController.signal,
				capacityProbe:
					resolved.provider === "ollama" && resolved.contextWindow > 0
						? { registeredContextWindow: resolved.contextWindow }
						: undefined,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const callStarted = Date.now();
					const completion = await runIsolatedTextCompletion(this.deps, {
						systemPrompt,
						userPrompt,
						model: resolved,
						thinkingLevel: "off",
						maxTokens: capability.laneMaxOutputTokens,
						signal,
						cacheRetention: "short",
						laneKind: "fitness",
					});
					const callMs = Date.now() - callStarted;
					addUsage(spent, completion.usage);
					return {
						text: completion.text,
						costUsd: completion.costUsd,
						stopReason: completion.stopReason,
						outputTokens: completion.usage.output,
						evalMs: callMs,
					};
				},
			});
			const modelRef = `${resolved.provider}/${resolved.id}`;
			if (!this.deps.isDisposed()) {
				const identity = args.toolCallId
					? `toolcall:${args.toolCallId}`
					: `${modelRef} ${args.trials ?? "default"}`;
				reportSpawnedUsage(this.deps, spent, {
					kind: "model-fitness",
					label: "model-fitness",
					sessionId: this.deps.getSessionId(),
					identity,
				});
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

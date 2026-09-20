/**
 * Normal-SDK harness for the release-candidate closure suite.
 *
 * Sessions are created through the public `createAgentSession` composition, never by constructing
 * controllers directly, so a test that passes here is evidence the production wiring exists.
 *
 * It is secret-free by construction: the provider transport is the faux provider and the semantic
 * plane is a replay engine that emits the real normalized decision shapes
 * (`boolean.probabilityTrue`, `choice.selected` + `distribution`, `score.value`), each carrying a
 * real `DecisionConfidence`. Nothing here invents a response shape the production engine cannot
 * produce, and no live provider or Jev call is made.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import type { FauxModelDefinition, FauxProviderRegistration, FauxResponseStep } from "@caupulican/pi-ai/faux";
import { registerFauxProvider } from "@caupulican/pi-ai/faux";
import { onTestFinished } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExecutionCharter } from "../../src/core/autonomy/execution-charter.ts";
import type { DecisionEngineCapabilities } from "../../src/core/decision/capabilities.ts";
import type { DecisionConfidence } from "../../src/core/decision/confidence.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../../src/core/decision/engine.ts";
import {
	createDecisionEvaluation,
	type DecisionEvaluation,
	type DecisionResult,
} from "../../src/core/decision/evaluation.ts";
import type { DecisionDefinition } from "../../src/core/decision/primitives.ts";
import type { DecisionProgram } from "../../src/core/decision/program.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../src/core/orchestration/profile-store.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SteeringCertificateStore } from "../../src/core/steering/certificate-store.ts";
import { DEFAULT_STEERING_POLICY } from "../../src/core/steering/policy.ts";
import { SystemOneSteeringPlane } from "../../src/core/steering/system-one-steering-plane.ts";
import { createTestResourceLoader } from "./test-resources.ts";

const CALIBRATED: DecisionConfidence = { value: 0.97, provenance: "native_calibrated", isCalibrated: true };
const LOW_CONFIDENCE: DecisionConfidence = { value: 0.41, provenance: "native_calibrated", isCalibrated: true };

/** A replayed answer, expressed in the engine's own normalized result shapes. */
export type ReplayAnswer =
	| { kind: "boolean"; probabilityTrue: number; confidence?: DecisionConfidence }
	| { kind: "choice"; selected: string; distribution?: Record<string, number>; confidence?: DecisionConfidence }
	| { kind: "score"; value: number; confidence?: DecisionConfidence };

export interface ReplayDecisionEngineOptions {
	/** Exact decision id -> replayed answer. */
	answers?: Record<string, ReplayAnswer>;
	/** Answer for any decision id not listed. */
	fallback?: ReplayAnswer;
	/** Throw on evaluate, modelling a transport failure with no result. */
	failWith?: Error;
	/** Emit results below the acceptance threshold, modelling the low-confidence path. */
	lowConfidence?: boolean;
	/** Omit results entirely, modelling a malformed/missing response. */
	omitResults?: boolean;
}

export function normalizedResult(answer: ReplayAnswer, lowConfidence: boolean): DecisionResult {
	const confidence = answer.confidence ?? (lowConfidence ? LOW_CONFIDENCE : CALIBRATED);
	if (answer.kind === "boolean") {
		return {
			kind: "boolean",
			value: answer.probabilityTrue >= 0.5,
			probabilityTrue: answer.probabilityTrue,
			confidence: { ...confidence, noulProbabilityTrue: answer.probabilityTrue },
		};
	}
	if (answer.kind === "choice") {
		const distribution = answer.distribution ?? { [answer.selected]: confidence.value };
		const sorted = Object.values(distribution).sort((left, right) => right - left);
		return {
			kind: "choice",
			selected: answer.selected,
			distribution,
			margin: (sorted[0] ?? 0) - (sorted[1] ?? 0),
			confidence,
		};
	}
	return {
		kind: "score",
		value: answer.value,
		distribution: { [answer.value]: confidence.value },
		confidence,
	};
}

/** Records every program it was asked, so a test can prove which questions the runtime really asked. */
export class ReplaySemanticDecisionEngine implements SemanticDecisionEngine {
	readonly id = "replay-system-one";
	readonly model = "replay-jev";
	readonly programs: DecisionProgram[] = [];
	options: ReplayDecisionEngineOptions;

	constructor(options: ReplayDecisionEngineOptions = {}) {
		this.options = options;
	}

	capabilities(): DecisionEngineCapabilities {
		return {
			boolean: true,
			choice: true,
			score: true,
			set: true,
			fullDistributions: true,
			parallelIndependentDecisions: true,
			confidenceProvenance: "native_calibrated",
		};
	}

	async evaluate(program: DecisionProgram, _state: unknown, _options?: DecisionOptions): Promise<DecisionEvaluation> {
		this.programs.push(program);
		if (this.options.failWith) throw this.options.failWith;

		const results: Record<string, DecisionResult> = {};
		if (!this.options.omitResults) {
			for (const decision of program.decisions) {
				const answer = this.options.answers?.[decision.id] ?? this.options.fallback ?? defaultAnswerFor(decision);
				if (answer) results[decision.id] = normalizedResult(answer, this.options.lowConfidence === true);
			}
		}

		return createDecisionEvaluation({
			programId: program.id,
			programVersion: program.version,
			engineId: this.id,
			model: this.model,
			confidenceProvenance: "native_calibrated",
			results,
		});
	}
}

function defaultAnswerFor(decision: DecisionDefinition): ReplayAnswer | undefined {
	if (decision.kind === "boolean") return { kind: "boolean", probabilityTrue: 0.95 };
	if (decision.kind === "choice") {
		const first = Object.keys(decision.options)[0];
		return first ? { kind: "choice", selected: first } : undefined;
	}
	if (decision.kind === "score") return { kind: "score", value: decision.levels[0]?.value ?? 1 };
	return undefined;
}

export interface RcSdkHarness {
	session: AgentSession;
	steeringPlane: SystemOneSteeringPlane;
	decisions: ReplaySemanticDecisionEngine;
	faux: FauxProviderRegistration;
	setResponses(responses: FauxResponseStep[]): void;
	/** Queue plain assistant replies without repeating the faux message envelope in every test. */
	replyWith(...texts: string[]): void;
	cwd: string;
	agentDir: string;
	cleanup(): Promise<void>;
}

export interface RcSdkHarnessOptions {
	decisions?: ReplayDecisionEngineOptions;
	models?: FauxModelDefinition[];
	charter?: ExecutionCharter;
	prompt?: string;
	tools?: string[];
	/** Trusted instruction files the session compiles project rules from. */
	agentsFiles?: Array<{ path: string; content?: string }>;
	/** Enables real worker delegation against the faux transport. */
	workerDelegation?: boolean;
}

/**
 * Appends one assistant tool call and its result to the live session branch, the way a turn does.
 * Used to give the retention planner the transcript depth a long session has.
 */
export function appendToolExchange(
	harness: Pick<RcSdkHarness, "session">,
	options: { callId: string; toolName: string; output: string; isError?: boolean },
): void {
	const model = harness.session.model;
	harness.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: options.callId, name: options.toolName, arguments: {} }],
		api: model?.api ?? "anthropic-messages",
		provider: model?.provider ?? "faux",
		model: model?.id ?? "faux-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as never);
	harness.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: options.callId,
		toolName: options.toolName,
		content: [{ type: "text", text: options.output }],
		isError: options.isError ?? false,
		timestamp: Date.now(),
	} as never);
}

/** Creates a session the way production creates one, with every live port bound. */
export async function createRcSdkHarness(options: RcSdkHarnessOptions = {}): Promise<RcSdkHarness> {
	const tempDir = join(tmpdir(), `pi-rc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "workspace");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	const faux = registerFauxProvider({ models: options.models });
	faux.setResponses([]);
	const model = faux.getModel();

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			textToolCallProtocol: registered.textToolCallProtocol,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
			defaultThinkingLevel: registered.defaultThinkingLevel,
			thinkingLevelMap: registered.thinkingLevelMap,
		})),
	});

	const decisions = new ReplaySemanticDecisionEngine(options.decisions);
	const steeringPlane = new SystemOneSteeringPlane({
		certificates: new SteeringCertificateStore(join(agentDir, "certificates.json")),
		policy: DEFAULT_STEERING_POLICY,
		decisionEngine: decisions,
	});

	// A real worker needs an owner-authored orchestration profile, exactly as production does.
	const workerProfileId = "rc-worker";
	if (options.workerDelegation) {
		const now = new Date().toISOString();
		const workerProfile: OrchestrationProfile = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: workerProfileId,
			description: "Release-candidate scenario worker",
			role: "implementer",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: model.provider, modelId: model.id, thinkingLevel: "off" }],
			},
			capabilityCeiling: ["filesystem.read", "filesystem.write", "worktree.read", "worktree.mutate"],
			toolNames: ["read", "grep", "find", "ls", "write", "edit"],
			resourceProfileNames: [],
			dispatchProfileIds: [],
			budget: { maxCostUsd: 5, maxWallClockMs: 600_000, maxTokens: model.maxTokens, maxToolCalls: 20 },
			maxConcurrent: 2,
			leaseTtlMs: 660_000,
			requireIndependentVerification: false,
			createdAt: now,
			updatedAt: now,
		};
		new OrchestrationProfileStore({ agentDir, cwd, projectTrusted: true }).save(workerProfile, "global");
	}

	const created = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		model,
		settingsManager: SettingsManager.inMemory({
			edge: { allow: [] },
			...(options.workerDelegation
				? { workerDelegation: { enabled: true, orchestrationProfile: workerProfileId } }
				: {}),
		}),
		resourceLoader: createTestResourceLoader(options.agentsFiles ? { agentsFiles: options.agentsFiles } : {}),
		steeringPlane,
		charter: options.charter,
		prompt: options.prompt,
		tools: options.tools ?? (options.workerDelegation ? ["read", "write", "edit", "bash", "delegate"] : undefined),
	});

	let cleanupPromise: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			try {
				await created.session.disposeAndWait();
			} finally {
				faux.unregister?.();
				rmSync(tempDir, { recursive: true, force: true });
			}
		})();
		return cleanupPromise;
	};
	onTestFinished(() => cleanup());

	return {
		session: created.session,
		steeringPlane,
		decisions,
		faux,
		setResponses: (responses) => faux.setResponses(responses),
		replyWith: (...texts) =>
			faux.setResponses(
				texts.map((text) => ({
					...fauxAssistantMessage(text),
					api: model.api,
					provider: model.provider,
					model: model.id,
				})),
			),
		cwd,
		agentDir,
		cleanup,
	};
}

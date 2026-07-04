/**
 * Native reflection + learning-write controller.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the end-of-loop reflection
 * pass (R2), the isolated-completion primitive it runs on, and the learning-apply/rollback path that
 * turns reflection writes into gated, audited durable memory/skill changes. It mutates NO session
 * fields — every durable effect goes through the bundled memory tool, the session log (via deps), or
 * the skills dir; the whole pass is best-effort and never throws into the turn loop. Reads live
 * session state (model/agent/registry/memory/settings) through narrow deps accessors rather than the
 * whole AgentSession.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Context, Model, SimpleStreamOptions, TextContent, Usage } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "./agent-session.ts";
import type { LearningDecision } from "./autonomy/contracts.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import {
	APPLY_WRITE_REFUSED_REASON_CODE,
	appendLearningAuditSnapshot,
	contradictionsForReflectionWrite,
	getLearningAuditSnapshots,
	type LearningAuditRecord,
	proposalFromReflectionWrite,
	rollbackPlanForReflectionWrite,
} from "./learning/learning-audit.ts";
import { evaluateLearningDecision } from "./learning/learning-gate.ts";
import { ObservationStore, observationKey } from "./learning/observation-store.ts";
import {
	type DemandSignals,
	decideDemand,
	ReflectionEngine,
	type ReflectionResult,
	type ReflectionWrite,
} from "./learning/reflection-engine.ts";
import type { MemoryManager } from "./memory/memory-manager.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface ReflectionControllerDeps {
	/** Current session model (fallback for an isolated call that omits its own model). */
	getModel(): Model<any> | undefined;
	/** The underlying agent — its `streamFn` runs the isolated completion. */
	getAgent(): Agent;
	/** True when the session's stream fn is the raw `streamSimple` provider (auth must be injected). */
	isRawStreamSimple(): boolean;
	/** Model registry for API-key/header resolution on the raw-provider path. */
	getModelRegistry(): ModelRegistry;
	/** Memory subsystem — the bundled `memory` tool applies durable writes; fresh block feeds reflection. */
	getMemoryManager(): MemoryManager;
	/** Settings — the learning-apply policy (gate thresholds, auto-apply layers) is read here. */
	getSettingsManager(): SettingsManager;
	/** Session log — audit snapshots and learning-audit reads go through this. */
	getSessionManager(): SessionManager;
	/** Agent dir — reflection-promoted skills are written under `<agentDir>/skills/`. */
	getAgentDir(): string;
	/** Child sessions must not learn — the pass returns null for them. */
	isChildSession(): boolean;
	/** Disposal short-circuits: no completion, no writes against a dead session. */
	isDisposed(): boolean;
	/** Session-lifetime abort signal — aborts an in-flight reflection completion on dispose. */
	getReflectionSignal(): AbortSignal;
	/** Archive a promoted skill (rollback of a `promote_skill` write). */
	archivePromotedSkill(name: string): boolean;
	/** G3/G8 autonomy telemetry sink for learning-gate outcomes and approval requests. */
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	/** Account the reflection pass's token spend into the cost roll-up (idempotent on reportId). */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined;
	/** Persist a learning-gate decision snapshot to the session log. */
	saveLearningDecisionSnapshot(decision: LearningDecision): string;
}

export class ReflectionController {
	private readonly deps: ReflectionControllerDeps;

	constructor(deps: ReflectionControllerDeps) {
		this.deps = deps;
	}

	/**
	 * Run a one-shot LLM completion fully ISOLATED from the main session — the load-bearing
	 * primitive for the native reflection engine (adaptive-agent design §6c/§7).
	 *
	 * Isolation invariants (audited by codex): builds a fresh {@link Context} (no main history), runs
	 * with `tools: []`, sets `cacheRetention: "none"`, and passes **no `sessionId`** — so it cannot
	 * mutate `agent.state.messages`, cannot append session entries, cannot touch the tool registry,
	 * and cannot churn the main session's prompt cache. Mirrors `generateSummary()`'s mechanics.
	 *
	 * Returns the result even on an error/aborted stop reason (callers — e.g. a background reflection
	 * microtask — decide whether to act); it does not throw on a model-level error.
	 */
	async runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult> {
		const model = opts.model ?? this.deps.getModel();
		if (!model) {
			throw new Error("runIsolatedCompletion: no model available");
		}
		const thinkingLevel = opts.thinkingLevel ?? "off";

		// Fresh, isolated context: explicit messages, no tools, nothing from the main session.
		const context: Context = {
			systemPrompt: opts.systemPrompt,
			messages: opts.messages,
			tools: [],
		};

		// Isolate the prompt cache and DELIBERATELY omit sessionId so no session-aware caching/routing
		// can entangle this call with the main session.
		const options: SimpleStreamOptions = {
			maxTokens: opts.maxTokens,
			signal: opts.signal,
			cacheRetention: opts.cacheRetention ?? "none",
		};
		// pi-ai's `reasoning` option does not include "off" (that's the provider default already).
		if (thinkingLevel !== "off") {
			options.reasoning = thinkingLevel;
		}

		// When streamFn is the raw streamSimple (e.g. in tests), auth must be injected explicitly.
		// Throw only when auth genuinely fails — providers that authenticate without an API key
		// (OAuth, local no-key) legitimately return ok with an undefined apiKey.
		if (this.deps.isRawStreamSimple()) {
			const auth = await this.deps.getModelRegistry().getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			options.apiKey = auth.apiKey;
			options.headers = auth.headers;
		}

		const stream = await this.deps.getAgent().streamFn(model, context, options);
		const result = await stream.result();
		const text = result.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
		const usage: Usage = result.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		return { text, usage, stopReason: result.stopReason };
	}

	/**
	 * Native end-of-loop reflection pass (R2). Demand-gates (zero-I/O), and when warranted runs the
	 * {@link ReflectionEngine} via an isolated completion ({@link runIsolatedCompletion}), applies the
	 * resulting memory writes through the bundled `memory` tool, and accounts the reflection's token
	 * cost via the cost-aggregation surface so it stays visible and net-negative-auditable.
	 *
	 * Returns `null` when the gate skips (or in a child session, which must not learn). The whole pass
	 * is best-effort: a model/parse error yields no writes, never throws into the caller.
	 */
	async runReflectionPass(input: {
		signals: DemandSignals;
		recentTurnText: string;
		model?: Model<any>;
		thinkingLevel?: ThinkingLevel;
		signal?: AbortSignal;
		/** Stable id so a duplicate scheduling/retry of the same pass can't double-count its cost. */
		reportId?: string;
	}): Promise<ReflectionResult | null> {
		if (this.deps.isChildSession() || this.deps.isDisposed()) return null;
		const plan = decideDemand(input.signals);
		if (plan.act === "skip") return null;

		// Bug #21: tie this background pass to the session lifetime. Disposing the session aborts the
		// in-flight completion (input.signal can add a more specific abort).
		const signal = input.signal
			? AbortSignal.any([input.signal, this.deps.getReflectionSignal()])
			: this.deps.getReflectionSignal();

		const complete = (systemPrompt: string, userPrompt: string) =>
			this.runIsolatedCompletion({
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				model: input.model,
				thinkingLevel: input.thinkingLevel ?? "low",
				maxTokens: plan.tokenBudget,
				signal,
				// The reflection system prompt is static (#33) — let the provider cache the prefix so
				// repeated passes only pay for the variable tail.
				cacheRetention: "short",
			});

		const result = await new ReflectionEngine().reflect({
			recentTurnText: input.recentTurnText,
			// Read memory FRESH (not the prefix-cache-frozen system-prompt block) so confront-before-write
			// sees writes made earlier this session.
			existingMemory: this.deps.getMemoryManager().buildSystemPromptBlockFresh() || "",
			plan,
			complete,
		});

		// Bug #21: if the session was disposed while the completion was in flight, do NOT write memory
		// or skills against the dead session.
		if (this.deps.isDisposed()) return result;

		// Learning apply policy: every durable write is converted to a proposal, decided by the
		// learning gate, and audited with a rollback plan. With the policy disabled (default) the
		// legacy direct-apply behavior is preserved — but now leaves audit records with rollback info.
		const policy = this.deps.getSettingsManager().getLearningPolicySettings();
		// The audit id sequence counts STORED snapshots only: it reseeds from the stored count on
		// every pass, so advancing it for a no-op (which stores nothing) would make later passes
		// reuse ids — and rollback keys on the id, so a collision blocks or misdirects rollback.
		let auditSequence = getLearningAuditSnapshots(this.deps.getSessionManager().getEntries()).length;
		// G6 evidence strength: durable proposals accumulate observation counts across passes/sessions
		// so the gate can distinguish a one-off cue from a repeatedly-confirmed lesson. Built once per
		// pass; every increment is best-effort (store IO must never break reflection).
		const observationStore = ObservationStore.forAgentDir(this.deps.getAgentDir());
		let writeIndex = 0;
		for (const write of result.writes) {
			writeIndex += 1;
			const proposalId = `${input.reportId ?? "reflection"}-w${writeIndex}`;
			const proposal = proposalFromReflectionWrite(write, proposalId);
			const rollback = rollbackPlanForReflectionWrite(write);
			let observations = 1;
			if (policy.enabled) {
				try {
					observations = observationStore.increment(observationKey(proposal.layer, proposal.summary));
				} catch {
					// A store read/write failure falls back to a fresh count of 1, which keeps the gate
					// proposal-first (never spuriously auto-applies) rather than crashing the pass.
					observations = 1;
				}
			}
			const decision: LearningDecision = policy.enabled
				? evaluateLearningDecision({
						proposal,
						confidence: policy.reflectionSourceConfidence,
						observations,
						// A replace/remove supersedes an existing durable fact — the reflection engine's
						// confront-before-write conflict signal — so it routes through approval instead of
						// silently overwriting prior memory. Additive writes contradict nothing.
						contradictions: contradictionsForReflectionWrite(write),
						settings: {
							enabled: true,
							autoApplyEnabled: policy.autoApplyEnabled,
							confidenceThreshold: policy.confidenceThreshold,
							minObservations: policy.minObservations,
							allowedAutoApplyLayers: policy.allowedAutoApplyLayers,
							requireRollbackPlan: policy.requireRollbackPlan,
							autoApplySupersessions: policy.autoApplySupersessions,
						},
					})
				: {
						kind: "apply",
						reasonCode: "learning_policy_disabled_legacy_apply",
						confidence: 0,
						summary: proposal.summary,
						requiresApproval: false,
					};

			this.deps.saveLearningDecisionSnapshot(decision);
			// G3: learning-gate outcome. Codes/numbers only — never the proposal summary/memory text.
			this.deps.emitAutonomyTelemetry({
				type: AUTONOMY_TELEMETRY_EVENT_TYPES.learningDecision,
				timestamp: new Date().toISOString(),
				payload: {
					kind: decision.kind,
					reasonCode: decision.reasonCode,
					layer: proposal.layer,
					confidence: decision.confidence,
					requiresApproval: decision.requiresApproval,
				},
			});
			// G8: a proposal that needs human sign-off is an approval REQUEST. Codes/layer only —
			// never the proposal summary/memory text (those live only in the audit snapshot).
			if (decision.requiresApproval) {
				this.deps.emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.approvalRequest,
					timestamp: new Date().toISOString(),
					payload: {
						kind: decision.kind,
						reasonCode: decision.reasonCode,
						layer: proposal.layer,
					},
				});
			}
			// The gate's decision and the write's actual outcome are two different questions: the memory
			// tool can refuse a write (budget exceeded, drift, threat) via details.success:false without
			// throwing. Capture that outcome instead of assuming "decision.kind === apply" means it landed
			// — otherwise a refused write leaves a phantom "apply" audit whose rollback later fails
			// not-found (or, worse, misfires against whatever now occupies that text).
			const applied = decision.kind === "apply" ? await this._applyReflectionWrite(write, signal) : false;
			const writeFailed = decision.kind === "apply" && !applied;
			if (decision.kind !== "no-op") {
				auditSequence += 1;
				appendLearningAuditSnapshot(this.deps.getSessionManager(), {
					id: `audit-${auditSequence}`,
					proposalId,
					layer: proposal.layer,
					action: writeFailed ? "apply_failed" : decision.kind === "apply" ? "apply" : "propose",
					summary: proposal.summary,
					reasonCode: writeFailed ? APPLY_WRITE_REFUSED_REASON_CODE : decision.reasonCode,
					decision,
					// No rollback plan on a failed apply — nothing durable landed, so there is nothing to undo.
					rollback: writeFailed ? undefined : rollback,
					createdAt: new Date().toISOString(),
				});
			}
		}

		// Account the reflection's spend so it surfaces in the footer roll-up (net-token visibility).
		// Idempotent on reportId so a retried/duplicated pass cannot double-count.
		if (result.usage.cost.total > 0 || result.usage.totalTokens > 0) {
			this.deps.addSpawnedUsage(result.usage, { label: "reflection", reportId: input.reportId });
		}
		return result;
	}

	getLearningAuditRecords(): LearningAuditRecord[] {
		return getLearningAuditSnapshots(this.deps.getSessionManager().getEntries());
	}

	/**
	 * Roll back one applied durable learning change by executing the inverse operation recorded in
	 * its audit record (memory ops run through the same bundled memory-tool path as the original
	 * apply; promoted skills are archived). Appends a linked "rollback" audit record on success so
	 * the change history stays complete and a change cannot be rolled back twice.
	 */
	async rollbackLearningWrite(auditId: string): Promise<{ ok: boolean; reason: string }> {
		if (this.deps.isDisposed()) return { ok: false, reason: "session_disposed" };

		const audits = this.getLearningAuditRecords();
		const audit = audits.find((record) => record.id === auditId);
		if (!audit) return { ok: false, reason: "audit_not_found" };
		if (audit.action !== "apply") return { ok: false, reason: "not_an_applied_change" };
		if (audits.some((record) => record.action === "rollback" && record.rollbackOf === auditId)) {
			return { ok: false, reason: "already_rolled_back" };
		}
		const rollback = audit.rollback;
		if (!rollback) return { ok: false, reason: "no_rollback_plan" };

		// Every inverse must be VERIFIED-applied before the rollback audit is appended: a silently
		// failed inverse that still recorded "rollback" would permanently self-lock the change
		// behind already_rolled_back while the durable write is in fact still live.
		switch (rollback.kind) {
			case "memory_remove": {
				if (!rollback.target) return { ok: false, reason: "missing_rollback_target" };
				if (!(await this._applyReflectionWrite({ kind: "memory_remove", target: rollback.target }))) {
					return { ok: false, reason: "rollback_apply_failed" };
				}
				break;
			}
			case "memory_restore": {
				if (!rollback.target || rollback.previous === undefined) {
					return { ok: false, reason: "missing_rollback_target" };
				}
				const applied = await this._applyReflectionWrite({
					kind: "memory_replace",
					target: rollback.target,
					text: rollback.previous,
				});
				if (!applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "memory_add": {
				if (rollback.previous === undefined) return { ok: false, reason: "missing_rollback_target" };
				const applied = await this._applyReflectionWrite({
					kind: "memory_add",
					section: "MEMORY",
					text: rollback.previous,
				});
				if (!applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "archive_skill": {
				if (!rollback.target) return { ok: false, reason: "missing_rollback_target" };
				if (!this.deps.archivePromotedSkill(rollback.target)) {
					return { ok: false, reason: "skill_archive_failed" };
				}
				break;
			}
		}

		appendLearningAuditSnapshot(this.deps.getSessionManager(), {
			id: `${audit.id}-rollback`,
			proposalId: audit.proposalId,
			layer: audit.layer,
			action: "rollback",
			summary: `Rolled back: ${audit.summary}`,
			reasonCode: "user_requested_rollback",
			decision: audit.decision,
			rollbackOf: audit.id,
			createdAt: new Date().toISOString(),
		});
		return { ok: true, reason: "rollback_applied" };
	}

	/**
	 * Apply one reflection write through the bundled `memory` tool. `memory_replace`/`memory_remove`
	 * don't carry a target file, so we try MEMORY.md first and fall back to USER.md when the substring
	 * isn't found there. Never throws (reflection must never break a turn); returns whether the write
	 * actually applied so callers that MUST know — rollback's once-only accounting — can react instead
	 * of recording a success that never happened.
	 */
	private async _applyReflectionWrite(write: ReflectionWrite, signal?: AbortSignal): Promise<boolean> {
		// R7 memory-to-behavior: a recurring procedure is compiled into an executable skill file rather
		// than stored as a flat fact. Written under the agent skills dir so it loads like any user skill.
		if (write.kind === "promote_skill") {
			return this._promoteReflectionSkill(write.name, write.description, write.body);
		}

		type MemResult = { details?: { success?: boolean; error?: string } };
		type MemExec = (
			toolCallId: string,
			params: { action: string; target: string; content?: string; oldContent?: string },
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: undefined,
		) => Promise<MemResult>;
		const memTool = this.deps
			.getMemoryManager()
			.getToolDefinitions()
			.find((t) => t.name === "memory");
		const exec = memTool?.execute as unknown as MemExec | undefined;
		if (!exec) return false;

		const run = (params: Parameters<MemExec>[1]) => exec("reflection", params, signal, undefined, undefined);

		if (write.kind === "memory_add") {
			try {
				const res = await run({
					action: "add",
					target: write.section === "USER" ? "user" : "memory",
					content: write.text,
				});
				return res?.details?.success === true;
			} catch {
				// best-effort; reflection writes must never throw into the turn loop
				return false;
			}
		}

		// replace / remove carry no target file — try MEMORY.md, then USER.md. The memory tool reports
		// outcomes via `details.success` (it catches its own errors rather than throwing). Only a
		// genuine "not found in the file" justifies trying the other file; a real failure for a file
		// (budget exceeded / drift) must NOT fall through and mutate the wrong target.
		for (const target of ["memory", "user"] as const) {
			try {
				const params =
					write.kind === "memory_replace"
						? { action: "replace", target, oldContent: write.target, content: write.text }
						: { action: "remove", target, oldContent: write.target };
				const res = await run(params);
				if (res?.details?.success === true) return true; // applied
				if (!/not found/i.test(String(res?.details?.error ?? ""))) return false; // real failure — don't misapply
				// substring simply absent from this file — try the next target
			} catch {
				// defensive: if the tool ever does throw, try the next target
			}
		}
		return false;
	}

	/**
	 * R7: write a reflection-promoted skill as `<agentDir>/skills/<name>/SKILL.md` so it loads like any
	 * user skill. Best-effort; never clobbers an existing (hand-authored) skill of the same name.
	 */
	private _promoteReflectionSkill(rawName: string, description: string, body: string): boolean {
		const name = rawName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64);
		if (!name || !body.trim()) return false;
		try {
			const dir = join(this.deps.getAgentDir(), "skills", name);
			const file = join(dir, "SKILL.md");
			if (existsSync(file)) return false; // do not overwrite an existing skill
			mkdirSync(dir, { recursive: true });
			const safeDescription = description.replace(/[\r\n]+/g, " ").trim();
			// `promoted: true` marks this as reflection-generated so the curator (#32) can lifecycle-manage
			// it (archive/consolidate) WITHOUT ever touching hand-authored user skills.
			const content = `---\nname: ${name}\ndescription: ${safeDescription}\npromoted: true\n---\n\n<!-- Auto-generated by the reflection engine (R7 memory-to-behavior). Review and refine. -->\n\n${body.trim()}\n`;
			writeFileSync(file, content, "utf-8");
			return true;
		} catch {
			// promotion must never break a turn
			return false;
		}
	}
}

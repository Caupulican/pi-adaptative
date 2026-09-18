import { resolve } from "node:path";
import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";
import { extractToolPathArguments } from "../autonomy/envelope-enforcement.ts";
import { isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import {
	getToolCapabilityPolicy,
	resolveCapabilityPathAccess,
	resolveToolCallCapabilities,
	resolveToolCallPathAccess,
} from "../tool-capability-policy.ts";
import { attemptUsageFromGatewayUsage, reconcileAttemptUsage, validateAttemptUsageSnapshot } from "./attempt-usage.ts";
import {
	type AttemptUsageAccounting,
	type AttemptUsageGenerationIdentity,
	projectPendingAttemptGenerationUsage,
} from "./attempt-usage-generations.ts";
import type { AttemptUsageSnapshot, ExecutionGrant, HarnessCapability, ToolCapabilityManifest } from "./contracts.ts";

export type GatewayDecisionCode =
	| "allowed"
	| "grant_expired"
	| "tool_not_granted"
	| "manifest_name_mismatch"
	| "capability_not_granted"
	| "path_argument_required"
	| "path_outside_scope"
	| "scope_denied"
	| "tool_call_budget_exhausted"
	| "token_budget_exhausted"
	| "cost_budget_exhausted"
	| "wall_clock_budget_exhausted";

export interface GatewayAuditRecord {
	grantId: string;
	attemptId: string;
	toolName: string;
	outcome: "allow" | "deny";
	reasonCode: GatewayDecisionCode;
	at: string;
}

export interface CapabilityGatewayOptions {
	grant: ExecutionGrant;
	cwd: string;
	/** Durable active usage carried forward when an attempt resumes in a new process. */
	initialUsage?: GatewayInitialUsage;
	now?: () => number;
	onAudit?: (record: GatewayAuditRecord) => void;
	/** Session-tree cumulative budget owner. Per-attempt grants remain independently enforced. */
	sharedBudget?: SharedCapabilityBudget;
}

export interface GatewayUsageDelta {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Provider-authoritative total. Defaults to the supplied detail sum when omitted. */
	totalTokens?: number;
	costUsd?: number;
}

export interface GatewayUsageSnapshot {
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	wallClockMs: number;
}

/** Bound to one registered execution generation; reports never include foreign corrections. */
export interface GatewayUsageAccountingPort {
	readonly identity: AttemptUsageGenerationIdentity;
	readonly baseline: AttemptUsageSnapshot;
	read(): AttemptUsageAccounting;
	record(usage: AttemptUsageSnapshot): void;
}

export interface ProviderBudgetReservation {
	maxTokens: number;
	release(): void;
}

export interface SharedCapabilityBudget {
	assertBudgetAvailable(subject: string): void;
	/** All received usage for this attempt, including other generations' pending writes. */
	getAttemptUsage(): AttemptUsageSnapshot;
	recordAttemptUsage(usage: GatewayUsageSnapshot, accounting?: AttemptUsageAccounting): void;
	remainingTokens(): number | undefined;
	reserveProviderBudget(
		requestedMaxTokens: number,
		subject: string,
		signal?: AbortSignal,
	): Promise<ProviderBudgetReservation>;
}

/** Persistable cumulative usage from a prior active segment; excludes restart downtime. */
export type GatewayInitialUsage = AttemptUsageSnapshot;

/**
 * Weight applied to prompt-cache reads when charging token budgets. Cache reads re-bill the
 * same context on every request (a worker's fixed system prompt alone is thousands of tokens),
 * so charging them at face value turns `maxTokens` into a request counter: a 9k grant died in
 * 2-3 responses while doing ~500 tokens of real work per response (field session 019fd4dc).
 * The weight mirrors the typical cache-read price ratio; money stays bounded by `maxCostUsd`.
 */
export const CACHE_READ_BUDGET_WEIGHT = 0.1;

/**
 * Tokens charged against `maxTokens` budgets: real work at face value, cache reads discounted.
 * A provider-authoritative total above the detail sum is unattributed usage and charges fully.
 */
export function budgetedTokens(usage: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}): number {
	const detailed = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
	const unattributed = Math.max(0, usage.totalTokens - detailed - usage.cacheReadTokens);
	return detailed + unattributed + Math.ceil(usage.cacheReadTokens * CACHE_READ_BUDGET_WEIGHT);
}

const BUDGET_EXHAUSTION_DECISION_CODES: ReadonlySet<GatewayDecisionCode> = new Set([
	"tool_call_budget_exhausted",
	"token_budget_exhausted",
	"cost_budget_exhausted",
	"wall_clock_budget_exhausted",
]);

export class CapabilityGatewayDeniedError extends BoundedCompletionFailureError {
	readonly reasonCode: GatewayDecisionCode;

	constructor(reasonCode: GatewayDecisionCode, message: string) {
		super(BUDGET_EXHAUSTION_DECISION_CODES.has(reasonCode) ? "budget_exhausted" : "failed", reasonCode, message);
		this.name = "CapabilityGatewayDeniedError";
		this.reasonCode = reasonCode;
	}
}

const PATH_CAPABILITIES: ReadonlySet<HarnessCapability> = new Set([
	"filesystem.read",
	"filesystem.write",
	"worktree.read",
	"worktree.mutate",
]);

const WRITE_CAPABILITIES: ReadonlySet<HarnessCapability> = new Set(["filesystem.write", "worktree.mutate"]);

function resolveRealPath(cwd: string, value: string): string | undefined {
	try {
		return safeRealpathSync(resolve(cwd, value));
	} catch {
		return undefined;
	}
}

function validateInitialUsage(usage: GatewayInitialUsage): void {
	try {
		validateAttemptUsageSnapshot(usage, "CapabilityGateway: initial usage");
	} catch {
		throw new Error(
			"CapabilityGateway: initial usage must contain finite non-negative values and safe-integer counts.",
		);
	}
}

function validatedUsageDelta(delta: GatewayUsageDelta): Required<GatewayUsageDelta> {
	const inputTokens = delta.inputTokens === undefined ? 0 : delta.inputTokens;
	const outputTokens = delta.outputTokens === undefined ? 0 : delta.outputTokens;
	const cacheReadTokens = delta.cacheReadTokens === undefined ? 0 : delta.cacheReadTokens;
	const cacheWriteTokens = delta.cacheWriteTokens === undefined ? 0 : delta.cacheWriteTokens;
	const totalTokens =
		delta.totalTokens === undefined
			? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
			: delta.totalTokens;
	const costUsd = delta.costUsd === undefined ? 0 : delta.costUsd;
	if (
		!Number.isSafeInteger(inputTokens) ||
		inputTokens < 0 ||
		!Number.isSafeInteger(outputTokens) ||
		outputTokens < 0 ||
		!Number.isSafeInteger(cacheReadTokens) ||
		cacheReadTokens < 0 ||
		!Number.isSafeInteger(cacheWriteTokens) ||
		cacheWriteTokens < 0 ||
		!Number.isSafeInteger(totalTokens) ||
		totalTokens < 0 ||
		!Number.isFinite(costUsd) ||
		costUsd < 0
	) {
		throw new Error(
			"CapabilityGateway: usage delta must contain finite non-negative values and safe-integer token counts.",
		);
	}
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costUsd };
}

/**
 * Per-invocation enforcement for an already-compiled grant. The compiler controls what may be
 * loaded; this gateway independently rechecks authority, path scope, expiry, and cumulative budget
 * immediately before execution.
 */
export class CapabilityGateway {
	private readonly grant: ExecutionGrant;
	private readonly cwd: string;
	private readonly now: () => number;
	private readonly onAudit?: (record: GatewayAuditRecord) => void;
	private readonly sharedBudget?: SharedCapabilityBudget;
	private startedAt: number;
	private initialWallClockMs: number;
	private stoppedAt?: number;
	private lastWallClockMs = 0;
	private usageAccounting?: GatewayUsageAccountingPort;
	private usageStarted = false;
	private toolCalls: number;
	private inputTokens: number;
	private outputTokens: number;
	private cacheReadTokens: number;
	private cacheWriteTokens: number;
	private totalTokens: number;
	private costUsd: number;

	constructor(options: CapabilityGatewayOptions) {
		const initialUsage: GatewayInitialUsage = options.initialUsage ?? {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			activeWallClockMs: 0,
		};
		validateInitialUsage(initialUsage);
		this.grant = options.grant;
		this.cwd = options.cwd;
		this.now = options.now ?? Date.now;
		this.onAudit = options.onAudit;
		this.sharedBudget = options.sharedBudget;
		this.startedAt = this.currentTime();
		this.initialWallClockMs = initialUsage.activeWallClockMs;
		this.toolCalls = initialUsage.toolCalls;
		this.inputTokens = initialUsage.inputTokens;
		this.outputTokens = initialUsage.outputTokens;
		this.cacheReadTokens = initialUsage.cacheReadTokens;
		this.cacheWriteTokens = initialUsage.cacheWriteTokens;
		this.totalTokens = initialUsage.totalTokens;
		this.costUsd = initialUsage.costUsd;
		this.publishUsage();
	}

	/** Install the registered baseline before this gateway authorizes or charges any work. */
	bindUsageAccounting(port: GatewayUsageAccountingPort): void {
		if (this.usageAccounting) throw new Error("CapabilityGateway: accounting is already bound.");
		if (this.usageStarted) throw new Error("CapabilityGateway: accounting must bind before usage starts.");
		const baseline = validateAttemptUsageSnapshot(port.baseline);
		const startedAt = this.currentTime();
		this.toolCalls = baseline.toolCalls;
		this.inputTokens = baseline.inputTokens;
		this.outputTokens = baseline.outputTokens;
		this.cacheReadTokens = baseline.cacheReadTokens;
		this.cacheWriteTokens = baseline.cacheWriteTokens;
		this.totalTokens = baseline.totalTokens;
		this.costUsd = baseline.costUsd;
		this.initialWallClockMs = baseline.activeWallClockMs;
		this.lastWallClockMs = baseline.activeWallClockMs;
		this.startedAt = startedAt;
		this.usageAccounting = port;
		this.publishUsage();
	}

	/** Persist cumulative local counters. A failed/ambiguous write can retry this exact state. */
	flushUsage(): void {
		let recorded = false;
		let recordFailure: unknown;
		try {
			this.usageAccounting?.record(attemptUsageFromGatewayUsage(this.getLocalUsage()));
			recorded = true;
		} catch (error) {
			recordFailure = error;
		}
		try {
			// A pending durable receipt is still received usage: sibling admission must count it.
			this.publishUsage();
		} catch (error) {
			if (!recorded) {
				throw new AggregateError(
					[recordFailure, error],
					"Usage persistence and shared budget publication both failed.",
					{
						cause: recordFailure,
					},
				);
			}
			throw error;
		}
		if (!recorded) throw recordFailure;
	}

	/** Publish canonical plus pending usage after either direct persistence or an owned retry. */
	publishUsage(): void {
		if (!this.sharedBudget) return;
		const accounting = this.getProjectedAccounting();
		if (!accounting) {
			this.sharedBudget.recordAttemptUsage(this.getLocalUsage());
			return;
		}
		const { activeWallClockMs, ...usage } = accounting.total;
		this.sharedBudget.recordAttemptUsage({ ...usage, wallClockMs: activeWallClockMs }, accounting);
	}

	/** Shutdown stops active time, but received billing facts may still be recorded afterward. */
	stopUsageClock(): void {
		this.stoppedAt ??= this.currentTime();
	}

	async execute<T>(
		manifest: ToolCapabilityManifest,
		toolName: string,
		params: unknown,
		invoke: () => Promise<T> | T,
	): Promise<T> {
		this.authorizeToolCall(manifest, toolName, params);
		return await invoke();
	}

	/** Immediate pre-execution authorization for runtimes that expose a before-tool-call hook. */
	authorizeToolCall(manifest: ToolCapabilityManifest, toolName: string, params: unknown): void {
		const now = this.currentTime();
		this.authorize(manifest, toolName, params, now);
		const toolCalls = this.toolCalls + 1;
		if (!Number.isSafeInteger(toolCalls)) {
			throw new Error("CapabilityGateway: tool-call count would exceed safe cumulative usage bounds.");
		}
		this.toolCalls = toolCalls;
		this.usageStarted = true;
		this.flushUsage();
		this.audit(toolName, "allow", "allowed");
	}

	recordUsage(delta: GatewayUsageDelta): void {
		const validated = validatedUsageDelta(delta);
		const inputTokens = this.inputTokens + validated.inputTokens;
		const outputTokens = this.outputTokens + validated.outputTokens;
		const cacheReadTokens = this.cacheReadTokens + validated.cacheReadTokens;
		const cacheWriteTokens = this.cacheWriteTokens + validated.cacheWriteTokens;
		const totalTokens = this.totalTokens + validated.totalTokens;
		const costUsd = this.costUsd + validated.costUsd;
		if (
			!Number.isSafeInteger(inputTokens) ||
			!Number.isSafeInteger(outputTokens) ||
			!Number.isSafeInteger(cacheReadTokens) ||
			!Number.isSafeInteger(cacheWriteTokens) ||
			!Number.isSafeInteger(totalTokens) ||
			!Number.isFinite(costUsd)
		) {
			throw new Error("CapabilityGateway: usage delta would exceed safe cumulative usage bounds.");
		}
		this.inputTokens = inputTokens;
		this.outputTokens = outputTokens;
		this.cacheReadTokens = cacheReadTokens;
		this.cacheWriteTokens = cacheWriteTokens;
		this.totalTokens = totalTokens;
		this.costUsd = costUsd;
		this.usageStarted = true;
		// The receipt owner first records its cumulative invocation baseline, then flushes. Throwing
		// from persistence inside this delta callback would let a receipt retry add the delta twice.
		if (!this.usageAccounting) this.publishUsage();
	}

	/** Enforce resumed cumulative budgets before a provider request that has no tool-call boundary. */
	assertBudgetAvailable(subject = "provider"): void {
		this.flushUsage();
		this.enforceBudget(subject);
		this.sharedBudget?.assertBudgetAvailable(subject);
	}

	async reserveProviderBudget(
		requestedMaxTokens: number,
		subject = "provider",
		signal?: AbortSignal,
	): Promise<ProviderBudgetReservation> {
		if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) {
			throw new Error("CapabilityGateway: provider token reservation must be a positive safe integer.");
		}
		this.assertBudgetAvailable(subject);
		const localRemaining = this.remainingAttemptTokenBudget();
		const maxTokens = Math.min(requestedMaxTokens, localRemaining ?? requestedMaxTokens);
		if (maxTokens <= 0) {
			this.deny(subject, "token_budget_exhausted", "Token budget exhausted.");
		}
		if (this.sharedBudget) return this.sharedBudget.reserveProviderBudget(maxTokens, subject, signal);
		if (signal?.aborted) throw signal.reason;
		return {
			maxTokens,
			release: () => undefined,
		};
	}

	remainingAttemptTokenBudget(): number | undefined {
		const maximum = this.grant.budget.maxTokens;
		return maximum === undefined ? undefined : Math.max(0, maximum - budgetedTokens(this.getUsage()));
	}

	remainingTokenBudget(): number | undefined {
		const localRemaining = this.remainingAttemptTokenBudget();
		const sharedRemaining = this.sharedBudget?.remainingTokens();
		if (localRemaining === undefined) return sharedRemaining;
		if (sharedRemaining === undefined) return localRemaining;
		return Math.min(localRemaining, sharedRemaining);
	}

	getUsage(): GatewayUsageSnapshot {
		const accounting = this.getProjectedAccounting();
		const local = accounting?.total ?? attemptUsageFromGatewayUsage(this.getLocalUsage());
		// A lower per-attempt grant must see the same pending receipts as the tree's wider budget.
		// This read never copies foreign generation corrections into the counters we persist.
		const { activeWallClockMs, ...usage } = this.sharedBudget
			? reconcileAttemptUsage(local, this.sharedBudget.getAttemptUsage())
			: local;
		return { ...usage, wallClockMs: activeWallClockMs };
	}

	private getProjectedAccounting(): AttemptUsageAccounting | undefined {
		if (!this.usageAccounting) return undefined;
		return projectPendingAttemptGenerationUsage(
			this.usageAccounting.read(),
			this.usageAccounting.identity,
			attemptUsageFromGatewayUsage(this.getLocalUsage()),
		);
	}

	private getLocalUsage(): GatewayUsageSnapshot {
		return {
			toolCalls: this.toolCalls,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cacheReadTokens: this.cacheReadTokens,
			cacheWriteTokens: this.cacheWriteTokens,
			totalTokens: this.totalTokens,
			costUsd: this.costUsd,
			wallClockMs: this.wallClockMsAt(this.currentTime()),
		};
	}

	private authorize(manifest: ToolCapabilityManifest, toolName: string, params: unknown, now: number): void {
		if (this.grant.expiresAt && Date.parse(this.grant.expiresAt) <= now) {
			this.deny(toolName, "grant_expired", `Execution grant '${this.grant.grantId}' expired.`);
		}
		if (!this.grant.allowedTools.includes(toolName)) {
			this.deny(toolName, "tool_not_granted", `Tool '${toolName}' is not in grant '${this.grant.grantId}'.`);
		}
		if (manifest.toolName !== toolName) {
			this.deny(toolName, "manifest_name_mismatch", `Tool '${toolName}' does not match its capability manifest.`);
		}
		if (!manifest.capabilities.every((capability) => this.grant.capabilities.includes(capability))) {
			this.deny(toolName, "capability_not_granted", `Tool '${toolName}' requires an ungranted capability.`);
		}
		const callCapabilities = getToolCapabilityPolicy(toolName)
			? resolveToolCallCapabilities(manifest.capabilities, toolName, params)
			: manifest.capabilities;
		if (!callCapabilities) {
			this.deny(
				toolName,
				"capability_not_granted",
				`Tool '${toolName}' action requires a capability outside its compiled manifest.`,
			);
		}
		this.flushUsage();
		this.enforceBudget(toolName);
		this.sharedBudget?.assertBudgetAvailable(toolName);

		const canonicalPolicy = getToolCapabilityPolicy(toolName);
		const hasDeclaredPathScope = manifest.enforcements.includes("path-scope");
		const pathAccess = canonicalPolicy
			? resolveToolCallPathAccess(manifest.capabilities, toolName, params)
			: hasDeclaredPathScope
				? (resolveCapabilityPathAccess(callCapabilities) ?? "none")
				: "none";
		const paths = pathAccess === "none" ? [] : extractToolPathArguments(toolName, params);
		if (
			pathAccess !== "none" &&
			(callCapabilities.some((capability) => PATH_CAPABILITIES.has(capability)) || paths.length > 0)
		) {
			const isWrite =
				pathAccess === "write" || callCapabilities.some((capability) => WRITE_CAPABILITIES.has(capability));
			const allowedPaths = isWrite ? this.grant.writePaths : this.grant.readPaths;
			if (paths.length === 0) {
				this.deny(toolName, "path_argument_required", `Tool '${toolName}' requires an explicit path argument.`);
			}
			for (const rawPath of paths) {
				if (!this.pathAllowed(rawPath, allowedPaths)) {
					const reasonCode = isWrite ? "scope_denied" : "path_outside_scope";
					this.deny(toolName, reasonCode, `Path '${rawPath}' is outside grant '${this.grant.grantId}'.`);
				}
			}
		}
	}

	private enforceBudget(toolName: string): void {
		const budget = this.grant.budget;
		const usage = this.getUsage();
		if (budget.maxToolCalls !== undefined && usage.toolCalls >= budget.maxToolCalls) {
			this.deny(toolName, "tool_call_budget_exhausted", "Tool-call budget exhausted.");
		}
		if (budget.maxTokens !== undefined && budgetedTokens(usage) >= budget.maxTokens) {
			this.deny(toolName, "token_budget_exhausted", "Token budget exhausted.");
		}
		if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd) {
			this.deny(toolName, "cost_budget_exhausted", "Cost budget exhausted.");
		}
		if (budget.maxWallClockMs !== undefined && usage.wallClockMs >= budget.maxWallClockMs) {
			this.deny(toolName, "wall_clock_budget_exhausted", "Wall-clock budget exhausted.");
		}
	}

	private currentTime(): number {
		const now = this.now();
		if (!Number.isFinite(now)) {
			throw new Error("CapabilityGateway: clock source must return a finite time.");
		}
		return now;
	}

	private wallClockMsAt(now: number): number {
		const elapsed = (this.stoppedAt ?? now) - this.startedAt;
		if (!Number.isFinite(elapsed)) {
			throw new Error("CapabilityGateway: active wall-clock elapsed time must be finite.");
		}
		const wallClockMs = this.initialWallClockMs + Math.max(0, elapsed);
		if (!Number.isFinite(wallClockMs) || wallClockMs < 0) {
			throw new Error("CapabilityGateway: accumulated wall-clock usage must be finite and non-negative.");
		}
		this.lastWallClockMs = Math.max(this.lastWallClockMs, wallClockMs);
		return this.lastWallClockMs;
	}

	private pathAllowed(rawPath: string, allowedPaths: readonly string[]): boolean {
		if (allowedPaths.length === 0) return false;
		const lexicalTarget = resolve(this.cwd, rawPath);
		const allowedRoots = allowedPaths.flatMap((allowed) => {
			const lexicalRoot = resolve(this.cwd, allowed);
			const realRoot = resolveRealPath(this.cwd, allowed);
			return realRoot ? [lexicalRoot, realRoot] : [lexicalRoot];
		});
		if (!allowedRoots.some((root) => isPathWithinScope(lexicalTarget, root))) {
			return false;
		}
		const target = resolveRealPath(this.cwd, rawPath);
		if (!target) return false;
		for (const denied of this.grant.deniedPaths) {
			const root = resolveRealPath(this.cwd, denied);
			if (root && isPathWithinScope(target, root)) return false;
		}
		return allowedRoots.some((root) => isPathWithinScope(target, root));
	}

	private deny(toolName: string, reasonCode: GatewayDecisionCode, message: string): never {
		this.audit(toolName, "deny", reasonCode);
		throw new CapabilityGatewayDeniedError(reasonCode, message);
	}

	private audit(toolName: string, outcome: "allow" | "deny", reasonCode: GatewayDecisionCode): void {
		this.onAudit?.({
			grantId: this.grant.grantId,
			attemptId: this.grant.attemptId,
			toolName,
			outcome,
			reasonCode,
			at: new Date(this.currentTime()).toISOString(),
		});
	}
}

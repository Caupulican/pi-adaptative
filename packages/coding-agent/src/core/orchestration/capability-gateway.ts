import { isAbsolute, relative, resolve, sep } from "node:path";
import { extractPathArguments } from "../autonomy/envelope-enforcement.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import type { ExecutionGrant, HarnessCapability, ToolCapabilityManifest } from "./contracts.ts";

export type GatewayDecisionCode =
	| "allowed"
	| "grant_expired"
	| "tool_not_granted"
	| "manifest_name_mismatch"
	| "capability_not_granted"
	| "path_argument_required"
	| "path_outside_scope"
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
	now?: () => number;
	onAudit?: (record: GatewayAuditRecord) => void;
}

export interface GatewayUsageDelta {
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
}

export interface GatewayUsageSnapshot {
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	wallClockMs: number;
}

export class CapabilityGatewayDeniedError extends Error {
	readonly reasonCode: GatewayDecisionCode;

	constructor(reasonCode: GatewayDecisionCode, message: string) {
		super(message);
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

function isWithinRoot(target: string, root: string): boolean {
	const relativePath = relative(root, target);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

function resolveRealPath(cwd: string, value: string): string | undefined {
	try {
		return safeRealpathSync(resolve(cwd, value));
	} catch {
		return undefined;
	}
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
	private readonly startedAt: number;
	private toolCalls = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private costUsd = 0;

	constructor(options: CapabilityGatewayOptions) {
		this.grant = options.grant;
		this.cwd = options.cwd;
		this.now = options.now ?? Date.now;
		this.onAudit = options.onAudit;
		this.startedAt = this.now();
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
		this.authorize(manifest, toolName, params);
		this.toolCalls++;
		this.audit(toolName, "allow", "allowed");
	}

	recordUsage(delta: GatewayUsageDelta): void {
		this.inputTokens += delta.inputTokens ?? 0;
		this.outputTokens += delta.outputTokens ?? 0;
		this.costUsd += delta.costUsd ?? 0;
	}

	getUsage(): GatewayUsageSnapshot {
		return {
			toolCalls: this.toolCalls,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens: this.inputTokens + this.outputTokens,
			costUsd: this.costUsd,
			wallClockMs: Math.max(0, this.now() - this.startedAt),
		};
	}

	private authorize(manifest: ToolCapabilityManifest, toolName: string, params: unknown): void {
		if (this.grant.expiresAt && Date.parse(this.grant.expiresAt) <= this.now()) {
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
		this.enforceBudget(toolName);

		if (manifest.capabilities.some((capability) => PATH_CAPABILITIES.has(capability))) {
			const allowedPaths = manifest.capabilities.some((capability) => WRITE_CAPABILITIES.has(capability))
				? this.grant.writePaths
				: this.grant.readPaths;
			const paths = extractPathArguments(params);
			if (paths.length === 0) {
				this.deny(toolName, "path_argument_required", `Tool '${toolName}' requires an explicit path argument.`);
			}
			for (const rawPath of paths) {
				if (!this.pathAllowed(rawPath, allowedPaths)) {
					this.deny(toolName, "path_outside_scope", `Path '${rawPath}' is outside grant '${this.grant.grantId}'.`);
				}
			}
		}
	}

	private enforceBudget(toolName: string): void {
		const budget = this.grant.budget;
		if (budget.maxToolCalls !== undefined && this.toolCalls >= budget.maxToolCalls) {
			this.deny(toolName, "tool_call_budget_exhausted", "Tool-call budget exhausted.");
		}
		if (budget.maxTokens !== undefined && this.inputTokens + this.outputTokens >= budget.maxTokens) {
			this.deny(toolName, "token_budget_exhausted", "Token budget exhausted.");
		}
		if (budget.maxCostUsd !== undefined && this.costUsd >= budget.maxCostUsd) {
			this.deny(toolName, "cost_budget_exhausted", "Cost budget exhausted.");
		}
		if (budget.maxWallClockMs !== undefined && this.now() - this.startedAt >= budget.maxWallClockMs) {
			this.deny(toolName, "wall_clock_budget_exhausted", "Wall-clock budget exhausted.");
		}
	}

	private pathAllowed(rawPath: string, allowedPaths: readonly string[]): boolean {
		const target = resolveRealPath(this.cwd, rawPath);
		if (!target || allowedPaths.length === 0) return false;
		for (const denied of this.grant.deniedPaths) {
			const root = resolveRealPath(this.cwd, denied);
			if (root && isWithinRoot(target, root)) return false;
		}
		return allowedPaths.some((allowed) => {
			const root = resolveRealPath(this.cwd, allowed);
			return root !== undefined && isWithinRoot(target, root);
		});
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
			at: new Date(this.now()).toISOString(),
		});
	}
}

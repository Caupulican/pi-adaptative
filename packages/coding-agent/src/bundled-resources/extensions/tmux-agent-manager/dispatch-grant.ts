import * as crypto from "node:crypto";
import type { Usage } from "@caupulican/pi-ai";

/**
 * The STANDING GRANT for approval-gated tmux dispatch (owner authorizes once via `grant_dispatch`;
 * the extension then dispatches unattended WITHIN the grant's bounds). Pure data + pure decode/decision
 * logic only — no session/tmux/filesystem access, so every function here is directly unit-testable.
 * The extension (index.ts) owns reading/writing session custom entries and calls into this module for
 * decoding and authorization decisions.
 *
 * HONEST TRUST BOUNDARY: this grant bounds WHO may be launched, HOW OFTEN, and WITH WHAT launch-time
 * envelope (pushed into the child's own CLI flags) — it never claims to gate the child's in-process
 * tool loop, which is a separate OS process outside this runtime's `beforeToolCall` machinery.
 */

export type Provider = "pi" | "codex" | "agy" | "claude" | "opencode" | "custom";

export const GRANT_CUSTOM_TYPE = "tmux-dispatch-grant";
export const GRANT_USAGE_CUSTOM_TYPE = "tmux-dispatch-grant-usage";

export interface TmuxDispatchGrantEnvelope {
	allowedTools?: string[];
	resourceProfile?: string;
	writePaths?: string[];
}

export interface TmuxDispatchGrantBudget {
	maxLaunches: number;
	maxWallClockMs?: number;
	maxUsdAdvisory?: number;
}

export interface TmuxDispatchGrant {
	grantId: string;
	createdAt: string;
	agent: Provider;
	scope: { goalId?: string };
	envelope: TmuxDispatchGrantEnvelope;
	budget: TmuxDispatchGrantBudget;
	expiresAt?: string;
}

/** Appended by `revoke_grant`. Shares `GRANT_CUSTOM_TYPE` so the SAME latest-on-branch read that
 * resolves an active grant also sees a revocation and stops treating any older grant beneath it as
 * active — a tombstone is a hard stop, never skipped over to resurrect an earlier grant. */
export interface TmuxDispatchGrantTombstone {
	tombstone: true;
	grantId: string;
	revokedAt: string;
}

export interface TmuxDispatchGrantUsage {
	grantId: string;
	jobId: string;
	at: string;
}

const PROVIDERS: readonly Provider[] = ["pi", "codex", "agy", "claude", "opencode", "custom"];

function isProvider(value: unknown): value is Provider {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTmuxDispatchGrantTombstone(value: unknown): value is TmuxDispatchGrantTombstone {
	if (!isPlainRecord(value)) return false;
	return value.tombstone === true && typeof value.grantId === "string" && typeof value.revokedAt === "string";
}

export function isTmuxDispatchGrant(value: unknown): value is TmuxDispatchGrant {
	if (!isPlainRecord(value) || value.tombstone === true) return false;
	if (typeof value.grantId !== "string" || typeof value.createdAt !== "string" || !isProvider(value.agent))
		return false;
	if (!isPlainRecord(value.scope) || !isPlainRecord(value.envelope) || !isPlainRecord(value.budget)) return false;
	return typeof value.budget.maxLaunches === "number" && Number.isFinite(value.budget.maxLaunches);
}

export function isTmuxDispatchGrantUsage(value: unknown): value is TmuxDispatchGrantUsage {
	if (!isPlainRecord(value)) return false;
	return typeof value.grantId === "string" && typeof value.jobId === "string" && typeof value.at === "string";
}

export function makeGrantId(): string {
	return `grant-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export interface GrantCoverageRequest {
	agent: Provider;
	goalId?: string;
	nowIso?: string;
}

/** Whether `grant` authorizes a launch for `request`: same agent, goal-scope match (an UNSCOPED grant
 * covers any goal including none; a goal-SCOPED grant covers ONLY that exact goalId), and the grant is
 * not past `expiresAt`. Budget (maxLaunches) is checked separately via {@link isGrantBudgetExhausted}
 * because counting usages requires the caller's session-entry access. */
export function grantCovers(grant: TmuxDispatchGrant, request: GrantCoverageRequest): boolean {
	if (grant.agent !== request.agent) return false;
	if (grant.scope.goalId && grant.scope.goalId !== request.goalId) return false;
	if (grant.expiresAt) {
		const now = Date.parse(request.nowIso ?? new Date().toISOString());
		const expiry = Date.parse(grant.expiresAt);
		if (Number.isFinite(expiry) && Number.isFinite(now) && now >= expiry) return false;
	}
	return true;
}

/** Count spend entries for `grantId` among already-decoded custom-entry payloads (the caller walks the
 * session branch and passes the raw `data` values — this stays pure/session-agnostic). */
export function countGrantUsages(grantId: string, usageEntries: readonly unknown[]): number {
	let count = 0;
	for (const entry of usageEntries) if (isTmuxDispatchGrantUsage(entry) && entry.grantId === grantId) count++;
	return count;
}

export function isGrantBudgetExhausted(grant: TmuxDispatchGrant, usedCount: number): boolean {
	return usedCount >= grant.budget.maxLaunches;
}

export function buildGrantUsageEntry(
	grantId: string,
	jobId: string,
	nowIso = new Date().toISOString(),
): TmuxDispatchGrantUsage {
	return { grantId, jobId, at: nowIso };
}

export function buildTombstone(grantId: string, nowIso = new Date().toISOString()): TmuxDispatchGrantTombstone {
	return { tombstone: true, grantId, revokedAt: nowIso };
}

export interface GrantDispatchParams {
	agent: Provider;
	goalId?: string;
	allowedTools?: string[];
	resourceProfile?: string;
	writePaths?: string[];
	maxLaunches: number;
	expiresInMinutes?: number;
	maxUsdAdvisory?: number;
}

/** Build a new grant record from `grant_dispatch` params. Pure — the caller (index.ts) owns the
 * approval gate (ui.confirm / opt-in flag) and the `pi.appendEntry` persistence; this only shapes the
 * data, so it stays independently testable and never itself decides whether creation is authorized. */
export function buildGrant(params: GrantDispatchParams, nowIso = new Date().toISOString()): TmuxDispatchGrant {
	if (!Number.isFinite(params.maxLaunches) || params.maxLaunches < 1)
		throw new Error("grant_dispatch requires maxLaunches >= 1");
	const expiresAt =
		params.expiresInMinutes !== undefined
			? new Date(Date.parse(nowIso) + Math.max(1, params.expiresInMinutes) * 60_000).toISOString()
			: undefined;
	return {
		grantId: makeGrantId(),
		createdAt: nowIso,
		agent: params.agent,
		scope: { goalId: params.goalId },
		envelope: {
			allowedTools: params.allowedTools,
			resourceProfile: params.resourceProfile,
			writePaths: params.writePaths,
		},
		budget: {
			maxLaunches: Math.trunc(params.maxLaunches),
			maxUsdAdvisory: params.maxUsdAdvisory,
		},
		expiresAt,
	};
}

export function describeGrant(grant: TmuxDispatchGrant): string {
	return [
		`Grant id: ${grant.grantId}`,
		`Agent: ${grant.agent}`,
		grant.scope.goalId ? `Goal scope: ${grant.scope.goalId}` : "Goal scope: none (covers any goal)",
		`Max launches: ${grant.budget.maxLaunches}`,
		grant.expiresAt ? `Expires: ${grant.expiresAt}` : "Expires: never (until revoke_grant)",
		grant.envelope.allowedTools?.length
			? `Allowed tools: ${grant.envelope.allowedTools.join(", ")}`
			: `Allowed tools: read-biased safe default (${DEFAULT_READ_BIASED_TOOLS.join(", ")})`,
		grant.envelope.resourceProfile
			? `Resource profile: ${grant.envelope.resourceProfile}`
			: "Resource profile: none (child launches with --no-extensions --no-skills)",
		grant.envelope.writePaths?.length
			? `Write paths: ${grant.envelope.writePaths.join(", ")}`
			: "Write paths: none declared",
		grant.budget.maxUsdAdvisory !== undefined
			? `Advisory USD cap: ${grant.budget.maxUsdAdvisory} (not enforced across the process boundary — advisory only)`
			: undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Launch-profile flags: the REAL lever — pushed into the child `pi` CLI's own config.
// ---------------------------------------------------------------------------

export const DEFAULT_READ_BIASED_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export interface LaunchProfileSource {
	/** Human-readable identity for the scoped system prompt (e.g. "grant <id>" or a one-shot label). */
	identity: string;
	allowedTools?: string[];
	resourceProfile?: string;
	writePaths?: string[];
	/**
	 * Worktree-sync lane key this launch is bound to (per-agent -- see `applyLaunchProfile`'s caller,
	 * which builds a per-agent `LaunchProfileSource` only when that agent carries `worktreeLane`).
	 * When present, `buildLaunchProfileFlags` appends `--worktree-lane <key>` (the same CLI flag
	 * `src/cli/args.ts` already exposes, sugar over the `PI_WORKTREE_LANE` env contract) and
	 * `buildScopedSystemPrompt` appends one lane-doctrine sentence.
	 */
	worktreeLane?: string;
	/**
	 * Process-matrix parent identity for this launch (see `core/process-matrix/runtime.ts`): the
	 * dispatching process's own pid/sessionId. When present, `buildLaunchProfileFlags` appends
	 * `--parent-pid`/`--parent-session` (sugar over `PI_PARENT_PID`/`PI_PARENT_SESSION`) so the
	 * child self-registers as a worker of this session and winds down gracefully if it disappears.
	 */
	parentPid?: number;
	parentSession?: string;
}

/** A grant-covered launch derives its profile from the grant's envelope. */
export function launchProfileSourceFromGrant(grant: TmuxDispatchGrant): LaunchProfileSource {
	return {
		identity: `grant ${grant.grantId}`,
		allowedTools: grant.envelope.allowedTools,
		resourceProfile: grant.envelope.resourceProfile,
		writePaths: grant.envelope.writePaths,
	};
}

/** A one-shot interactively-approved launch (no standing grant) still gets the conservative default
 * profile — approving a single launch is not the same as defining an unrestricted envelope. */
export const ONE_SHOT_LAUNCH_PROFILE_SOURCE: LaunchProfileSource = {
	identity: "a one-shot owner-approved tmux dispatch (no standing grant)",
};

export interface LaunchProfileFlag {
	flag: string;
	value?: string;
}

/** Build the CLI flags to append to a child `pi` invocation so the grant's envelope lives in the
 * child's OWN launch config (verified flag names: --tools, --resource-profile, --no-extensions,
 * --no-skills, --append-system-prompt). Never includes --no-approve: the child must keep gating its
 * own hard stops. */
export function buildLaunchProfileFlags(source: LaunchProfileSource): LaunchProfileFlag[] {
	const tools = source.allowedTools?.length ? source.allowedTools : DEFAULT_READ_BIASED_TOOLS;
	const flags: LaunchProfileFlag[] = [{ flag: "--tools", value: tools.join(",") }];
	if (source.resourceProfile) flags.push({ flag: "--resource-profile", value: source.resourceProfile });
	else flags.push({ flag: "--no-extensions" }, { flag: "--no-skills" });
	if (source.worktreeLane) flags.push({ flag: "--worktree-lane", value: source.worktreeLane });
	if (source.parentPid !== undefined) flags.push({ flag: "--parent-pid", value: String(source.parentPid) });
	if (source.parentSession) flags.push({ flag: "--parent-session", value: source.parentSession });
	flags.push({ flag: "--append-system-prompt", value: buildScopedSystemPrompt(source) });
	return flags;
}

export function buildScopedSystemPrompt(source: LaunchProfileSource): string {
	const paths = source.writePaths?.length ? source.writePaths.join(", ") : "no additional paths granted";
	const sentences = [
		`You are a tmux worker dispatched under ${source.identity}.`,
		`Stay within these write paths: ${paths}.`,
		"Hard stops — publishing/npm, git push, tagging a release, changing credentials/auth, or destructive deletion — require returning BLOCKED for owner approval. Never self-approve a hard stop.",
	];
	if (source.worktreeLane) {
		sentences.push(
			`You are bound to worktree-sync lane '${source.worktreeLane}': work only inside this lane's own worktree, integrate exclusively via worktree_sync land, and never touch main directly.`,
		);
	}
	return sentences.join(" ");
}

// ---------------------------------------------------------------------------
// Advisory worker usage claim: budget stays advisory across the process boundary.
// ---------------------------------------------------------------------------

/** Permissively decode a worker-reported usage CLAIM (a cooperative worker may write this to a
 * well-known sibling file before printing its completion marker). Read-defensive: missing/malformed
 * numeric fields default to 0 rather than throwing — this is untrusted, OPTIONAL, advisory input, never
 * an authoritative billing record. Returns undefined only when `raw` isn't even an object, so the
 * caller can distinguish "no claim offered" (skip reporting) from "a claim was offered" (report it,
 * however partial). */
export function decodeTmuxWorkerUsageClaim(raw: unknown): Usage | undefined {
	if (!isPlainRecord(raw)) return undefined;
	const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const cost = isPlainRecord(raw.cost) ? raw.cost : {};
	return {
		input: num(raw.input),
		output: num(raw.output),
		cacheRead: num(raw.cacheRead),
		cacheWrite: num(raw.cacheWrite),
		totalTokens: num(raw.totalTokens),
		cost: {
			input: num(cost.input),
			output: num(cost.output),
			cacheRead: num(cost.cacheRead),
			cacheWrite: num(cost.cacheWrite),
			total: num(cost.total),
		},
	};
}

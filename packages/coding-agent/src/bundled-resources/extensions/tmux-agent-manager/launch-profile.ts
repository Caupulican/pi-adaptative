import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { Usage } from "@caupulican/pi-ai";
import { mapToolNamesForPlatform } from "../../../core/default-tool-surface.ts";
import { WORKER_FORBIDDEN_TOOLS } from "../../../core/session-role.ts";
import { POLICY_OWNED_RUNTIME_TOOL_NAMES } from "../../../core/tool-capability-policy.ts";

export type Provider = "pi" | "codex" | "agy" | "claude" | "opencode" | "custom";

const MANAGED_WORKER_TOOL_NAMES = POLICY_OWNED_RUNTIME_TOOL_NAMES.filter((tool) => !WORKER_FORBIDDEN_TOOLS.has(tool));
const MANAGED_WORKER_TOOL_NAME_SET: ReadonlySet<string> = new Set(MANAGED_WORKER_TOOL_NAMES);

/** Full host-auditable Pi worker surface after the shared worker ceiling removes agent launchers
 * and root-owned durable mutation controls. */
export const DEFAULT_MANAGED_WORKER_TOOLS: readonly string[] = Object.freeze([...MANAGED_WORKER_TOOL_NAMES]);

export class WorkerLaunchProfileError extends Error {
	readonly code = "worker_profile_tools_rejected" as const;
	readonly rejectedTools: readonly string[];

	constructor(rejectedTools: readonly string[]) {
		const displayNames = rejectedTools.map((tool) => (tool ? `'${tool}'` : "<empty>"));
		super(`Worker profile requested unavailable or forbidden tools: ${displayNames.join(", ")}.`);
		this.name = "WorkerLaunchProfileError";
		this.rejectedTools = Object.freeze([...rejectedTools]);
	}
}

export interface WorkerLaunchProfileInput {
	identity: string;
	inheritedTools?: readonly string[];
	allowedTools?: readonly string[];
	resourceProfile?: string;
	resourceProfileJson?: string;
	writePaths?: readonly string[];
	thinkingLevel?: ThinkingLevel;
	worktreeLane?: string;
	parentPid?: number;
	parentSession?: string;
	taskRef?: string;
}

/** Immutable profile compiled once before a managed process is reserved or launched. Empty
 * `writePaths` means the host-derived machine-root scope; a non-empty list is an explicit narrowing. */
export interface WorkerLaunchProfile {
	readonly identity: string;
	readonly allowedTools: readonly string[];
	readonly resourceProfile?: string;
	readonly resourceProfileJson?: string;
	readonly writePaths: readonly string[];
	readonly thinkingLevel?: ThinkingLevel;
	readonly worktreeLane?: string;
	readonly parentPid?: number;
	readonly parentSession?: string;
	readonly taskRef?: string;
}

function normalizeToolNames(tools: readonly string[]): string[] {
	return mapToolNamesForPlatform(tools.map((tool) => tool.trim().toLowerCase()));
}

function uniqueClassifiedTools(tools: readonly string[]): string[] {
	const selected = new Set(normalizeToolNames(tools).filter((tool) => tool.length > 0));
	return MANAGED_WORKER_TOOL_NAMES.filter((tool) => selected.has(tool));
}

export function deriveWorkerLaunchProfile(input: WorkerLaunchProfileInput): WorkerLaunchProfile {
	if (input.allowedTools !== undefined) {
		const inheritedToolSet =
			input.inheritedTools === undefined
				? MANAGED_WORKER_TOOL_NAME_SET
				: new Set(uniqueClassifiedTools(input.inheritedTools));
		const rejectedTools = [
			...new Set(
				normalizeToolNames(input.allowedTools).filter(
					(tool) => !MANAGED_WORKER_TOOL_NAME_SET.has(tool) || !inheritedToolSet.has(tool),
				),
			),
		];
		if (rejectedTools.length > 0) throw new WorkerLaunchProfileError(rejectedTools);
	}
	const sourceTools = input.allowedTools ?? input.inheritedTools ?? DEFAULT_MANAGED_WORKER_TOOLS;
	const allowedTools = Object.freeze(uniqueClassifiedTools(sourceTools));
	const writePaths = Object.freeze([
		...new Set(input.writePaths?.map((entry) => entry.trim()).filter((entry) => entry.length > 0) ?? []),
	]);
	return Object.freeze({
		identity: input.identity,
		allowedTools,
		writePaths,
		...(input.resourceProfile ? { resourceProfile: input.resourceProfile } : {}),
		...(input.resourceProfileJson ? { resourceProfileJson: input.resourceProfileJson } : {}),
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		...(input.worktreeLane ? { worktreeLane: input.worktreeLane } : {}),
		...(input.parentPid !== undefined ? { parentPid: input.parentPid } : {}),
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
		...(input.taskRef ? { taskRef: input.taskRef } : {}),
	});
}

export interface LaunchProfileFlag {
	flag: string;
	value?: string;
}

/** Render a Pi child's immutable profile into its own CLI configuration. The manager supplies either
 * an explicit resource-profile override or a one-shot snapshot of the parent's effective resources;
 * standalone callers that omit both retain the child's normal resources. */
export function buildLaunchProfileFlags(profile: WorkerLaunchProfile): LaunchProfileFlag[] {
	const flags: LaunchProfileFlag[] = profile.allowedTools.length
		? [{ flag: "--tools", value: profile.allowedTools.join(",") }]
		: [{ flag: "--no-tools" }];
	if (profile.resourceProfileJson) flags.push({ flag: "--resource-profile-json", value: profile.resourceProfileJson });
	if (profile.resourceProfile) flags.push({ flag: "--resource-profile", value: profile.resourceProfile });
	if (profile.thinkingLevel) flags.push({ flag: "--thinking", value: profile.thinkingLevel });
	if (profile.worktreeLane) flags.push({ flag: "--worktree-lane", value: profile.worktreeLane });
	if (profile.parentPid !== undefined) flags.push({ flag: "--parent-pid", value: String(profile.parentPid) });
	if (profile.parentSession) flags.push({ flag: "--parent-session", value: profile.parentSession });
	if (profile.taskRef) flags.push({ flag: "--task-ref", value: profile.taskRef });
	flags.push({ flag: "--append-system-prompt", value: buildScopedSystemPrompt(profile) });
	flags.push({ flag: "--session-mode", value: "worker" });
	return flags;
}

export function buildScopedSystemPrompt(profile: WorkerLaunchProfile): string {
	const scope = profile.writePaths.length
		? `Structural filesystem tools are limited to: ${profile.writePaths.join(", ")}. Process tools retain host access and must honor this assigned scope.`
		: "Filesystem authority inherits the host's full-machine worker scope except private harness paths.";
	const sentences = [
		`You are a tmux worker running under immutable profile ${profile.identity}.`,
		scope,
		"Work autonomously to completion with the allowed tools; do not ask for routine permission inside the assigned task.",
		"Do not spawn or delegate to other agents.",
		"Report BLOCKED only when the objective is genuinely impossible with the assigned profile or missing external information.",
	];
	if (profile.worktreeLane) {
		sentences.push(
			`You are bound to worktree-sync lane '${profile.worktreeLane}': work only inside this lane's own worktree, integrate exclusively via worktree_sync land, and never touch main directly.`,
		);
	}
	return sentences.join(" ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode an optional cooperative worker usage claim. Malformed numeric fields are zeroed because
 * the claim is advisory and must never become an authoritative billing record. */
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

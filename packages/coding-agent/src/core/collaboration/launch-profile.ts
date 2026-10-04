import * as path from "node:path";
import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { Usage } from "@caupulican/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { mapToolNamesForPlatform, STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import { ORCHESTRATION_THINKING_LEVEL_SCHEMA } from "../orchestration/thinking-level-schema.ts";
import { POLICY_OWNED_RUNTIME_TOOL_NAMES } from "../tool-capability-policy.ts";
import { isRecordObject as isPlainRecord } from "../util/value-guards.ts";
import { MAX_WORKER_EXTENSION_TOOL_GRANTS } from "../worker-extension-grants.ts";
import { isExtensionToolGrantable, isWorkerProcessToolAllowed } from "../worker-tool-ceiling.ts";

export type Provider = "pi" | "codex" | "agy" | "claude" | "opencode" | "custom";

const MANAGED_WORKER_TOOL_NAMES = POLICY_OWNED_RUNTIME_TOOL_NAMES.filter((tool) => isWorkerProcessToolAllowed(tool));
const MANAGED_WORKER_TOOL_NAME_SET: ReadonlySet<string> = new Set(MANAGED_WORKER_TOOL_NAMES);

/** The host-auditable managed Pi worker surface: the worker process allow-list
 * (`WORKER_PROCESS_ALLOWED_TOOLS`) restricted to tools the capability catalogue classifies. */
export const DEFAULT_MANAGED_WORKER_TOOLS: readonly string[] = Object.freeze([...MANAGED_WORKER_TOOL_NAMES]);

export class WorkerLaunchProfileError extends Error {
	readonly code = "worker_profile_tools_rejected" as const;
	readonly rejectedTools: readonly string[];
	/** Actionable reason per rejected tool (only where the rejection has a specific, fixable cause). */
	readonly reasons: Readonly<Record<string, string>>;

	constructor(rejectedTools: readonly string[], reasons: Readonly<Record<string, string>> = {}) {
		const displayNames = rejectedTools.map((tool) => (tool ? `'${tool}'` : "<empty>"));
		const detail = rejectedTools
			.filter((tool) => reasons[tool] !== undefined)
			.map((tool) => ` ${tool ? `'${tool}'` : "<empty>"}: ${reasons[tool]}`)
			.join("");
		super(`Worker profile requested unavailable or forbidden tools: ${displayNames.join(", ")}.${detail}`);
		this.name = "WorkerLaunchProfileError";
		this.rejectedTools = Object.freeze([...rejectedTools]);
		this.reasons = Object.freeze({ ...reasons });
	}
}

/** One extension-provided tool known to the launching session: its name and the file that registers it. */
export interface ExtensionToolSource {
	readonly name: string;
	readonly extensionPath: string;
}

export interface WorkerLaunchProfileInput {
	identity: string;
	inheritedTools?: readonly string[];
	allowedTools?: readonly string[];
	/**
	 * Extension-provided tools of the launching session. A name in `allowedTools` that is not a worker
	 * builtin is granted only when it resolves here (and is on the launcher's own active surface); the worker
	 * process then loads that one extension and admits that one tool. Never granted by default.
	 */
	extensionTools?: readonly ExtensionToolSource[];
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
const profileText = Type.String({ maxLength: 4096 });
export const workerLaunchProfileSchema = Type.Object(
	{
		identity: Type.String({ minLength: 1, maxLength: 4096 }),
		allowedTools: Type.Array(profileText, { maxItems: 128 }),
		extensionToolGrants: Type.Optional(
			Type.Array(
				Type.Object(
					{ tool: Type.String({ minLength: 1, maxLength: 256 }), extensionPath: profileText },
					{ additionalProperties: false },
				),
				{ maxItems: MAX_WORKER_EXTENSION_TOOL_GRANTS },
			),
		),
		writePaths: Type.Array(profileText, { maxItems: 128 }),
		resourceProfile: Type.Optional(profileText),
		resourceProfileJson: Type.Optional(Type.String({ maxLength: 32768 })),
		thinkingLevel: Type.Optional(ORCHESTRATION_THINKING_LEVEL_SCHEMA),
		worktreeLane: Type.Optional(profileText),
		parentPid: Type.Optional(Type.Integer({ minimum: 1 })),
		parentSession: Type.Optional(profileText),
		taskRef: Type.Optional(profileText),
	},
	{ additionalProperties: false },
);
export type WorkerLaunchProfile = Readonly<
	Omit<Static<typeof workerLaunchProfileSchema>, "allowedTools" | "writePaths" | "extensionToolGrants">
> & {
	readonly allowedTools: readonly string[];
	readonly writePaths: readonly string[];
	readonly extensionToolGrants?: readonly { readonly tool: string; readonly extensionPath: string }[];
};

/** Native result reporting cannot silently add process authority to a read-only Pi profile. */
export function assertCollaborationReportCapability(provider: string, profile: WorkerLaunchProfile): void {
	if (provider === "pi" && !profile.allowedTools.some((tool) => tool === STABLE_SHELL_TOOL_NAME || tool === "python"))
		throw new Error(
			"Collaboration work requires an already-granted bash or python tool for authenticated result reporting; the profile will not be widened.",
		);
}

function normalizeToolNames(tools: readonly string[]): string[] {
	return mapToolNamesForPlatform(tools.map((tool) => tool.trim().toLowerCase()));
}

function uniqueClassifiedTools(tools: readonly string[]): string[] {
	const selected = new Set(normalizeToolNames(tools).filter((tool) => tool.length > 0));
	return MANAGED_WORKER_TOOL_NAMES.filter((tool) => selected.has(tool));
}

function extensionToolRejection(
	requested: string,
	extensionTools: readonly ExtensionToolSource[],
	inheritedToolNames: ReadonlySet<string> | undefined,
): { grant: ExtensionToolSource } | { reason: string } {
	const source =
		extensionTools.find((entry) => entry.name === requested) ??
		extensionTools.find((entry) => entry.name.toLowerCase() === requested.toLowerCase());
	if (!source) {
		if (!isExtensionToolGrantable(requested.toLowerCase())) {
			return {
				reason:
					"a harness-owned tool that is not part of the worker-process surface (forbidden for workers, or not allow-listed); an extension tool grant can never carry that authority.",
			};
		}
		return {
			reason:
				"not a worker-process builtin tool and not provided by any extension loaded in the launching session; load the extension that provides it there, or remove the tool from the profile.",
		};
	}
	if (!isExtensionToolGrantable(source.name)) {
		return {
			reason:
				"names a harness-owned tool (forbidden for workers, or a capability-catalogued builtin); an extension tool grant can never carry that authority.",
		};
	}
	if (!path.isAbsolute(source.extensionPath) && !path.win32.isAbsolute(source.extensionPath)) {
		return {
			reason: `provided by '${source.extensionPath}', which is not an extension file a worker process can load; grant tools only from extensions loaded from a file.`,
		};
	}
	if (inheritedToolNames && !inheritedToolNames.has(source.name)) {
		return {
			reason:
				"not active in the launching session; a profile cannot grant a worker a tool its launcher does not hold.",
		};
	}
	return { grant: source };
}

export function deriveWorkerLaunchProfile(input: WorkerLaunchProfileInput): WorkerLaunchProfile {
	const extensionGrants = new Map<string, ExtensionToolSource>();
	let builtinRequests: readonly string[] | undefined;
	if (input.allowedTools !== undefined) {
		const inheritedToolSet =
			input.inheritedTools === undefined
				? MANAGED_WORKER_TOOL_NAME_SET
				: new Set(uniqueClassifiedTools(input.inheritedTools));
		const inheritedExtensionToolNames =
			input.inheritedTools === undefined ? undefined : new Set(input.inheritedTools.map((tool) => tool.trim()));
		const rejectedTools = new Set<string>();
		const reasons: Record<string, string> = {};
		const builtin: string[] = [];
		for (const requested of input.allowedTools) {
			const normalized = normalizeToolNames([requested])[0] ?? "";
			if (MANAGED_WORKER_TOOL_NAME_SET.has(normalized)) {
				if (inheritedToolSet.has(normalized)) builtin.push(normalized);
				else rejectedTools.add(normalized);
				continue;
			}
			const trimmed = requested.trim();
			if (trimmed.length === 0 || !input.extensionTools) {
				rejectedTools.add(normalized);
				continue;
			}
			const outcome = extensionToolRejection(trimmed, input.extensionTools, inheritedExtensionToolNames);
			if ("grant" in outcome) extensionGrants.set(outcome.grant.name, outcome.grant);
			else {
				rejectedTools.add(normalized);
				reasons[normalized] = outcome.reason;
			}
		}
		if (rejectedTools.size > 0) throw new WorkerLaunchProfileError([...rejectedTools], reasons);
		builtinRequests = builtin;
	}
	if (extensionGrants.size > MAX_WORKER_EXTENSION_TOOL_GRANTS) {
		throw new Error(`A worker profile may grant at most ${MAX_WORKER_EXTENSION_TOOL_GRANTS} extension tools.`);
	}
	const sourceTools = builtinRequests ?? input.inheritedTools ?? DEFAULT_MANAGED_WORKER_TOOLS;
	const extensionToolGrants = [...extensionGrants.values()].map((entry) =>
		Object.freeze({ tool: entry.name, extensionPath: entry.extensionPath }),
	);
	const allowedTools = Object.freeze([
		...uniqueClassifiedTools(sourceTools),
		...extensionToolGrants.map((grant) => grant.tool),
	]);
	const writePaths = Object.freeze([
		...new Set(input.writePaths?.map((entry) => entry.trim()).filter((entry) => entry.length > 0) ?? []),
	]);
	const profile: WorkerLaunchProfile = {
		identity: input.identity,
		allowedTools,
		writePaths,
		...(extensionToolGrants.length > 0 ? { extensionToolGrants: Object.freeze(extensionToolGrants) } : {}),
		...(input.resourceProfile ? { resourceProfile: input.resourceProfile } : {}),
		...(input.resourceProfileJson ? { resourceProfileJson: input.resourceProfileJson } : {}),
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		...(input.worktreeLane ? { worktreeLane: input.worktreeLane } : {}),
		...(input.parentPid !== undefined ? { parentPid: input.parentPid } : {}),
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
		...(input.taskRef ? { taskRef: input.taskRef } : {}),
	};
	if (!Value.Check(workerLaunchProfileSchema, profile)) throw new Error("Invalid worker launch profile.");
	return Object.freeze(profile);
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
		: "Structural filesystem tools read anywhere on the host and write inside your working directory; harness and private paths stay denied. A wider write root is an explicit grant from the dispatch.";
	const sentences = [
		`You are a persistent collaboration worker running under immutable profile ${profile.identity}.`,
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

const usageNumber = Type.Number();
export const collaborationUsageSchema = Type.Object(
	{
		input: usageNumber,
		output: usageNumber,
		cacheRead: usageNumber,
		cacheWrite: usageNumber,
		totalTokens: usageNumber,
		cost: Type.Object(
			{
				input: usageNumber,
				output: usageNumber,
				cacheRead: usageNumber,
				cacheWrite: usageNumber,
				total: usageNumber,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

/** Decode an optional cooperative worker usage claim. Malformed numeric fields are zeroed because
 * the claim is advisory and must never become an authoritative billing record. */
export function decodeCollaborationUsageClaim(raw: unknown): Usage | undefined {
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

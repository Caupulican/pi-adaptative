import path from "node:path";
import type { AgentLoopConfig, AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import type { NormalizedProfile } from "../profile-registry.ts";
import { matchesResourceProfilePattern } from "../settings-manager.ts";
import { createEditTool } from "../tools/edit.ts";
import { createFindTool } from "../tools/find.ts";
import { createGrepTool } from "../tools/grep.ts";
import { createLsTool } from "../tools/ls.ts";
import { createReadTool } from "../tools/read.ts";
import { createWriteTool } from "../tools/write.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { evaluateToolGate } from "./gates.ts";

const READ_ONLY_LANE_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const MEMORY_LANE_TOOL_NAME = "memory" as const;
const WRITE_LANE_TOOL_NAMES = ["write", "edit"] as const;
const laneMemorySchema = Type.Object({
	query: Type.String({ description: "What relevant standing memory or prior evidence to retrieve" }),
});
type LaneMemoryParams = Static<typeof laneMemorySchema>;
const WRITE_LANE_TOOL_NAME_SET = new Set<string>(WRITE_LANE_TOOL_NAMES);

export interface LaneToolSurface {
	/** Fresh tools owned by this lane only; no foreground tool instances or extension state leak in. */
	tools: AgentTool[];
	/** Exact names after profile globs are expanded. Safe to persist in a capability envelope. */
	allowedTools: string[];
	/** Exact safe-candidate names denied by the profile's block patterns. */
	deniedTools: string[];
	/** Explicit grants that bind to no classified lane candidate (opaque tools stay fail-closed). */
	unboundAllowPatterns: string[];
	/** Per-call path and capability gate for the isolated child loop. */
	beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
}

export interface LaneToolSurfaceOptions {
	cwd: string;
	profile?: NormalizedProfile;
	/** Private harness state that generic file tools must never traverse. */
	deniedPaths?: readonly string[];
	/** Orchestrator-requested, policy-filtered read-only memory retrieval. Omitted means no memory tool. */
	readMemory?: (query: string) => Promise<string>;
	/** Research never sets this. Workers require both this flag and at least one write path. */
	writeEnabled?: boolean;
	writePaths?: readonly string[];
}

function strictLaneProfilePatterns(profile: NormalizedProfile | undefined): {
	allow: string[];
	block: string[];
} {
	if (!profile) return { allow: [], block: [] };
	const filter = profile.resources.tools;
	const allow = [...(filter?.allow ?? [])];
	const block = [...(filter?.block ?? [])];
	// Strict UAC: a shipped profile is the complete authority grant. Grant-all must be explicit.
	if (allow.length === 0 && block.length === 0) return { allow: [], block: ["*"] };
	return { allow, block };
}

function resolveWriteRoots(cwd: string, writePaths: readonly string[]): string[] {
	return writePaths.map((entry) => (path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(cwd, entry)));
}

function createLaneTools(
	cwd: string,
	names: readonly string[],
	readMemory?: (query: string) => Promise<string>,
): AgentTool[] {
	const factories = new Map<string, () => AgentTool>([
		["read", () => createReadTool(cwd)],
		["grep", () => createGrepTool(cwd)],
		["find", () => createFindTool(cwd)],
		["ls", () => createLsTool(cwd)],
		["write", () => createWriteTool(cwd)],
		["edit", () => createEditTool(cwd)],
	]);
	if (readMemory) {
		factories.set(MEMORY_LANE_TOOL_NAME, () => ({
			name: MEMORY_LANE_TOOL_NAME,
			label: "Read Memory",
			description:
				"Retrieve bounded, source-labeled standing memory relevant to this delegated task. Read-only: no memory writes or lifecycle actions are available.",
			parameters: laneMemorySchema,
			execute: async (_toolCallId, params) => {
				const { query } = params as LaneMemoryParams;
				return {
					content: [{ type: "text" as const, text: await readMemory(query) }],
					details: { readOnly: true },
				};
			},
		}));
	}
	return names.flatMap((name) => {
		const factory = factories.get(name);
		return factory ? [factory()] : [];
	});
}

/**
 * Materialize a fresh, fail-closed tool surface for one isolated lane.
 *
 * Profiles select only from classified built-ins. Opaque extension tools, shell, memory, goals,
 * and `delegate` are never candidates, so a wildcard cannot manufacture unknown authority or
 * recursively spawn more workers. Write/edit additionally require the explicit worker write switch
 * and a non-empty path scope; research therefore stays read-only regardless of profile contents.
 */
export function createLaneToolSurface(options: LaneToolSurfaceOptions): LaneToolSurface {
	const writeCapable = options.writeEnabled === true && (options.writePaths?.length ?? 0) > 0;
	const candidateNames = [
		...READ_ONLY_LANE_TOOL_NAMES,
		...(options.readMemory ? [MEMORY_LANE_TOOL_NAME] : []),
		...(writeCapable ? WRITE_LANE_TOOL_NAMES : []),
	];
	const patterns = strictLaneProfilePatterns(options.profile);
	const deniedTools = candidateNames.filter((name) => matchesResourceProfilePattern(name, patterns.block));
	const unboundAllowPatterns = patterns.allow.filter(
		(pattern) => !candidateNames.some((name) => matchesResourceProfilePattern(name, [pattern])),
	);
	const allowedTools = candidateNames.filter(
		(name) =>
			(patterns.allow.length === 0 || matchesResourceProfilePattern(name, patterns.allow)) &&
			!matchesResourceProfilePattern(name, patterns.block),
	);
	const allowedToolSet = new Set<string>(allowedTools);
	const deniedPaths = options.deniedPaths?.map((entry) => path.resolve(entry));
	const readEnvelope: CapabilityEnvelope = {
		id: "isolated-lane-read-tools",
		capabilities: ["read_files", ...(allowedToolSet.has(MEMORY_LANE_TOOL_NAME) ? (["memory_read"] as const) : [])],
		allowedTools,
		deniedTools,
		allowedPaths: [path.resolve(options.cwd)],
		...(deniedPaths && deniedPaths.length > 0 ? { deniedPaths } : {}),
	};
	const writeEnvelope: CapabilityEnvelope = {
		id: "isolated-lane-write-tools",
		capabilities: ["write_files"],
		allowedTools,
		deniedTools,
		allowedPaths: resolveWriteRoots(options.cwd, options.writePaths ?? []),
		...(deniedPaths && deniedPaths.length > 0 ? { deniedPaths } : {}),
	};

	return {
		tools: createLaneTools(options.cwd, allowedTools, options.readMemory),
		allowedTools,
		deniedTools,
		unboundAllowPatterns,
		beforeToolCall: async ({ toolCall, args }) => {
			if (!allowedToolSet.has(toolCall.name)) {
				return { block: true, reason: `Lane tool '${toolCall.name}' is outside the materialized UAC surface.` };
			}
			const outcome = evaluateToolGate({
				toolName: toolCall.name,
				args,
				cwd: options.cwd,
				envelope: WRITE_LANE_TOOL_NAME_SET.has(toolCall.name) ? writeEnvelope : readEnvelope,
			});
			if (outcome.outcome === "allow") return undefined;
			return {
				block: true,
				reason: `Lane tool blocked (${outcome.reasonCode}): ${outcome.message ?? "capability gate denied it"}`,
			};
		},
	};
}

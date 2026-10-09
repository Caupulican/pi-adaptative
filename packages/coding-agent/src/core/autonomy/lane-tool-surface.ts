import path from "node:path";
import { TOOL_SCHEMA_SEARCH_NAME } from "@caupulican/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentLoopConfig, AgentTool, BeforeToolCallResult } from "../../kernel/index.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { PathAliasTable } from "../context/path-alias-table.ts";
import { wrapToolWithPathAliasExpansion } from "../context/path-alias-tool-wrap.ts";
import { STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import { settleIndependentLifecycle } from "../lifecycle-settlement.ts";
import { WORKER_MEMORY_READ_TOOL_NAME, type WorkerMemoryBroker } from "../memory/worker-memory-tools.ts";
import { readOnlyShellViolation } from "../model-router/tool-escalation.ts";
import {
	CapabilityGateway,
	CapabilityGatewayDeniedError,
	type GatewayInitialUsage,
	type SharedCapabilityBudget,
} from "../orchestration/capability-gateway.ts";
import type {
	ExecutionGrant,
	OrchestrationExecutionPolicy,
	ToolCapabilityManifest,
} from "../orchestration/contracts.ts";
import type { NormalizedProfile } from "../profile-registry.ts";
import {
	type CredentialExposureBoundary,
	wrapToolWithCredentialExposureGuard,
} from "../secrets/credential-exposure-guard.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { matchesResourceProfilePattern } from "../settings/settings-rules.ts";
import { wrapToolWithVerification } from "../system-one/session-verification-host.ts";
import type { VerificationCoordinator } from "../system-one/verification-coordinator.ts";
import { READ_ONLY_SHELL_TOOL_NAMES, toolSurvivesReadOnly } from "../tool-capability-policy.ts";
import { type BashToolOptions, createBashTool } from "../tools/bash.ts";
import { createEditTool, type EditToolOptions } from "../tools/edit.ts";
import { FileMutationIntentController } from "../tools/file-mutation-intent.ts";
import { mutationScopeForWorktree } from "../tools/file-mutation-queue.ts";
import { createFindTool } from "../tools/find.ts";
import { createGrepTool } from "../tools/grep.ts";
import { createLsTool } from "../tools/ls.ts";
import { createPythonTool, type PythonToolOptions } from "../tools/python.ts";
import { createReadTool, type ReadToolOptions } from "../tools/read.ts";
import { createRepoReadTool } from "../tools/repo-read.ts";
import { createRunProcessTool, type RunProcessToolOptions } from "../tools/run-process.ts";
import { disposeShellExecutionSessionAndWait } from "../tools/shell-execution-session.ts";
import { createToolSchemaSearchDefinition } from "../tools/tool_search.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import { createWriteTool } from "../tools/write.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { classifyYoloBoundary } from "./edge-policy.ts";
import { evaluateToolGate } from "./gates.ts";
import { LaneToolUsage } from "./lane-tool-usage.ts";
import type { ProtectedPathWatch } from "./protected-path-watch.ts";
import { createWorkerRunEnvironment } from "./worker-run-environment.ts";
import type { WorkerToolAdapterRegistry } from "./worker-tool-adapter-registry.ts";

/** What a worker does when a write lands outside its scope: it never routes around the grant, it reports. */
export const WORKER_WRITE_SCOPE_GUIDANCE =
	"A worker writes only inside its working directory plus the roots its dispatcher granted with writePaths. Do not route around this: finish what is in scope and report to the parent the absolute path you need to write and why, so it can start a new worker with writePaths for it (a worker's own write scope cannot be widened).";

/**
 * The tool mechanics every agent shares with root: output reduction, the command prefix and shell,
 * the Windows shell engine, file encodings, and artifact packing. Lane identity (shell session,
 * mutation scope, mutation intents, output directory) stays the lane's own. Credential injection into
 * a shell or python environment is authority, never shared: a worker's commands never see the
 * owner's credentials.
 */
export interface SharedLaneToolOptions {
	/** The parent owns unresolved findings even when a worker executes concrete tools. */
	readonly getVerification?: () => VerificationCoordinator | undefined;
	readonly bash?: Pick<
		BashToolOptions,
		| "outputReduction"
		| "commandPrefix"
		| "shellPath"
		| "platform"
		| "windowsShellPythonEngine"
		| "windowsShellEngineOptions"
		| "spawnHook"
		| "operations"
	>;
	readonly python?: Pick<PythonToolOptions, "outputReduction" | "omitEnvironmentVariables" | "environment">;
	readonly runProcess?: Pick<RunProcessToolOptions, "attributionEnvironment">;
	readonly read?: ReadToolOptions;
	readonly edit?: Pick<EditToolOptions, "fileEncodings">;
	/**
	 * The session's packed tool-output store. grep and find pack into it only on a lane that holds
	 * `artifact_retrieve`, so a packed handle is always resolvable by the agent that sees it.
	 */
	readonly artifactStore?: ArtifactStore;
}

const READ_ONLY_LANE_TOOL_NAMES = ["read", "grep", "find", "ls", "repo_read"] as const;
const WRITE_LANE_TOOL_NAMES = ["write", "edit"] as const;
const PYTHON_LANE_TOOL_NAME = "python" as const;
const PROCESS_LANE_TOOL_NAME = "run_process" as const;
const MAX_LANE_MEMORY_QUERY_CHARS = 4_096;
const MAX_LANE_MEMORY_REF_CHARS = 600;
const laneMemoryFields = Type.Object({
	query: Type.Optional(
		Type.String({
			maxLength: MAX_LANE_MEMORY_QUERY_CHARS,
			description: "What relevant standing memory or prior evidence to retrieve",
		}),
	),
	ref: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_LANE_MEMORY_REF_CHARS,
			description:
				"A transcript source handle (tx:...) or history summary handle (txn:...) cited by an earlier memory_read result in this task; opens its exact text or expands the summary instead of searching",
		}),
	),
	cursor: Type.Optional(
		Type.Integer({ minimum: 0, description: "With ref: byte cursor from the previous page's continuation hint" }),
	),
});
// Exactly one of query (search) or ref (open a cited source); the explicit object root and parent
// properties stay for subscription-provider projection, as in the root memory tool.
const laneMemorySchema = {
	...laneMemoryFields,
	anyOf: [Type.Object({ query: Type.String() }), Type.Object({ ref: Type.String() })],
};
type LaneMemoryParams = Static<typeof laneMemorySchema>;
const WRITE_LANE_TOOL_NAME_SET = new Set<string>(WRITE_LANE_TOOL_NAMES);
const PROCESS_TOOL_NAMES = new Set<string>([STABLE_SHELL_TOOL_NAME, PYTHON_LANE_TOOL_NAME, PROCESS_LANE_TOOL_NAME]);

export interface LaneToolSurface {
	/** Fresh tools owned by this lane only; no foreground tool instances or extension state leak in. */
	tools: AgentTool[];
	/** Release exact mutation payload leases owned by this isolated lane. */
	dispose(): Promise<void>;
	/** Exact names after profile globs are expanded. Safe to persist in a capability envelope. */
	allowedTools: string[];
	/** Exact safe-candidate names denied by the profile's block patterns. */
	deniedTools: string[];
	/** Explicit grants that bind to no classified lane candidate (opaque tools stay fail-closed). */
	unboundAllowPatterns: string[];
	/** Per-call path and capability gate for the isolated worker loop. */
	beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
	/** Canonical cumulative authority/budget meter for a compiled worker grant. */
	gateway?: CapabilityGateway;
	toolUsage: LaneToolUsage;
}

export interface LaneToolSurfaceOptions {
	/** Bypass harness tool, path and edge permission gates for this lane; private state stays denied. */
	yolo?: boolean;
	denyCommands?: readonly string[];
	/**
	 * A `readOnly` grant: the lane keeps only the tools a read-only grant keeps, in every mode. Independent of
	 * `shellReadOnly`, which is about the shell tool's own commands and is false for a lane without a shell.
	 */
	readOnly?: boolean;
	/** A `readOnly` grant: shell commands may not edit anything that exists. */
	shellReadOnly?: boolean;
	cwd: string;
	profile?: NormalizedProfile;
	/** Private harness state that generic file tools must never traverse. */
	deniedPaths?: readonly string[];
	/**
	 * Harness resources the lane may read but never write (skills, extensions, hooks, git config, ...;
	 * `getHarnessWriteProtectedPaths`). Enforced before the YOLO, gateway and envelope branches alike,
	 * so no mode and no explicit write scope can reach them.
	 */
	writeProtectedPaths?: readonly string[];
	/** Orchestrator-requested, policy-filtered read-only memory broker. Omitted means no memory tool. */
	memoryBroker?: WorkerMemoryBroker;
	/** Research never sets this. Workers require both this flag and at least one write path. */
	writeEnabled?: boolean;
	writePaths?: readonly string[];
	/** Present only for process-capable owner profiles; absent means no process tool is materialized. */
	executionPolicy?: OrchestrationExecutionPolicy;
	processMaxWallClockMs?: number;
	/** Stable per-agent shell identity. Omitted when the compiled plan does not grant a host shell. */
	shellSessionKey?: string;
	/**
	 * The worker's own id, the label its commands and git commits carry (committer `pi-worker <label>`). Falls back to
	 * the shell session key, which is longer and gets truncated.
	 */
	workerLabel?: string;
	/**
	 * Fingerprints the harness write-protected set around every process-tool call (bash, python, run_process): a
	 * change is recorded as an attributed finding for the parent's review, never refused or reverted. The caller
	 * reads its findings after the run, before the claim is built.
	 */
	protectedPathWatch?: ProtectedPathWatch;
	/** Told which processes were still running (and so ended) when the worker's tool surface was disposed. */
	onWorkerProcessesReaped?: (processes: readonly string[]) => void;
	/** Host-owned managed directory for complete shell output; never inferred from process-global config. */
	shellOutputDirectory?: string;
	/** Compiled policy path. When present, it is the only authorization source for this surface. */
	grant?: ExecutionGrant;
	toolManifests?: readonly ToolCapabilityManifest[];
	/** Durable cumulative active usage to seed the compiled grant's gateway on resume. */
	initialUsage?: GatewayInitialUsage;
	/** Owner aggregate meter shared across retries and verification for this durable worker task. */
	sharedBudget?: SharedCapabilityBudget;
	/** Host-owned fresh factories for worker-safe foreground/extension tools. */
	workerToolAdapters?: WorkerToolAdapterRegistry;
	/** Host-owned immutable task binding, installed before execution guards. */
	bindTool?: (tool: AgentTool) => AgentTool;
	/** Optional edge authorization port for checking operations against admitted parent authority. */
	checkEdge?: (
		toolName: string,
		args: unknown,
		cwd: string,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
	/** Host-owned path alias table getter for expanding alias tokens in tool arguments. */
	getPathAliasTable?: () => PathAliasTable;
	/** Root's tool mechanics, shared (see {@link SharedLaneToolOptions}). */
	sharedToolOptions?: SharedLaneToolOptions;
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
	fileMutationIntents: FileMutationIntentController,
	mutationScope: string,
	toolUsage: LaneToolUsage,
	privatePathBoundary?: CredentialExposureBoundary,
	memoryBroker?: WorkerMemoryBroker,
	executionPolicy?: OrchestrationExecutionPolicy,
	processMaxWallClockMs = 0,
	shellSessionKey?: string,
	shellOutputDirectory?: string,
	workerToolAdapters?: WorkerToolAdapterRegistry,
	bindTool?: (tool: AgentTool) => AgentTool,
	shared: SharedLaneToolOptions = {},
): AgentTool[] {
	const packing =
		shared.artifactStore && names.includes("artifact_retrieve") ? { artifactStore: shared.artifactStore } : {};
	const factories = new Map<string, () => AgentTool>([
		["read", () => createReadTool(cwd, shared.read)],
		["grep", () => createGrepTool(cwd, packing)],
		["find", () => createFindTool(cwd, packing)],
		["ls", () => createLsTool(cwd)],
		["repo_read", () => createRepoReadTool(cwd)],
		["write", () => createWriteTool(cwd, { intentController: fileMutationIntents })],
		["edit", () => createEditTool(cwd, { ...shared.edit, intentController: fileMutationIntents })],
		[TOOL_SCHEMA_SEARCH_NAME, () => wrapToolDefinition(createToolSchemaSearchDefinition())],
		[
			PYTHON_LANE_TOOL_NAME,
			() =>
				createPythonTool(cwd, {
					...shared.python,
					mutationScope,
					...(shellSessionKey ? { mutationAnnouncer: shellSessionKey } : {}),
				}),
		],
	]);
	if (executionPolicy) {
		factories.set(PROCESS_LANE_TOOL_NAME, () =>
			createRunProcessTool(cwd, {
				...shared.runProcess,
				policy: executionPolicy,
				maxWallClockMs: processMaxWallClockMs,
			}),
		);
	}
	if (shellSessionKey) {
		factories.set(STABLE_SHELL_TOOL_NAME, () =>
			createBashTool(cwd, {
				...shared.bash,
				sessionKey: shellSessionKey,
				mutationScope,
				mutationAnnouncer: shellSessionKey,
				forceCwd: true,
				prewarmWindowsShell: true,
				...(shellOutputDirectory ? { outputDirectory: shellOutputDirectory } : {}),
			}),
		);
	}
	if (memoryBroker) {
		factories.set(WORKER_MEMORY_READ_TOOL_NAME, () => ({
			name: WORKER_MEMORY_READ_TOOL_NAME,
			label: "Read Memory",
			readOnly: true,
			description:
				"Retrieve bounded, source-labeled standing memory relevant to this delegated task (query). Results may cite transcript source handles (tx:...) and history summary handles (txn:...); pass one back as ref (with an optional cursor for tx:) to read that source's exact text or to expand that summary one level. Read-only: no memory writes or lifecycle actions are available.",
			parameters: laneMemorySchema,
			execute: async (_toolCallId, params) => {
				const { query: rawQuery, ref, cursor } = params as LaneMemoryParams;
				if (ref !== undefined) {
					if (rawQuery !== undefined) {
						throw new Error("memory_query_invalid: pass either query or ref, not both.");
					}
					return {
						content: [{ type: "text" as const, text: await memoryBroker.readSource(ref, cursor) }],
						details: { readOnly: true },
					};
				}
				const query = rawQuery?.trim();
				if (!query || query.length > MAX_LANE_MEMORY_QUERY_CHARS) {
					throw new Error(
						`memory_query_invalid: query must contain from 1 through ${MAX_LANE_MEMORY_QUERY_CHARS} characters.`,
					);
				}
				return {
					content: [{ type: "text" as const, text: await memoryBroker.read(query) }],
					details: { readOnly: true },
				};
			},
		}));
	}
	return names.flatMap((name) => {
		const factory = factories.get(name);
		let tool: AgentTool;
		if (factory) tool = factory();
		else {
			if (!workerToolAdapters) return [];
			const materialized = workerToolAdapters.materialize(name, {
				cwd,
				credentialBoundary: privatePathBoundary,
				reportUsage: (toolCallId, usage) => toolUsage.report(toolCallId, usage),
			});
			if (!materialized.ok) throw new Error(materialized.reason);
			tool = materialized.tool;
		}
		// A lane's private-path boundary is authority, not visibility: it denies before running.
		const privateGuarded = wrapToolWithCredentialExposureGuard(
			bindTool ? bindTool(tool) : tool,
			cwd,
			privatePathBoundary,
			"deny",
		);
		const guarded = shared.getVerification
			? wrapToolWithVerification(
					privateGuarded,
					shared.getVerification,
					() => cwd,
					`worker:${shellSessionKey ?? mutationScope}`,
				)
			: privateGuarded;
		return [
			wrapToolExecution(guarded, (executor) => ({
				...executor,
				execute: (toolCallId, ...args) => toolUsage.run(toolCallId, () => executor.execute(toolCallId, ...args)),
			})),
		];
	});
}

/**
 * Materialize a fresh, fail-closed tool surface for one isolated lane.
 *
 * Admission selects only tools this isolated lane can materialize. A compiled grant is the only
 * authority source for worker lanes. Write/edit additionally require the global write switch and a
 * positive path scope.
 */
export function createLaneToolSurface(options: LaneToolSurfaceOptions): LaneToolSurface {
	// The lock scope is the worktree's: a lane working in the parent's directory tree interlocks
	// with the parent's command runs and writes (a lane's write waits for the parent's running
	// build), while a lane in its own worktree shares nothing (see tools/file-mutation-queue.ts).
	const mutationScope = mutationScopeForWorktree(options.cwd);
	const fileMutationIntents = new FileMutationIntentController({
		mutationScope,
		...(options.shellSessionKey ? { mutationAnnouncer: options.shellSessionKey } : {}),
	});
	// YOLO widens a lane to every tool except where the lane is read-only: that is the parent's promise.
	const yoloWrites = options.yolo === true && options.readOnly !== true;
	const writeCapable = yoloWrites || (options.writeEnabled === true && (options.writePaths?.length ?? 0) > 0);
	const pythonCapable =
		yoloWrites || options.toolManifests?.some((manifest) => manifest.toolName === PYTHON_LANE_TOOL_NAME) === true;
	const schemaSearchCapable =
		options.toolManifests?.some((manifest) => manifest.toolName === TOOL_SCHEMA_SEARCH_NAME) === true;
	const builtInCandidateNames = [
		...READ_ONLY_LANE_TOOL_NAMES,
		...(schemaSearchCapable ? [TOOL_SCHEMA_SEARCH_NAME] : []),
		...(options.memoryBroker ? [WORKER_MEMORY_READ_TOOL_NAME] : []),
		...(writeCapable ? WRITE_LANE_TOOL_NAMES : []),
		...(pythonCapable ? [PYTHON_LANE_TOOL_NAME] : []),
		...(options.executionPolicy ? [PROCESS_LANE_TOOL_NAME] : []),
		...(options.shellSessionKey ? [STABLE_SHELL_TOOL_NAME] : []),
	];
	const builtInNameSet = new Set<string>(builtInCandidateNames);
	const conflictingAdapter = options.workerToolAdapters?.names().find((name) => builtInNameSet.has(name));
	if (conflictingAdapter) {
		throw new Error(`Worker tool adapter '${conflictingAdapter}' conflicts with a built-in lane tool.`);
	}
	const candidateNames = [...builtInCandidateNames, ...(options.workerToolAdapters?.names() ?? [])];
	const candidateNameSet = new Set<string>(candidateNames);
	const patterns = strictLaneProfilePatterns(options.profile);
	const compiledToolNames = new Set(options.grant?.allowedTools ?? []);
	const unmaterializedGrantTool = options.grant?.allowedTools.find((name) => !candidateNameSet.has(name));
	if (unmaterializedGrantTool) {
		throw new Error(`Compiled lane grant references unmaterializable tool '${unmaterializedGrantTool}'.`);
	}
	// YOLO skips permission gates, never the role ceiling: a readOnly lane (the parent's promise that it
	// edits nothing) keeps only what a read-only grant keeps, whatever the mode.
	const readOnlyDropped =
		options.readOnly === true ? candidateNames.filter((name) => !toolSurvivesReadOnly(name)) : [];
	const deniedTools = options.yolo
		? readOnlyDropped
		: candidateNames.filter(
				(name) =>
					readOnlyDropped.includes(name) ||
					(options.grant ? !compiledToolNames.has(name) : matchesResourceProfilePattern(name, patterns.block)),
			);
	const unboundAllowPatterns =
		options.yolo || options.grant
			? []
			: patterns.allow.filter(
					(pattern) => !candidateNames.some((name) => matchesResourceProfilePattern(name, [pattern])),
				);
	const allowedTools = options.yolo
		? candidateNames.filter((name) => !readOnlyDropped.includes(name))
		: options.grant
			? candidateNames.filter((name) => compiledToolNames.has(name) && !readOnlyDropped.includes(name))
			: candidateNames.filter(
					(name) =>
						(patterns.allow.length === 0 || matchesResourceProfilePattern(name, patterns.allow)) &&
						!matchesResourceProfilePattern(name, patterns.block) &&
						!readOnlyDropped.includes(name),
				);
	const allowedToolSet = new Set<string>(allowedTools);
	const manifestsByName = new Map(options.toolManifests?.map((manifest) => [manifest.toolName, manifest]) ?? []);
	if (!options.yolo && options.grant?.allowedTools.some((name) => !manifestsByName.has(name))) {
		throw new Error("Compiled lane grant references a tool without a capability manifest.");
	}
	const gateway = options.grant
		? new CapabilityGateway({
				grant: options.grant,
				cwd: options.cwd,
				...(options.initialUsage !== undefined ? { initialUsage: options.initialUsage } : {}),
				...(options.sharedBudget ? { sharedBudget: options.sharedBudget } : {}),
			})
		: undefined;
	const toolUsage = new LaneToolUsage(gateway ? (usage) => gateway.recordUsage(usage) : undefined);
	const deniedPaths = options.deniedPaths?.map((entry) => path.resolve(entry));
	const privatePathBoundary =
		deniedPaths && deniedPaths.length > 0
			? {
					redactSensitiveText: redactKnownSecrets,
					protectedFiles: deniedPaths,
					protectedDirectories: deniedPaths,
				}
			: undefined;
	const readEnvelope: CapabilityEnvelope = {
		id: "isolated-lane-read-tools",
		capabilities: [
			"filesystem.read",
			...(allowedToolSet.has(WORKER_MEMORY_READ_TOOL_NAME) ? (["memory.query"] as const) : []),
			...(allowedToolSet.has(PYTHON_LANE_TOOL_NAME) ||
			allowedToolSet.has(PROCESS_LANE_TOOL_NAME) ||
			allowedToolSet.has(STABLE_SHELL_TOOL_NAME)
				? (["process.exec"] as const)
				: []),
		],
		allowedTools,
		deniedTools,
		allowedPaths: [path.resolve(options.cwd)],
		...(deniedPaths && deniedPaths.length > 0 ? { deniedPaths } : {}),
	};
	const writeProtectionEnvelope: CapabilityEnvelope | undefined =
		options.writeProtectedPaths && options.writeProtectedPaths.length > 0
			? {
					id: "isolated-lane-harness-write-protection",
					capabilities: ["filesystem.write"],
					deniedPaths: options.writeProtectedPaths.map((entry) => path.resolve(entry)),
				}
			: undefined;
	const writeEnvelope: CapabilityEnvelope = {
		id: "isolated-lane-write-tools",
		capabilities: ["filesystem.write"],
		allowedTools,
		deniedTools,
		allowedPaths: resolveWriteRoots(options.cwd, options.writePaths ?? []),
		...(deniedPaths && deniedPaths.length > 0 ? { deniedPaths } : {}),
	};

	// YOLO skips permission prompts, never the role ceiling: a YOLO lane writes inside its own cwd plus the
	// roots its dispatcher granted with writePaths, exactly like a guarded lane's default scope.
	const yoloWriteScopeEnvelope: CapabilityEnvelope | undefined = options.yolo
		? {
				id: "isolated-lane-yolo-write-scope",
				capabilities: ["filesystem.write"],
				allowedPaths: [
					...new Set([path.resolve(options.cwd), ...resolveWriteRoots(options.cwd, options.writePaths ?? [])]),
				],
			}
		: undefined;

	// A worker's commands run in the worker run environment (per-worker temp directory, no inherited
	// credentials, an ownership marker): disposal ends every process still carrying the marker and removes
	// the scratch directory, so a shell lane leaves nothing behind.
	// Every route a worker has to a process (bash, python, run_process) gets the same environment, so no tool is
	// the unattributed or credential-bearing one; a worker with none of them has nothing to run and no scratch.
	const runsProcesses =
		options.shellSessionKey !== undefined ||
		allowedToolSet.has(PYTHON_LANE_TOOL_NAME) ||
		allowedToolSet.has(PROCESS_LANE_TOOL_NAME);
	const runEnvironment = runsProcesses
		? createWorkerRunEnvironment(
				options.workerLabel ?? options.shellSessionKey ?? mutationScope,
				options.onWorkerProcessesReaped,
			)
		: undefined;
	const sharedToolOptions: SharedLaneToolOptions | undefined = runEnvironment
		? {
				...options.sharedToolOptions,
				bash: { ...options.sharedToolOptions?.bash, spawnHook: runEnvironment.spawnHook },
				python: {
					...options.sharedToolOptions?.python,
					environment: (cwd) => ({
						...options.sharedToolOptions?.python?.environment?.(cwd),
						...runEnvironment.attributionEnvironment,
					}),
					omitEnvironmentVariables: [
						...(options.sharedToolOptions?.python?.omitEnvironmentVariables ?? []),
						...runEnvironment.omittedEnvironmentVariables,
					],
				},
				runProcess: {
					...options.sharedToolOptions?.runProcess,
					attributionEnvironment: runEnvironment.attributionEnvironment,
				},
			}
		: options.sharedToolOptions;
	const rawTools = createLaneTools(
		options.cwd,
		allowedTools,
		fileMutationIntents,
		mutationScope,
		toolUsage,
		privatePathBoundary,
		options.memoryBroker,
		options.executionPolicy,
		options.processMaxWallClockMs,
		options.shellSessionKey,
		options.shellOutputDirectory,
		options.workerToolAdapters,
		options.bindTool,
		sharedToolOptions,
	);
	const getPathAliasTable = options.getPathAliasTable;
	const wrappedTools = new WeakSet<AgentTool>();
	const protectedPathWatch = options.protectedPathWatch;
	// Process tools are host-trust boundaries (see protected-path-watch.ts): each call runs between two
	// fingerprints of the harness write-protected set, and a change is recorded, never refused or reverted.
	const watchedTools = protectedPathWatch
		? rawTools.map((tool) =>
				PROCESS_TOOL_NAMES.has(tool.name)
					? wrapToolExecution(tool, (executor) => ({
							...executor,
							execute: (toolCallId, ...args) =>
								protectedPathWatch.guard(() => executor.execute(toolCallId, ...args)),
						}))
					: tool,
			)
		: rawTools;
	const tools = getPathAliasTable
		? watchedTools.map((tool) =>
				wrapToolWithPathAliasExpansion(tool, getPathAliasTable, wrappedTools, () => options.cwd),
			)
		: watchedTools;

	return {
		tools,
		dispose: () =>
			settleIndependentLifecycle(
				[
					() => toolUsage.close(),
					() =>
						options.shellSessionKey ? disposeShellExecutionSessionAndWait(options.shellSessionKey) : undefined,
					() => runEnvironment?.dispose(),
					() => fileMutationIntents.dispose(),
				],
				"Lane tool surface disposal failed",
				{ sequential: true },
			),
		allowedTools,
		deniedTools,
		unboundAllowPatterns,
		toolUsage,
		beforeToolCall: async ({ toolCall, args }) => {
			toolUsage.assertOpen();
			// Git freedom is the orchestrator's decision, applied through checkEdge at dispatch.
			if (!allowedToolSet.has(toolCall.name)) {
				return { block: true, reason: `Lane tool '${toolCall.name}' is outside the materialized UAC surface.` };
			}
			if (options.shellReadOnly && READ_ONLY_SHELL_TOOL_NAMES.has(toolCall.name.toLowerCase())) {
				const command = (args as { command?: unknown } | undefined)?.command;
				const violation = typeof command === "string" ? readOnlyShellViolation(command, options.cwd) : undefined;
				if (violation) {
					return {
						block: true,
						reason: `Read-only worker: ${violation}. Read, search and inspect freely, and redirect output into a new file if needed; report any change that is required to the parent instead of making it.`,
					};
				}
			}
			if (writeProtectionEnvelope && WRITE_LANE_TOOL_NAME_SET.has(toolCall.name)) {
				const protection = evaluateToolGate({
					toolName: toolCall.name,
					args,
					cwd: options.cwd,
					envelope: writeProtectionEnvelope,
				});
				if (protection.outcome !== "allow") {
					return {
						block: true,
						reason: `Harness resource is write-protected (${protection.reasonCode}): ${protection.message ?? "write refused"}`,
					};
				}
			}
			if (options.yolo) {
				const boundary = classifyYoloBoundary({
					toolName: toolCall.name,
					args,
					cwd: options.cwd,
					scopeCwd: options.cwd,
					denyCommands: options.denyCommands,
				});
				if (boundary) {
					return {
						block: true,
						reason:
							boundary.kind === "confirm"
								? `Owner approval required: ${boundary.reason}`
								: `YOLO hardline: ${boundary.reason}`,
					};
				}
				if (yoloWriteScopeEnvelope && WRITE_LANE_TOOL_NAME_SET.has(toolCall.name)) {
					const scope = evaluateToolGate({
						toolName: toolCall.name,
						args,
						cwd: options.cwd,
						envelope: yoloWriteScopeEnvelope,
					});
					if (scope.outcome !== "allow") {
						return {
							block: true,
							reason: `Lane tool blocked (${scope.reasonCode}): ${scope.message ?? "write is outside this worker's scope"} ${WORKER_WRITE_SCOPE_GUIDANCE}`,
						};
					}
				}
				// checkEdge keeps the owner's local-commit branch rule; every permission gate below is skipped.
				return options.checkEdge ? await options.checkEdge(toolCall.name, args, options.cwd) : undefined;
			}
			if (gateway) {
				const manifest = manifestsByName.get(toolCall.name);
				if (!manifest) {
					return { block: true, reason: `Lane tool '${toolCall.name}' has no compiled capability manifest.` };
				}
				try {
					gateway.authorizeToolCall(manifest, toolCall.name, args);
				} catch (error) {
					if (error instanceof CapabilityGatewayDeniedError) {
						if (error.status === "budget_exhausted") throw error;
						return {
							block: true,
							reason: `Lane tool blocked (${error.reasonCode}): ${error.message}${error.reasonCode === "scope_denied" ? ` ${WORKER_WRITE_SCOPE_GUIDANCE}` : ""}`,
						};
					}
					throw error;
				}
			} else {
				const outcome = evaluateToolGate({
					toolName: toolCall.name,
					args,
					cwd: options.cwd,
					envelope: WRITE_LANE_TOOL_NAME_SET.has(toolCall.name) ? writeEnvelope : readEnvelope,
				});
				if (outcome.outcome !== "allow") {
					return {
						block: true,
						reason: `Lane tool blocked (${outcome.reasonCode}): ${outcome.message ?? "capability gate denied it"}${WRITE_LANE_TOOL_NAME_SET.has(toolCall.name) && outcome.reasonCode.includes("path") ? ` ${WORKER_WRITE_SCOPE_GUIDANCE}` : ""}`,
					};
				}
			}
			if (options.checkEdge) {
				const edgeOutcome = await options.checkEdge(toolCall.name, args, options.cwd);
				if (edgeOutcome?.block) return edgeOutcome;
			}
			return undefined;
		},
		...(gateway ? { gateway } : {}),
	};
}

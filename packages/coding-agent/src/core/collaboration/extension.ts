import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { getAgentDir, getBundledResourcesDir } from "../../config.ts";
import { readSessionLeaseHolders } from "../../kernel/session/session-bundle-lifecycle.ts";
import { canonicalizeWatchDir } from "../../utils/fs-watch.ts";
import { getProcessWorkRun } from "../../utils/work-directory.ts";
import {
	encodeWorkerSessionAllowedPaths,
	PI_WORKER_ALLOWED_PATHS_ENV,
} from "../autonomy/worker-session-private-scope.ts";
import { ManagedLaneRuntimeAdmissionError } from "../extensions/managed-lane-records.ts";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";
import { knowledgeGrantReferencesSchema } from "../memory/knowledge-grant.ts";
import type { KnowledgeHandoffProjection } from "../memory/knowledge-projection.ts";
import { orchestrationThinkingLevelSchema } from "../orchestration/thinking-level-schema.ts";
import { PI_ORCHESTRATION_AGENT_ID_ENV } from "../process-identity.ts";
import { isWorkerSession } from "../session-role.ts";
import { isComplexShellCommand, parseCommandPrefixes } from "../tools/shell-command-parser.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { encodeWorkerExtensionToolGrants, PI_WORKER_EXTENSION_TOOLS_ENV } from "../worker-extension-grants.ts";
import type { CollaborationBackend } from "./backend.ts";
import { detectHerdrCallerContext, resolveCollaborationBackend } from "./backend-resolver.ts";
import { CollaborationControlHandoffs } from "./control-handoffs.ts";
import { CollaborationCoordinator } from "./coordinator.ts";
import { CollaborationDeadlines, reserveCollaborationCleanupAttempt } from "./deadlines.ts";
import { provisionHerdr } from "./herdr-provision.ts";
import {
	type CollaborationJob,
	type CollaborationKnowledgeHandoff,
	collaborationLaneId,
	MAX_COLLABORATION_KNOWLEDGE_BYTES,
	type NewCollaborationJob,
} from "./job-record.ts";
import { CollaborationJobStore } from "./job-store.ts";
import { buildLaunchProfileFlags, deriveWorkerLaunchProfile } from "./launch-profile.ts";
import { NativeProviderRegistry, nativeCollaborationLaunchArgs } from "./native-provider.ts";
import { normalizeNativeProviderSelection } from "./native-selection.ts";
import { reconcileCollaborationSessions } from "./session-recovery.ts";
import { COLLABORATION_WORK_RUN } from "./state-directory.ts";
import { launchCollaborationTurnProcess } from "./turn-process.ts";

const text = Type.String({ maxLength: 4096 });
const agentSpec = Type.Object({
	provider: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" })),
	name: Type.Optional(text),
	task: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
	direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
	command: Type.Optional(text),
	args: Type.Optional(Type.Array(text, { maxItems: 128 })),
	env: Type.Optional(Type.Record(Type.String(), text, { maxProperties: 64 })),
	cwd: Type.Optional(text),
	path: Type.Optional(text),
	model: Type.Optional(text),
	apiProvider: Type.Optional(text),
	tools: Type.Optional(Type.Array(text, { maxItems: 128 })),
	resourceProfile: Type.Optional(text),
	thinkingLevel: Type.Optional(orchestrationThinkingLevelSchema()),
	worktreeLane: Type.Optional(text),
});
const templateSchema = Type.Object({
	name: text,
	description: text,
	agents: Type.Array(agentSpec, { minItems: 1, maxItems: 12 }),
	deadlineSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 86400 })),
	notes: Type.Optional(Type.Array(text)),
});
const parameters = Type.Object({
	action: Type.Optional(
		Type.Enum([
			"status",
			"setup_help",
			"guard",
			"notify",
			"set_status",
			"clear_status",
			"workspace_plan",
			"launch_workspace",
			"fire_task",
			"send_followup",
			"answer_question",
			"dismiss",
			"archive_job",
			"job_status",
			"list_jobs",
			"set_variable",
			"list_variables",
			"list_templates",
			"show_template",
			"stop_job",
			"stop_session",
			"release_acquisition",
			"adopt_job",
		]),
	),
	placement: Type.Optional(
		Type.Union([Type.Literal("current-pane"), Type.Literal("managed-workspace")], {
			description:
				"In Herdr defaults to current-pane (sibling panels in the active tab); managed-workspace uses a private isolated daemon.",
		}),
	),
	agents: Type.Optional(Type.Array(agentSpec, { minItems: 1, maxItems: 12 })),
	task: Type.Optional(Type.String({ maxLength: 32768 })),
	body: Type.Optional(Type.String({ maxLength: 32768 })),
	title: Type.Optional(text),
	subtitle: Type.Optional(text),
	icon: Type.Optional(text),
	color: Type.Optional(text),
	workspaceName: Type.Optional(text),
	cwd: Type.Optional(text),
	teamTemplate: Type.Optional(text),
	jobId: Type.Optional(text),
	agentId: Type.Optional(text),
	launchKey: Type.Optional(text),
	goalId: Type.Optional(text),
	variableName: Type.Optional(text),
	variableValue: Type.Optional(text),
	statusKey: Type.Optional(text),
	status: Type.Optional(text),
	deadlineSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 86400 })),
	dryRun: Type.Optional(Type.Boolean()),
	force: Type.Optional(Type.Boolean()),
	steer: Type.Optional(Type.Boolean()),
	parallelWork: Type.Optional(
		Type.Object(
			{
				independent: Type.Literal(true),
				justification: Type.String({ minLength: 1, maxLength: 4096 }),
			},
			{ additionalProperties: false },
		),
	),
	answer: Type.Optional(
		Type.Object({
			text: Type.Optional(text),
			keys: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
		}),
	),
	knowledge: Type.Optional(
		knowledgeGrantReferencesSchema(
			"fire_task and send_followup only: exact accepted knowledge IDs and revisions granted to this task. Omit to grant none; read knowledge first to obtain current references.",
		),
	),
});
type Params = Static<typeof parameters>;

/**
 * One tool call's knowledge grant. The block stays in this object (parent memory) and is handed to each reserved
 * turn's helper at its ask, re-checked then; `report` is the parent's diagnostic, references only, never values.
 */
function collaborationKnowledgeGrant(projection: KnowledgeHandoffProjection) {
	const deliveredTo = new Set<string>();
	const withdrawnFrom = new Set<string>();
	let replayed = false;
	const handoff: CollaborationKnowledgeHandoff = {
		references: projection.text ? projection.references : [],
		deliver: (agentId) => {
			const current = projection.text !== "" && projection.isCurrent();
			(current ? deliveredTo : withdrawnFrom).add(agentId);
			(current ? withdrawnFrom : deliveredTo).delete(agentId);
			return current ? projection.text : undefined;
		},
		replayed: () => {
			replayed = true;
		},
	};
	return {
		handoff,
		/** `projected` names versions a member's helper was actually handed; a replayed start delivers nothing. */
		report: () => ({
			projected: deliveredTo.size ? projection.references : [],
			unavailable: projection.unavailable,
			omitted: projection.omitted,
			...(projection.blocked ? { blocked: projection.blocked } : {}),
			...(withdrawnFrom.size ? { withdrawnBeforeDeliveryFrom: [...withdrawnFrom] } : {}),
			...(replayed ? { replayed: true } : {}),
		}),
	};
}

export interface CollaborationExtensionOptions {
	providers?: NativeProviderRegistry;
	backend?: (target: CollaborationJob | string, create?: boolean) => Promise<CollaborationBackend>;
	launchTurn?: typeof launchCollaborationTurnProcess;
	stateDirectory?: string;
	provision?: typeof provisionHerdr;
	watch?: (directory: string, onChange: (file: string | Buffer | null) => void) => FSWatcher;
}

export function getCollaborationDataRoot(): string {
	const { category, tenant, runId } = COLLABORATION_WORK_RUN;
	return getProcessWorkRun(getAgentDir(), category, tenant, runId).path;
}

function templates(): Static<typeof templateSchema>[] {
	const result = new Map<string, Static<typeof templateSchema>>();
	for (const directory of [
		join(getBundledResourcesDir(), "extensions", "pi-collaboration", "templates"),
		join(getCollaborationDataRoot(), "templates"),
	]) {
		if (!existsSync(directory)) continue;
		for (const name of readBoundedDirectoryNamesSync(directory, 64, "Collaboration templates")) {
			if (!name.endsWith(".json")) continue;
			const value: unknown = JSON.parse(
				readBoundedTextFileSync(join(directory, name), 65536, "Collaboration template"),
			);
			if (!Value.Check(templateSchema, value)) throw new Error(`Invalid collaboration template: ${name}`);
			result.set(value.name.toLowerCase(), value);
		}
	}
	return [...result.values()];
}

/** Packaged root adapter. Provider I/O and durable transitions live outside the extension entry. */
export function piCollaborationExtension(pi: ExtensionAPI, options: CollaborationExtensionOptions = {}): void {
	// A worker never starts, watches or recovers collaboration jobs (`pi_collaboration` is in its forbidden
	// tool set); its peer traffic goes through the finite `--collaboration-peer` CLI. Binding here would only
	// leave a job directory, lease and file watcher behind.
	if (isWorkerSession()) return;
	const providers = options.providers ?? new NativeProviderRegistry();
	const grantKnowledge = (references: Params["knowledge"]) =>
		references === undefined
			? undefined
			: collaborationKnowledgeGrant(pi.projectKnowledgeForHandoff(references, MAX_COLLABORATION_KNOWLEDGE_BYTES));
	let binding:
		| {
				store: CollaborationJobStore;
				coordinator: CollaborationCoordinator;
				watcher: FSWatcher;
				deadlines: CollaborationDeadlines;
				controls: CollaborationControlHandoffs;
				readyJobs: Set<string>;
				cancelRuntimeRetry(): void;
				recover(fresh?: boolean): Promise<void>;
		  }
		| undefined;
	const backend =
		options.backend ??
		((job: CollaborationJob, create = false) => {
			const owner = binding;
			return resolveCollaborationBackend(job, {
				ensureRunning: create,
				onTerminal: (terminal) => {
					if (!owner) return;
					for (const job of owner.store.list()) {
						if (job.sessionName !== terminal.session || job.agents.every((agent) => agent.closed)) continue;
						owner.controls.record(
							job.id,
							"server",
							String(terminal.timestamp),
							`Herdr server ${terminal.status}; native delivery will not be replayed.`,
						);
					}
					if (binding === owner) owner.controls.flush();
				},
			});
		});
	const close = () => {
		binding?.cancelRuntimeRetry();
		binding?.coordinator.dispose();
		binding?.watcher.close();
		binding?.deadlines.dispose();
		binding = undefined;
	};
	const bind = (ctx: ExtensionContext) => {
		if (binding?.store.parentSessionId === ctx.sessionManager.getSessionId()) return binding;
		close();
		// The lease registry lives in the same agent directory as the default job root; a store bound to another
		// directory has no registry to judge other sessions by, so it never adopts and shows them as unproven.
		const store = new CollaborationJobStore(
			options.stateDirectory ?? join(getCollaborationDataRoot(), "jobs"),
			ctx.sessionManager.getSessionId(),
			options.stateDirectory === undefined
				? { sessionServers: (sessionId) => readSessionLeaseHolders(getAgentDir(), sessionId) }
				: {},
		);
		const controls = new CollaborationControlHandoffs(store, (notice) =>
			pi.sendMessage(
				{
					customType: "collaboration-control-failure",
					content: `Collaboration controller stopped recovery for ${notice.jobId}/${notice.source}: ${notice.error}\nNative work is not proven stopped. Inspect pi_collaboration job_status, repair the control failure, and stop the exact owned work if possible. Do not replay an uncertain prompt or declare task completion.`,
					display: true,
					details: notice,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			),
		);
		const coordinator = new CollaborationCoordinator({
			store,
			backend,
			report: (event) => {
				pi.reportManagedLane(event);
				if (event.phase === "terminal" && event.usage)
					pi.reportSpawnedUsage(event.usage, {
						label: "collaboration-worker-advisory",
						reportId: `${event.laneId}:${event.dispatchSequence}`,
					});
			},
			launchTurn: (job, agent, answer, knowledge, signal) =>
				(options.launchTurn ?? launchCollaborationTurnProcess)(store, job, agent, answer, knowledge, signal),
		});
		const deadlines = new CollaborationDeadlines(
			(jobId, agentId, turnId) => coordinator.stopAgent(jobId, agentId, turnId, { kind: "deadline" }),
			(turn, error) => {
				try {
					controls.record(turn.jobId, turn.agentId, turn.turnId, String(error));
					controls.flush();
				} catch (handoffError) {
					ctx.ui.notify(`Collaboration control handoff failed: ${String(handoffError).slice(0, 512)}`, "error");
				}
				ctx.ui.notify(
					`Collaboration cleanup exhausted for ${turn.jobId}/${turn.agentId}; live work remains fenced: ${String(error).slice(0, 1000)}`,
					"error",
				);
			},
			(turn) => reserveCollaborationCleanupAttempt(store, turn),
		);
		let recovered = false;
		const readyJobs = new Set<string>();
		let unsubscribeRuntimeRetry: (() => void) | undefined;
		const cancelRuntimeRetry = () => {
			unsubscribeRuntimeRetry?.();
			unsubscribeRuntimeRetry = undefined;
		};
		const refresh = () => {
			try {
				// A job of this session whose controller is gone is taken back first, so publication, peer delivery
				// and deadlines below run on it.
				store.reclaimSessionJobs();
				coordinator.refresh();
				controls.flush();
				if (recovered)
					void coordinator
						.drainPeerMessages(readyJobs)
						.catch((error: unknown) =>
							ctx.ui.notify(`Collaboration peer delivery failed: ${String(error).slice(0, 512)}`, "error"),
						);
				deadlines.reconcile(
					store.list().flatMap((job) =>
						job.agents
							// An unfinished stop keeps its cleanup ladder after its turn settled without a closure proof.
							.filter(
								(agent) =>
									!agent.closed &&
									!job.dismissed &&
									(agent.stopping || ["running", "reserved"].includes(agent.status)),
							)
							.map((agent) => ({
								jobId: job.id,
								agentId: agent.id,
								turnId: agent.turnId,
								deadlineAt: agent.deadlineAt ?? Date.now(),
							})),
					),
				);
			} catch (error) {
				if (error instanceof ManagedLaneRuntimeAdmissionError) {
					unsubscribeRuntimeRetry ??= error.onRuntimeAvailable(() => {
						cancelRuntimeRetry();
						if (binding?.store === store) refresh();
					});
					return;
				}
				ctx.ui.notify(`Collaboration handoff failed: ${String(error).slice(0, 1000)}`, "error");
			}
		};
		const changed = (file: string | Buffer | null) => {
			if (binding?.store === store && (file === null || file.toString().endsWith(".json"))) refresh();
		};
		const watchDirectory = canonicalizeWatchDir(store.directory);
		const watcher = options.watch
			? options.watch(watchDirectory, changed)
			: watch(watchDirectory, { persistent: false }, (_event, file) => changed(file));
		watcher.on("error", (error) => ctx.ui.notify(`Collaboration signal failed: ${error.message}`, "error"));
		let reattaching: Promise<void> | undefined;
		/** `fresh`: wait out a reconciliation already in flight (it listed jobs before the caller's change), then run. */
		const recover = async (fresh = false): Promise<void> => {
			if (fresh && reattaching)
				await reattaching.then(
					() => undefined,
					// The in-flight run's own caller reports its failure; this one only waits for it to end.
					() => undefined,
				);
			if (!reattaching) recovered = false;
			reattaching ??= reconcileCollaborationSessions(
				store,
				backend,
				(jobId, identity, error) => {
					if (error) {
						readyJobs.delete(jobId);
						controls.record(jobId, "recovery", identity, error);
					} else {
						readyJobs.add(jobId);
						controls.clear(jobId, "recovery");
					}
					controls.flush();
				},
				() => binding?.store === store,
			).finally(() => {
				reattaching = undefined;
				if (binding?.store !== store) return;
				recovered = true;
				refresh();
			});
			return reattaching;
		};
		binding = { store, coordinator, watcher, deadlines, controls, readyJobs, cancelRuntimeRetry, recover };
		refresh();
		void recover().catch((error: unknown) => {
			if (binding?.store === store)
				ctx.ui.notify(`Collaboration restoration failed: ${String(error).slice(0, 512)}`, "error");
		});
		return binding;
	};
	pi.on("session_start", async (_event, ctx) => {
		bind(ctx);
	});
	pi.on("session_shutdown", async () => {
		close();
	});
	pi.onDispose(close);

	const prepare = async (
		ctx: ExtensionContext,
		params: Params,
		probe: boolean,
		toolCallId: string,
	): Promise<NewCollaborationJob> => {
		const template = params.teamTemplate ? templates().find((item) => item.name === params.teamTemplate) : undefined;
		if (params.teamTemplate && !template) throw new Error("Unknown collaboration template.");
		const specs = params.agents ??
			template?.agents ?? [
				{
					provider: "pi",
					name: "builder",
					task: "Implement the scoped task; write or run no tests unless the owner explicitly asked. Own implementation edits; request independent review and validation from peers.",
				},
				{
					provider: "agy",
					name: "validator",
					task: "Validate the scoped task independently. Do not edit production code. Run relevant focused checks (no test runs unless the owner explicitly asked) and send reproducible failures to the builder.",
				},
				{
					provider: "codex",
					name: "reviewer",
					task: "Review the scoped task for correctness, failure recovery, ownership and security. Do not edit files. Send evidence-backed findings to the builder.",
				},
			];
		const detection = await detectHerdrCallerContext();
		const caller = detection.status === "owned" ? detection.caller : undefined;
		const requestedPlacement = params.placement;
		if (requestedPlacement === "current-pane" && !caller) {
			throw new Error(
				detection.status === "unverifiable"
					? `Placement 'current-pane' requires this process's Herdr pane, but pane ${detection.paneId} could not be verified: ${detection.reason}.`
					: "Placement 'current-pane' requires a running Herdr environment in which this process runs (HERDR_ENV=1, valid pane, workspace, tab and socket).",
			);
		}
		if (detection.status === "unverifiable" && requestedPlacement === undefined)
			ctx.ui.notify(
				`Herdr pane ${detection.paneId} could not be verified (${detection.reason}); placement falls back to managed-workspace.`,
				"warning",
			);
		const placement = requestedPlacement ?? (caller ? "current-pane" : "managed-workspace");
		const isCurrentPane = placement === "current-pane";
		if (isCurrentPane && !caller?.binPath) {
			throw new Error("Placement 'current-pane' requires a valid caller executable (HERDR_BIN_PATH).");
		}
		// Tool-call identity is session-scoped; the mutable transcript leaf must not turn a replay
		// into a new task after its result has already been appended.
		const id =
			params.launchKey ??
			`job-${createHash("sha256")
				.update(JSON.stringify([ctx.sessionManager.getSessionId(), toolCallId]))
				.digest("hex")
				.slice(0, 40)}`;
		const cwd = resolve(ctx.cwd, params.cwd ?? ".");
		const result: NewCollaborationJob = {
			id,
			parentSessionId: ctx.sessionManager.getSessionId(),
			parentSessionFile: ctx.sessionManager.getSessionFile(),
			sessionName: `pi-${createHash("sha256")
				.update(JSON.stringify([ctx.sessionManager.getSessionId(), id]))
				.digest("hex")
				.slice(0, 40)}`,
			cwd,
			title: params.workspaceName ?? params.title ?? id,
			createdAt: Date.now(),
			deadlineSeconds: params.deadlineSeconds ?? template?.deadlineSeconds ?? 1200,
			goalId: params.goalId,
			placement,
			socketPath: isCurrentPane && caller ? caller.socketPath : undefined,
			binPath: isCurrentPane && caller ? caller.binPath : undefined,
			callerPaneId: isCurrentPane && caller ? caller.paneId : undefined,
			callerWorkspaceId: isCurrentPane && caller ? caller.workspaceId : undefined,
			callerTabId: isCurrentPane && caller ? caller.tabId : undefined,
			agents: [],
		};
		for (let index = 0; index < specs.length; index++) {
			const spec: Static<typeof agentSpec> = specs[index];
			const provider = spec.provider ?? "custom";
			const agentId = `agent-${index + 1}`;
			const agentCwd = resolve(cwd, spec.path ?? spec.cwd ?? ".");
			if (!statSync(agentCwd).isDirectory()) throw new Error(`Agent cwd is not a directory: ${agentCwd}`);
			if (provider !== "pi" && (spec.tools || spec.thinkingLevel || spec.resourceProfile || spec.worktreeLane))
				throw new Error(
					"Tool, thinking, resource, and worktree profile controls are Pi-only; external CLIs retain host access.",
				);
			const parsed = spec.command ? parseCommandPrefixes(spec.command) : undefined;
			if (spec.command && (!parsed || isComplexShellCommand(spec.command)))
				throw new Error(
					"Use one explicit native CLI command plus arguments/environment; shell chains require a registered provider strategy.",
				);
			const executable = parsed?.coreCommandTokens[0];
			if (parsed && !executable)
				throw new Error("A native CLI executable is required after environment assignments.");
			const env = { ...parsed?.envVars, ...spec.env };
			const normalized = normalizeNativeProviderSelection(
				provider,
				[...(parsed?.coreCommandTokens.slice(1) ?? []), ...(spec.args ?? [])],
				{
					provider: spec.apiProvider,
					model: spec.model,
					executable,
					env: { ...process.env, ...env },
					cwd: agentCwd,
				},
			);
			const readiness = probe ? await providers.inspect(provider, normalized.selection) : undefined;
			if (readiness && !readiness.authenticated)
				throw new Error(`Provider ${provider} is not admitted: ${readiness.status}. No agent task was submitted.`);
			const invocation = readiness?.invocation ?? providers.resolveInvocation(provider, normalized.selection);
			Object.assign(env, invocation.environment);
			const resources = !spec.resourceProfile ? pi.getEffectiveResourceProfile() : undefined;
			const resourceJson = resources && Object.keys(resources).length ? JSON.stringify(resources) : undefined;
			const resourceName = resourceJson
				? `collaboration-${createHash("sha256").update(resourceJson).digest("hex").slice(0, 12)}`
				: undefined;
			const profile = deriveWorkerLaunchProfile({
				identity: `collaboration-profile:${id}:${agentId}`,
				inheritedTools: provider === "pi" ? pi.getActiveTools() : undefined,
				allowedTools: provider === "pi" ? spec.tools : ["bash"],
				extensionTools:
					provider === "pi" && spec.tools
						? pi.getAllTools().map((tool) => ({ name: tool.name, extensionPath: tool.sourceInfo.path }))
						: undefined,
				writePaths: provider === "pi" && (spec.path || spec.worktreeLane) ? [agentCwd] : [],
				thinkingLevel: provider === "pi" ? (spec.thinkingLevel ?? pi.getThinkingLevel()) : undefined,
				resourceProfile: provider === "pi" ? (spec.resourceProfile ?? resourceName) : undefined,
				resourceProfileJson:
					provider === "pi" && resourceName && resources
						? JSON.stringify({ [resourceName]: resources })
						: undefined,
				worktreeLane: spec.worktreeLane,
				parentPid: process.pid,
				parentSession: ctx.sessionManager.getSessionId(),
				taskRef: params.goalId,
			});
			const selectedArgs =
				readiness?.launchArgs ??
				(provider === "pi"
					? [
							...(normalized.selection.provider ? ["--provider", normalized.selection.provider] : []),
							...(normalized.selection.model ? ["--model", normalized.selection.model] : []),
						]
					: []);
			const args = nativeCollaborationLaunchArgs(readiness?.kind ?? provider, [...normalized.args, ...selectedArgs]);
			if (provider === "pi") {
				for (const flag of buildLaunchProfileFlags(profile)) {
					args.push(flag.flag);
					if (flag.value !== undefined) args.push(flag.value);
				}
				env[PI_ORCHESTRATION_AGENT_ID_ENV] = collaborationLaneId(id, agentId);
				env[PI_WORKER_ALLOWED_PATHS_ENV] = encodeWorkerSessionAllowedPaths(profile.writePaths);
				if (profile.extensionToolGrants?.length)
					env[PI_WORKER_EXTENSION_TOOLS_ENV] = encodeWorkerExtensionToolGrants(profile.extensionToolGrants);
			}
			result.agents.push({
				id: agentId,
				name: spec.name ?? provider,
				task: spec.task,
				direction: spec.direction,
				provider: readiness?.kind ?? provider,
				cwd: agentCwd,
				args: [...invocation.argsPrefix, ...args],
				env,
				profile,
				executable: provider === "pi" || executable ? invocation.executable : undefined,
			});
		}
		return result;
	};

	pi.registerTool({
		name: "pi_collaboration",
		label: "Persistent collaboration",
		parameters,
		description:
			"Persistent native-CLI subagents (Pi, Codex, Claude, agy) in Herdr, for interactive environments that outlive a turn; use delegate for in-process workers. status discovers and authenticates providers; fire_task starts a team (workspace_plan or dryRun previews). Answer a stopped agent's question with answer_question on the same jobId/agentId; assign new tasks with send_followup. Agents receive no owner knowledge unless fire_task or send_followup passes knowledge (exact accepted IDs and revisions; refused, as for delegate, unless the owner's default delegated worker may read memory): right before the agent is prompted the host re-checks those versions and puts only still-current ones, bounded to 8 KiB and wrapped as untrusted data, into that task's prompt, never into job files; references that are stale, forgotten or do not fit are not delivered, are listed in the result's leading knowledge block, and the task starts without them. Answers and peer messages carry no grant; delivered knowledge stays in the external CLI's own session history and the agent's own reports may quote it. stop_job and stop_session terminate exact owned agent panes (dryRun previews). release_acquisition (jobId + agentId) settles a member whose exited issuing process abandoned a pane request before any pane was recorded: it closes nothing, is refused while that process is alive, and any untracked pane its evidence names must be closed by hand. adopt_job (exact jobId) takes over an orphaned job (controller exited, no live process holds its session) after the host re-verifies it under the job lock; dryRun shows the standing. Only stopped-work and question handoffs reach the parent: never poll or read panes for progress, and never re-submit an uncertain prompt. Starts reuse a compatible idle team; busy or ambiguous ones are refused, so pass an exact jobId or justify parallelWork, and never change a grant merely to evade reuse. For external CLIs set reasoning effort through args (e.g. ['--effort','high']); thinkingLevel is Pi-only. Reported success is an untrusted claim until you review the evidence. Tasks, answers, environments and results may persist: never include secrets. status and list_jobs show other sessions' jobs read-only by standing: owned_by_live_session, awaiting_session, orphaned or unproven. External CLIs run unrestricted by explicit user policy (Claude/agy: --dangerously-skip-permissions; Codex: --dangerously-bypass-approvals-and-sandbox); Pi enforces neither their permissions nor their token budgets.",
		promptSnippet: "Persistent native-CLI subagents",
		async execute(_id, input, signal, _update, ctx) {
			const params = input as Params;
			const action = params.action ?? "status";
			if (params.knowledge !== undefined && action !== "fire_task" && action !== "send_followup")
				throw new Error(
					"A knowledge grant belongs to a new task (fire_task or send_followup); an answer continues its task without one.",
				);
			const { store, coordinator, readyJobs, recover } = bind(ctx);
			// A job of this session whose controller exited since the last refresh (no file changed) is taken back first.
			store.reclaimSessionJobs();
			let details: unknown;
			let knowledgeReport: ReturnType<ReturnType<typeof collaborationKnowledgeGrant>["report"]> | undefined;
			if (action === "status" || action === "setup_help") {
				const overview = store.overview();
				details = {
					backend: "herdr",
					providers: await providers.list(),
					jobs: overview.jobs,
					// Other sessions' jobs with live or unpublished work: read-only, each with its control standing.
					otherSessionJobs: overview.otherJobs,
					otherSessionJobsOmitted: overview.otherJobsOmitted,
					// Job files the listing skipped (corrupt or unreadable): bounded and content-free, so a bad
					// record is visible here instead of silently missing.
					skippedRecords: store.skippedRecords(),
					permissionMode: "native-cli-unrestricted",
					help: "Use fire_task to start a persistent interactive team. Missing Herdr is installed on demand. Questions use answer_question; ordinary follow-ups use send_followup. An orphaned job of another session is taken over with adopt_job.",
				};
			} else if (action === "guard") {
				const installation = await (options.provision ?? provisionHerdr)();
				details = { guard: { allowed: true }, installation };
			} else if (action === "list_templates") details = templates();
			else if (action === "show_template") {
				details = templates().find((item) => item.name === (params.teamTemplate ?? params.title));
				if (!details) throw new Error("Unknown collaboration template.");
			} else if (action === "list_jobs") {
				const overview = store.overview();
				details = {
					jobs: overview.jobs,
					otherSessionJobs: overview.otherJobs,
					otherSessionJobsOmitted: overview.otherJobsOmitted,
				};
			} else if (action === "adopt_job") {
				if (!params.jobId) throw new Error("adopt_job requires an exact jobId.");
				if (params.dryRun === true) details = { dryRun: true, job: store.describe(params.jobId) };
				else {
					const adopted = store.adopt(params.jobId);
					// Reconcile the adopted job (stranded stops, abandoned acquisitions, reattachment) and admit it to
					// peer delivery; a reconciliation already in flight listed jobs before the adoption.
					await recover(true);
					details = { adopted: true, job: store.load(adopted.id) };
				}
			} else if (action === "job_status" && params.jobId && !store.controlsJob(params.jobId)) {
				// Another session's job: shown read-only, never mutated from here.
				details = { readOnly: true, job: store.describe(params.jobId) };
			} else if (["workspace_plan", "launch_workspace", "fire_task"].includes(action)) {
				const plan = await prepare(ctx, params, action !== "workspace_plan" && params.dryRun !== true, _id);
				if (action === "workspace_plan" || params.dryRun) details = { dryRun: true, job: plan };
				else {
					let task = params.task ?? params.body;
					if (action === "fire_task" && !task?.trim()) {
						const agentTasks = plan.agents.map((a) => a.task?.trim());
						if (
							agentTasks.length > 0 &&
							agentTasks.every((t) => Boolean(t)) &&
							new Set(agentTasks).size === agentTasks.length
						) {
							task =
								agentTasks.length === 1
									? agentTasks[0]!
									: params.title?.trim() || "Execute assigned team responsibilities.";
						} else {
							throw new Error("fire_task requires a task or distinct per-agent tasks for every agent.");
						}
					}
					if (action === "fire_task" && task?.trim()) {
						// Applicable owner working preferences travel with the objective every agent receives:
						// behavioral guidance for the handoff, never a grant and never raw memory.
						const guidance =
							typeof pi.getHandoffPersonaGuidance === "function" ? pi.getHandoffPersonaGuidance() : undefined;
						if (guidance) task = `${task}\n\n${guidance}`;
					}
					if (params.force && existsSync(store.path(plan.id))) {
						if (store.load(plan.id).agents.some((agent) => !agent.closed))
							throw new Error("Stop the existing team's native sessions before reusing its launchKey.");
						store.archive(plan.id);
					}
					const grant = action === "fire_task" ? grantKnowledge(params.knowledge) : undefined;
					const launched = await coordinator.launch(
						plan,
						action === "fire_task" ? task : undefined,
						signal,
						{
							jobId: params.jobId,
							parallelWork: params.parallelWork,
							...(params.knowledge?.length ? { knowledge: params.knowledge } : {}),
						},
						grant?.handoff,
					);
					readyJobs.add(launched.id);
					details = { job: launched };
					knowledgeReport = grant?.report();
				}
			} else if (
				params.jobId &&
				["stop_job", "stop_session", "dismiss"].includes(action) &&
				coordinator.stopPendingAdmission(params.jobId, undefined, params.dryRun === true)
			) {
				details = { jobId: params.jobId, dryRun: params.dryRun === true, pendingAdmission: true };
			} else {
				let job: CollaborationJob | undefined;
				if (params.jobId) {
					job = store.load(params.jobId);
				} else {
					const target = params.workspaceName ?? params.title;
					if (target) {
						const matches = store
							.list()
							.filter((item) => item.title === target || item.sessionName === params.workspaceName);
						if (matches.length > 1) {
							throw new Error(`Multiple owned collaboration jobs match "${target}". Specify an exact jobId.`);
						}
						job = matches[0];
					}
				}
				if (!job) throw new Error("An owned jobId or exact owned workspace is required.");
				if (action === "job_status") {
					await recover();
					details = store.load(job.id);
				} else if (action === "archive_job")
					details = { archivedPath: store.archive(job.id), processesStopped: false };
				else if (action === "list_variables") details = job.variables;
				else if (action === "set_variable") {
					if (!params.variableName) throw new Error("variableName required.");
					store.setVariable(
						job.id,
						params.variableName,
						params.variableValue ?? params.body ?? params.status ?? "",
					);
					details = store.load(job.id).variables;
				} else if (action === "send_followup" || action === "answer_question") {
					const answering = action === "answer_question";
					if (answering && !params.answer?.text?.trim() && !params.answer?.keys?.length)
						throw new Error("answer_question requires nonempty answer.text or answer.keys.");
					const task =
						params.task ??
						params.body ??
						(answering ? (params.answer?.text ?? "Answer the pending question using the supplied keys.") : "");
					if (!task.trim()) throw new Error("send_followup requires a nonempty task.");
					// A new task to a persistent agent carries the CURRENT applicable preferences, not the
					// snapshot its launch briefing had; an answer to a pending question is not a new task.
					const followupGuidance =
						!answering && typeof pi.getHandoffPersonaGuidance === "function"
							? pi.getHandoffPersonaGuidance()
							: undefined;
					const followupTask = followupGuidance ? `${task}\n\n${followupGuidance}` : task;
					const grant = params.dryRun || answering ? undefined : grantKnowledge(params.knowledge);
					details = params.dryRun
						? { dryRun: true, jobId: job.id, task: followupTask }
						: await coordinator.followup(
								job.id,
								params.agentId,
								followupTask,
								answering ? params.answer : undefined,
								{
									steer: params.steer,
									...(!answering ? { newTask: { goalId: params.goalId } } : {}),
									...(grant ? { knowledge: grant.handoff } : {}),
									...(signal ? { signal } : {}),
								},
							);
					knowledgeReport = grant?.report();
				} else if (["stop_job", "stop_session", "dismiss"].includes(action)) {
					if (params.dryRun === true)
						details = {
							dryRun: true,
							action,
							jobId: job.id,
							session: job.sessionName,
							placement: job.placement ?? "managed-workspace",
						};
					else {
						await coordinator.stop(job.id, action === "dismiss");
						details = store.load(job.id);
					}
				} else if (action === "release_acquisition") {
					if (!params.jobId || !params.agentId)
						throw new Error("release_acquisition requires an exact jobId and agentId.");
					details = store.releaseAbandonedAcquisition(job.id, params.agentId);
				} else if (action === "notify") {
					await (await backend(job)).notify(
						params.title ?? "Pi collaboration",
						(params.body ?? "Attention required").slice(0, 2000),
					);
					details = { notified: true };
				} else if (action === "set_status" || action === "clear_status") {
					const key = params.statusKey ?? "status";
					const value = action === "clear_status" ? null : (params.status ?? params.body ?? "");
					if (!job.workspaceId) throw new Error("Workspace is not running.");
					await (await backend(job)).reportMetadata(job.workspaceId, { [key]: value }, Date.now());
					details = { key, value };
				} else throw new Error(`Unsupported collaboration action: ${action}`);
			}
			coordinator.refresh();
			const encoded = JSON.stringify(details);
			return {
				content: [
					// The grant report is its own block, so the bound on the job dump below never cuts it.
					...(knowledgeReport
						? [{ type: "text" as const, text: JSON.stringify({ knowledge: knowledgeReport }) }]
						: []),
					{
						type: "text",
						text:
							encoded.length > 24000
								? `${encoded.slice(0, 24000)}\n[bounded result; request one job at a time]`
								: encoded,
					},
				],
				details: {
					action,
					...((action === "fire_task" || action === "launch_workspace") && details && typeof details === "object"
						? details
						: {}),
					...(knowledgeReport ? { knowledge: knowledgeReport } : {}),
					...(action === "guard" ? { guard: { allowed: true } } : {}),
				},
			};
		},
	});
	pi.registerCommand("pi-collaboration", {
		description: "Show persistent collaboration provider readiness.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(JSON.stringify(await providers.list()), "info");
		},
	});
}

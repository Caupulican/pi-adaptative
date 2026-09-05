import { createHash, randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { getAgentDir, getBundledResourcesDir } from "../../config.ts";
import { getProcessWorkRun } from "../../utils/work-directory.ts";
import {
	encodeWorkerSessionAllowedPaths,
	PI_WORKER_ALLOWED_PATHS_ENV,
} from "../autonomy/worker-session-private-scope.ts";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";
import { orchestrationThinkingLevelSchema } from "../orchestration/thinking-level-schema.ts";
import { PI_ORCHESTRATION_AGENT_ID_ENV } from "../process-identity.ts";
import { isComplexShellCommand, parseCommandPrefixes } from "../tools/shell-command-parser.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import type { CollaborationBackend } from "./backend.ts";
import { CollaborationControlHandoffs } from "./control-handoffs.ts";
import { CollaborationCoordinator } from "./coordinator.ts";
import { CollaborationDeadlines, reserveCollaborationCleanupAttempt } from "./deadlines.ts";
import { provisionHerdr } from "./herdr-provision.ts";
import { createHerdrBackend } from "./herdr-runtime.ts";
import { CollaborationJobStore, collaborationLaneId, type NewCollaborationJob } from "./job-store.ts";
import { buildLaunchProfileFlags, deriveWorkerLaunchProfile } from "./launch-profile.ts";
import { NativeProviderRegistry, nativeCollaborationLaunchArgs } from "./native-provider.ts";
import { normalizeNativeProviderSelection } from "./native-selection.ts";
import { reconcileCollaborationSessions } from "./session-recovery.ts";
import { launchCollaborationTurnProcess } from "./turn-process.ts";

const text = Type.String({ maxLength: 4096 });
const agentSpec = Type.Object({
	provider: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" })),
	name: Type.Optional(text),
	task: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
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
		]),
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
	confirm: Type.Optional(text),
	answer: Type.Optional(
		Type.Object({
			text: Type.Optional(text),
			keys: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
		}),
	),
});
type Params = Static<typeof parameters>;

export interface CollaborationExtensionOptions {
	providers?: NativeProviderRegistry;
	backend?: (session: string, create?: boolean) => Promise<CollaborationBackend>;
	launchTurn?: typeof launchCollaborationTurnProcess;
	stateDirectory?: string;
	provision?: typeof provisionHerdr;
	watch?: (directory: string, onChange: (file: string | Buffer | null) => void) => FSWatcher;
}

export function getCollaborationDataRoot(): string {
	return getProcessWorkRun(getAgentDir(), "background", "pi-collaboration", "state").path;
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
	const providers = options.providers ?? new NativeProviderRegistry();
	let binding:
		| {
				store: CollaborationJobStore;
				coordinator: CollaborationCoordinator;
				watcher: FSWatcher;
				deadlines: CollaborationDeadlines;
				controls: CollaborationControlHandoffs;
				readyJobs: Set<string>;
				recover(): Promise<void>;
		  }
		| undefined;
	const backend =
		options.backend ??
		((session, create = false) => {
			const owner = binding;
			return createHerdrBackend({
				session,
				ensureRunning: create,
				onTerminal: (terminal) => {
					if (!owner) return;
					for (const job of owner.store.list()) {
						if (job.sessionName !== session || job.agents.every((agent) => agent.closed)) continue;
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
		binding?.coordinator.dispose();
		binding?.watcher.close();
		binding?.deadlines.dispose();
		binding = undefined;
	};
	const bind = (ctx: ExtensionContext) => {
		if (binding?.store.parentSessionId === ctx.sessionManager.getSessionId()) return binding;
		close();
		const store = new CollaborationJobStore(
			options.stateDirectory ?? join(getCollaborationDataRoot(), "jobs"),
			ctx.sessionManager.getSessionId(),
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
			launchTurn: (job, agent, answer) =>
				(options.launchTurn ?? launchCollaborationTurnProcess)(store, job, agent, answer),
		});
		const deadlines = new CollaborationDeadlines(
			(jobId, agentId, turnId) => coordinator.stopAgent(jobId, agentId, turnId),
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
		const refresh = () => {
			try {
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
							.filter(
								(agent) => !agent.closed && !job.dismissed && ["running", "reserved"].includes(agent.status),
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
				ctx.ui.notify(`Collaboration handoff failed: ${String(error).slice(0, 1000)}`, "error");
			}
		};
		const changed = (file: string | Buffer | null) => {
			if (binding?.store === store && (file === null || file.toString().endsWith(".json"))) refresh();
		};
		const watcher = options.watch
			? options.watch(store.directory, changed)
			: watch(store.directory, { persistent: false }, (_event, file) => changed(file));
		watcher.on("error", (error) => ctx.ui.notify(`Collaboration signal failed: ${error.message}`, "error"));
		let reattaching: Promise<void> | undefined;
		const recover = (): Promise<void> => {
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
		binding = { store, coordinator, watcher, deadlines, controls, readyJobs, recover };
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

	const prepare = async (ctx: ExtensionContext, params: Params, probe: boolean): Promise<NewCollaborationJob> => {
		const template = params.teamTemplate ? templates().find((item) => item.name === params.teamTemplate) : undefined;
		if (params.teamTemplate && !template) throw new Error("Unknown collaboration template.");
		const specs = params.agents ??
			template?.agents ?? [
				{
					provider: "pi",
					name: "builder",
					task: "Implement the scoped task with focused regression tests. Own implementation edits; request independent review and validation from peers.",
				},
				{
					provider: "agy",
					name: "validator",
					task: "Validate the scoped task independently. Do not edit production code. Run relevant focused checks and send reproducible failures to the builder.",
				},
				{
					provider: "codex",
					name: "reviewer",
					task: "Review the scoped task for correctness, failure recovery, ownership and security. Do not edit files. Send evidence-backed findings to the builder.",
				},
			];
		const id = params.launchKey ?? `job-${randomUUID()}`;
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
			}
			result.agents.push({
				id: agentId,
				name: spec.name ?? provider,
				task: spec.task,
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
			"Persistent native-CLI subagents in Herdr: discover/authenticate, start teams, ask/answer questions, follow up, inspect results, and stop. Model CLIs remain interactive; only stopped-work or question handoffs reach the parent.",
		promptSnippet: "Persistent multi-provider subagents with terminal/question-only handoffs.",
		promptGuidelines: [
			"Use delegate for in-process workers; use pi_collaboration for persistent native CLI environments.",
			"Only terminal handoffs and questions are returned automatically. Never poll/read panes for progress or re-submit an uncertain prompt.",
			"Claude/agy use --dangerously-skip-permissions; Codex uses --dangerously-bypass-approvals-and-sandbox by explicit user policy. External CLI permissions and token budgets are not Pi-enforced.",
			"Answer a stopped agent's question with answer_question on the same jobId/agentId. New tasks use send_followup. Review evidence before treating reported success as verified.",
			"Every task, answer, environment, and result may persist; never include secrets. Stop actions preview by default; confirm=yes-collaboration-stop for actual termination.",
		],
		async execute(_id, input, signal, _update, ctx) {
			const params = input as Params;
			const action = params.action ?? "status";
			const { store, coordinator, readyJobs, recover } = bind(ctx);
			let details: unknown;
			if (action === "status" || action === "setup_help")
				details = {
					backend: "herdr",
					providers: await providers.list(),
					jobs: store.list(),
					permissionMode: "native-cli-unrestricted",
					help: "Use fire_task to start a persistent interactive team. Missing Herdr is installed on demand. Questions use answer_question; ordinary follow-ups use send_followup.",
				};
			else if (action === "guard") {
				const installation = await (options.provision ?? provisionHerdr)();
				details = { guard: { allowed: true }, installation };
			} else if (action === "list_templates") details = templates();
			else if (action === "show_template") {
				details = templates().find((item) => item.name === (params.teamTemplate ?? params.title));
				if (!details) throw new Error("Unknown collaboration template.");
			} else if (action === "list_jobs") details = store.list();
			else if (["workspace_plan", "launch_workspace", "fire_task"].includes(action)) {
				const plan = await prepare(ctx, params, action !== "workspace_plan" && params.dryRun !== true);
				if (action === "workspace_plan" || params.dryRun) details = { dryRun: true, job: plan };
				else {
					const task = params.task ?? params.body;
					if (action === "fire_task" && !task?.trim()) throw new Error("fire_task requires a task.");
					if (params.force && existsSync(store.path(plan.id))) {
						if (store.load(plan.id).agents.some((agent) => !agent.closed))
							throw new Error("Stop the existing team's native sessions before reusing its launchKey.");
						store.archive(plan.id);
					}
					const launched = await coordinator.launch(plan, action === "fire_task" ? task : undefined, signal);
					readyJobs.add(launched.id);
					details = { job: launched };
				}
			} else {
				const job = params.jobId
					? store.load(params.jobId)
					: store
							.list()
							.find(
								(item) =>
									item.title === (params.workspaceName ?? params.title) ||
									item.sessionName === params.workspaceName,
							);
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
					details = params.dryRun
						? { dryRun: true, jobId: job.id }
						: await coordinator.followup(job.id, params.agentId, task, answering ? params.answer : undefined);
				} else if (["stop_job", "stop_session", "dismiss"].includes(action)) {
					if (action !== "dismiss" && params.dryRun !== false)
						details = { dryRun: true, jobId: job.id, session: job.sessionName };
					else {
						if (action !== "dismiss" && params.confirm !== "yes-collaboration-stop")
							throw new Error("Real stop requires confirm=yes-collaboration-stop.");
						await coordinator.stop(job.id, action === "dismiss");
						details = store.load(job.id);
					}
				} else if (action === "notify") {
					await (await backend(job.sessionName)).notify(
						params.title ?? "Pi collaboration",
						(params.body ?? "Attention required").slice(0, 2000),
					);
					details = { notified: true };
				} else if (action === "set_status" || action === "clear_status") {
					const key = params.statusKey ?? "status";
					const value = action === "clear_status" ? null : (params.status ?? params.body ?? "");
					if (!job.workspaceId) throw new Error("Workspace is not running.");
					await (await backend(job.sessionName)).reportMetadata(job.workspaceId, { [key]: value }, Date.now());
					details = { key, value };
				} else throw new Error(`Unsupported collaboration action: ${action}`);
			}
			coordinator.refresh();
			const encoded = JSON.stringify(details);
			return {
				content: [
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
					...(action === "fire_task" && details && typeof details === "object" ? details : {}),
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

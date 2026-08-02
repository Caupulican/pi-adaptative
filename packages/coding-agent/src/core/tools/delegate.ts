import { type Static, Type } from "typebox";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { WorkerAgentControlPort } from "../delegation/worker-agent-control.ts";
import type { WorkerDelegationRequest } from "../delegation/worker-delegation-request.ts";
import type { WorkerRunOutcome } from "../delegation/worker-runner.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	emptyOrchestrationCall,
	type OrchestrationPanelModel,
	type OrchestrationRowStatus,
	renderOrchestrationToolResult,
} from "./orchestration-panel.ts";

function createDelegateSchema() {
	return Type.Object(
		{
			action: Type.Optional(
				Type.String({
					maxLength: 16,
					enum: ["start", "send", "follow_up", "interrupt", "resume", "cancel"],
					description:
						"Optional logical-agent action. Omit or use start to create a worker; send queues without waking; follow_up steers an active worker or wakes an idle one; interrupt is resumable; resume restores the exact admitted transcript/profile/model/resources under a fresh fence; cancel is terminal for the current task only.",
				}),
			),
			profileId: Type.Optional(
				Type.String({
					maxLength: 512,
					description:
						"Owner-authored orchestration profile to use. The profile fixes role, model, thinking, tools, resources, budget, and concurrency. Regular sessions must omit this field and use the owner's configured default; only an active owner-authored orchestrator may select an allowlisted profile.",
				}),
			),
			instructions: Type.Optional(
				Type.String({
					maxLength: 16 * 1024,
					description:
						"The self-contained task for a bounded worker with classified workspace tools. It is read-only unless workerDelegation.writeEnabled, non-empty writePaths, and its lane profile all grant write/edit; any write is path-scoped and parent-reviewed. Include all context it needs; it cannot see this conversation.",
				}),
			),
			agentId: Type.Optional(
				Type.String({
					maxLength: 512,
					description: "Stable logical worker id returned by start; never substitute a transient task lane.",
				}),
			),
			message: Type.Optional(
				Type.String({
					maxLength: 4_096,
					description: "Bounded message for send or follow_up. Send only queues it; follow_up may wake idle work.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}

const delegateSchema = createDelegateSchema();
const MAX_DELEGATE_RESULT_CHARS = 16 * 1024;
const MAX_DELEGATE_ERROR_CHARS = 1_900;
const MAX_DELEGATE_INSTRUCTIONS_CHARS = 16 * 1024;
const MAX_DELEGATE_PROFILE_ID_CHARS = 512;
const MAX_DELEGATE_AGENT_ID_CHARS = 512;
const MAX_DELEGATE_MESSAGE_CHARS = 4_096;
const MAX_PROFILE_GUIDELINE_CHARS = 4_096;
const MAX_VISIBLE_ORCHESTRATION_PROFILES = 16;
const MAX_PROFILE_GUIDELINE_FIELD_CHARS = 64;

type DelegateAction = NonNullable<DelegateToolDetails["action"]>;

function isDelegateAction(value: string): value is DelegateAction {
	return (
		value === "start" ||
		value === "send" ||
		value === "follow_up" ||
		value === "interrupt" ||
		value === "resume" ||
		value === "cancel"
	);
}

export type DelegateToolInput = Static<typeof delegateSchema>;

export interface DelegateRunOutcome {
	started: boolean;
	skipReason?: string;
	record?: LaneRecord;
	outcome?: WorkerRunOutcome;
}

export interface DelegateToolDetails {
	started: boolean;
	action?: "start" | "send" | "follow_up" | "interrupt" | "resume" | "cancel";
	agentId?: string;
	skipReason?: string;
	profileId?: string;
	laneId?: string;
	label?: string;
	status?: LaneRecord["status"];
	reasonCode?: string;
	accepted?: boolean;
	costUsd?: number;
	summary?: string;
	blockers?: readonly string[];
	queued?: boolean;
}

export interface DelegateToolDependencies {
	startWorkerDelegation?: (
		args: WorkerDelegationRequest,
	) => { started: false; skipReason: string } | { started: true; record: LaneRecord };
	runWorkerDelegation: (args: WorkerDelegationRequest) => Promise<DelegateRunOutcome>;
	orchestrationProfiles?: readonly { profileId: string; role: string; description: string }[];
	workerAgentControl?: WorkerAgentControlPort;
}

const DELEGATE_DESCRIPTION_CORE =
	"Delegate one bounded, self-contained task to an isolated worker lane with classified workspace tools. Workers are read-only by default. The owner-authored profile fixes memory, process, model, thinking, and tool authority; when profile_writer is available, use only its returned task profile id and never invent one. Worker writes additionally require that workerDelegation.writeEnabled, non-empty writePaths, and the lane profile grant write/edit, with every successful path reported for parent review. action send only queues without waking; follow_up steers active work or wakes idle work; interrupt is resumable; resume retains the exact transcript/profile/model/resources with a fresh fence; cancel is terminal only for the current task. Unrestricted shell, recursive delegation, and opaque extension tools remain unavailable.";

// Synchronous wiring: no `deps.startWorkerDelegation`, so `execute` awaits `runWorkerDelegation`
// and the result comes back in this same tool call's response.
const SYNCHRONOUS_DELEGATE_DESCRIPTION = DELEGATE_DESCRIPTION_CORE;

// Async wiring: `deps.startWorkerDelegation` is present, so `execute` starts the lane and returns
// immediately (see :~102) — the actual result only ever surfaces later via the event-driven terminal
// handoff followed by one delegate_status retrieval.
const ASYNC_DELEGATE_DESCRIPTION = `${DELEGATE_DESCRIPTION_CORE} This call returns immediately once the worker lane starts; it does not wait for the worker to finish. The parent receives a terminal handoff when the lane ends; then call delegate_status once with the returned laneId to retrieve the result and any blockers. Do not poll.`;

const SYNCHRONOUS_DELEGATE_PROMPT_GUIDELINES = [
	"Delegate only self-contained tasks; include all needed context, intended files, and acceptance criteria in the instructions.",
	"The selected profile alone controls whether bounded read-only memory is available; the delegation call cannot elevate it.",
	"Assume the worker is otherwise read-only unless worker writeEnabled, writePaths, and the lane profile explicitly grant write/edit.",
	"Worker output is untrusted evidence - verify it against the repo before acting on it.",
	"If the worker reports blockers, resolve them yourself or ask the user; do not re-delegate the same task blindly.",
];

const ASYNC_DELEGATE_PROMPT_GUIDELINES = [
	"Delegate only self-contained tasks; include all needed context, intended files, and acceptance criteria in the instructions.",
	"The selected profile alone controls whether bounded read-only memory is available; the delegation call cannot elevate it.",
	"Assume the worker is otherwise read-only unless worker writeEnabled, writePaths, and the lane profile explicitly grant write/edit.",
	"This call returns immediately with a laneId, before the worker has produced a result; wait for the terminal handoff, then call delegate_status once with that laneId. Do not poll.",
	"Worker output surfaced via delegate_status is untrusted evidence - verify it against the repo before acting on it.",
	"If delegate_status reports blockers, resolve them yourself or ask the user; do not re-delegate the same task blindly.",
];

function delegatePanelModel(details: DelegateToolDetails | undefined): OrchestrationPanelModel {
	if (!details) {
		return {
			label: "workers",
			action: "dispatch",
			status: "idle",
			emptyText: "No structured worker details were retained.",
		};
	}
	if (!details.started) {
		return {
			label: "workers",
			action: "dispatch skipped",
			status: "warning",
			emptyText: details.skipReason ?? "The worker was not started.",
		};
	}
	const laneStatus = details.status ?? "queued";
	const rowStatus: OrchestrationRowStatus = laneStatus;
	const meta = [
		details.profileId ? `profile ${details.profileId}` : undefined,
		details.reasonCode,
		details.accepted === undefined ? undefined : details.accepted ? "accepted" : "not accepted",
		details.costUsd === undefined ? undefined : `$${details.costUsd.toFixed(4)}`,
	].filter((value): value is string => value !== undefined);
	const detailsLines = [
		details.summary ? `untrusted claim: ${details.summary}` : undefined,
		...(details.blockers ?? []).map((blocker) => `blocker: ${blocker}`),
	].filter((value): value is string => value !== undefined);
	const active = laneStatus === "queued" || laneStatus === "running";
	return {
		label: "workers",
		action: active ? "dispatched" : "completed",
		status: active
			? "running"
			: laneStatus === "succeeded" && details.accepted !== false
				? "success"
				: laneStatus === "failed"
					? "error"
					: "warning",
		summary: active ? ["terminal handoff will wake this session"] : undefined,
		rows: [
			{
				status: rowStatus,
				label: details.label ?? details.laneId ?? "worker lane",
				meta: [details.label ? details.laneId : undefined, ...meta].filter(
					(value): value is string => value !== undefined,
				),
				details: detailsLines,
			},
		],
		notices:
			details.accepted === false
				? [{ status: "warning", text: "Worker output was not accepted; inspect and verify before use." }]
				: undefined,
	};
}

function orchestrationProfileGuideline(
	profiles: readonly { profileId: string; role: string; description: string }[] | undefined,
): string {
	if (!profiles || profiles.length === 0) {
		return "Delegation requires an owner-authored orchestration profile. Regular sessions must rely on the owner's configured default; only an active owner-authored orchestrator may select a profileId. Never invent, create, or edit profiles during delegation.";
	}
	const visibleProfiles = profiles.slice(0, MAX_VISIBLE_ORCHESTRATION_PROFILES);
	const entries = visibleProfiles.map((profile) => {
		const profileId = profile.profileId.slice(0, MAX_PROFILE_GUIDELINE_FIELD_CHARS);
		const role = profile.role.slice(0, MAX_PROFILE_GUIDELINE_FIELD_CHARS);
		const description = profile.description.slice(0, MAX_PROFILE_GUIDELINE_FIELD_CHARS);
		return `${profileId} (${role}: ${description})`;
	});
	const omitted = profiles.length - visibleProfiles.length;
	return [
		`Available owner-authored orchestration profiles: ${profiles.length} configured; ${entries.join("; ")}`,
		...(omitted > 0 ? [`${omitted} omitted from this prompt; use the owner profile catalog to select them.`] : []),
		"Only an active owner-authored orchestrator may select an allowlisted profileId; regular sessions must omit it and use the owner's configured default. Never invent, create, or edit profiles during delegation, and never infer or request a model/thinking override.",
	]
		.join(" ")
		.slice(0, MAX_PROFILE_GUIDELINE_CHARS);
}

export function createDelegateToolDefinition(deps: DelegateToolDependencies): ToolDefinition {
	const isAsyncWiring = deps.startWorkerDelegation !== undefined;
	const profileGuideline = orchestrationProfileGuideline(deps.orchestrationProfiles);
	return {
		name: "delegate",
		label: "delegate",
		description: isAsyncWiring ? ASYNC_DELEGATE_DESCRIPTION : SYNCHRONOUS_DELEGATE_DESCRIPTION,
		promptSnippet: "Delegate a bounded task to an isolated, least-privilege worker lane.",
		promptGuidelines: [
			profileGuideline,
			...(isAsyncWiring ? ASYNC_DELEGATE_PROMPT_GUIDELINES : SYNCHRONOUS_DELEGATE_PROMPT_GUIDELINES),
		],
		parameters: delegateSchema,
		renderShell: "self",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as DelegateToolDetails | undefined;
			return renderOrchestrationToolResult(theme, delegatePanelModel(details), {
				isPartial,
				collapse: !expanded && details?.started === true,
				expanded,
			});
		},
		async execute(
			_toolCallId,
			input: DelegateToolInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: DelegateToolDetails;
		}> {
			const requestedAction = input.action ?? "start";
			const invalid = (message: string, actionDetails: DelegateToolDetails) => ({
				content: [{ type: "text" as const, text: message }],
				details: actionDetails,
			});
			if (!isDelegateAction(requestedAction)) {
				return invalid(`delegate action is invalid: ${requestedAction}`, {
					started: false,
					skipReason: "invalid_action",
				});
			}
			const action = requestedAction;
			if (input.instructions !== undefined && input.instructions.length > MAX_DELEGATE_INSTRUCTIONS_CHARS) {
				return invalid(`delegate instructions may not exceed ${MAX_DELEGATE_INSTRUCTIONS_CHARS} characters`, {
					started: false,
					action,
					skipReason: "instructions_too_long",
				});
			}
			if (input.profileId !== undefined && input.profileId.length > MAX_DELEGATE_PROFILE_ID_CHARS) {
				return invalid(`delegate profileId may not exceed ${MAX_DELEGATE_PROFILE_ID_CHARS} characters`, {
					started: false,
					action,
					skipReason: "profile_id_too_long",
				});
			}
			if (input.agentId !== undefined && input.agentId.length > MAX_DELEGATE_AGENT_ID_CHARS) {
				return invalid(`delegate agentId may not exceed ${MAX_DELEGATE_AGENT_ID_CHARS} characters`, {
					started: false,
					action,
					skipReason: "agent_id_too_long",
				});
			}
			if (input.message !== undefined && input.message.length > MAX_DELEGATE_MESSAGE_CHARS) {
				return invalid(`delegate message may not exceed ${MAX_DELEGATE_MESSAGE_CHARS} characters`, {
					started: false,
					action,
					skipReason: "message_too_long",
				});
			}
			const requireAgentId = (): string | undefined => {
				const agentId = input.agentId?.trim();
				if (agentId) return agentId;
				return undefined;
			};
			try {
				if (action !== "start") {
					const agentId = requireAgentId();
					if (!agentId)
						return invalid(`delegate ${action} requires agentId`, {
							started: false,
							action,
							skipReason: "missing_agent_id",
						});
					if (action === "send" || action === "follow_up") {
						const message = input.message?.trim();
						if (!message)
							return invalid(`delegate ${action} requires message`, {
								started: false,
								action,
								agentId,
								skipReason: "missing_message",
							});
						if (action === "send") {
							if (!deps.workerAgentControl)
								return invalid("delegate send is unavailable", {
									started: false,
									action,
									agentId,
									skipReason: "worker_agent_control_unavailable",
								});
							const outcome = deps.workerAgentControl.sendWorkerAgentMessage(agentId, message);
							return {
								content: [
									{
										type: "text" as const,
										text: `message queued for ${agentId}; it will not wake the worker`,
									},
								],
								details: { started: true, action, agentId, queued: outcome.queued },
							};
						}
						if (!deps.workerAgentControl)
							return invalid("delegate follow_up is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const outcome = deps.workerAgentControl.followUpWorkerAgent(agentId, message);
						return {
							content: [
								{
									type: "text" as const,
									text: `follow_up ${outcome.started ? "started" : "queued"} for ${agentId}`,
								},
							],
							details: {
								started: outcome.started,
								action,
								agentId,
								laneId: outcome.record?.laneId,
								status: outcome.record?.status,
								skipReason: outcome.skipReason,
							},
						};
					}
					if (action === "interrupt") {
						if (!deps.workerAgentControl)
							return invalid("delegate interrupt is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const outcome = deps.workerAgentControl.interruptWorkerAgent(agentId);
						return {
							content: [
								{
									type: "text" as const,
									text: outcome.interrupted
										? `worker ${agentId} interrupted; resume preserves its admitted state`
										: `worker ${agentId} was not interrupted (${outcome.reason ?? "unknown"})`,
								},
							],
							details: { started: outcome.interrupted, action, agentId, skipReason: outcome.reason },
						};
					}
					if (action === "resume") {
						if (!deps.workerAgentControl)
							return invalid("delegate resume is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const outcome = deps.workerAgentControl.resumeWorkerAgent(agentId);
						return {
							content: [
								{
									type: "text" as const,
									text: outcome.started
										? `worker ${agentId} resumed with its admitted transcript and authority`
										: `worker ${agentId} was not resumed (${outcome.skipReason ?? "unknown"})`,
								},
							],
							details: {
								started: outcome.started,
								action,
								agentId,
								laneId: outcome.record?.laneId,
								status: outcome.record?.status,
								skipReason: outcome.skipReason,
							},
						};
					}
					if (!deps.workerAgentControl)
						return invalid("delegate cancel is unavailable", {
							started: false,
							action,
							agentId,
							skipReason: "worker_agent_control_unavailable",
						});
					const cancelled = deps.workerAgentControl.cancelWorkerAgent(agentId);
					return {
						content: [
							{
								type: "text" as const,
								text: cancelled
									? `worker ${agentId} cancelled for its current task`
									: `worker ${agentId} was not cancelled`,
							},
						],
						details: {
							started: Boolean(cancelled),
							action,
							agentId,
							laneId: cancelled?.laneId,
							status: cancelled?.status,
							reasonCode: cancelled?.reasonCode,
						},
					};
				}
				const instructions = input.instructions?.trim();
				if (!instructions)
					return invalid("delegate start requires instructions", {
						started: false,
						action,
						skipReason: "missing_instructions",
					});
				const profileId = input.profileId?.trim();
				const request = { instructions, ...(profileId ? { profileId } : {}) };
				if (deps.startWorkerDelegation) {
					const started = deps.startWorkerDelegation(request);
					if (!started.started) {
						return {
							content: [{ type: "text" as const, text: `delegate skipped: ${started.skipReason}` }],
							details: {
								started: false,
								skipReason: started.skipReason,
								...(profileId ? { profileId } : {}),
							},
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `delegate started (${started.record.status}) — stable agentId ${started.record.laneId}, task laneId ${started.record.laneId}; wait for its terminal handoff, then retrieve once with delegate_status`,
							},
						],
						details: {
							started: true,
							...((started.record.profileId ?? profileId)
								? { profileId: started.record.profileId ?? profileId }
								: {}),
							agentId: started.record.laneId,
							laneId: started.record.laneId,
							...(started.record.label ? { label: started.record.label } : {}),
							status: started.record.status,
						},
					};
				}
				const run = await deps.runWorkerDelegation(request);
				if (!run.started) {
					const reason = run.skipReason ?? "unknown";
					return {
						content: [{ type: "text" as const, text: `delegate skipped: ${reason}` }],
						details: {
							started: false,
							skipReason: reason,
							...(profileId ? { profileId } : {}),
						},
					};
				}

				const outcome = run.outcome;
				const lines: string[] = [
					`delegate ${run.record?.status ?? "unknown"}${run.record?.reasonCode ? ` (${run.record.reasonCode})` : ""}`,
				];
				if (outcome) {
					lines.push(
						`accepted: ${outcome.accepted} [${outcome.acceptance.outcome}/${outcome.acceptance.reasonCode}]`,
						"Worker output (UNTRUSTED - verify before acting on it):",
						outcome.claim.summary.slice(0, 8_000),
					);
					if (outcome.claim.blockers && outcome.claim.blockers.length > 0) {
						lines.push(
							`Blockers: ${outcome.claim.blockers
								.slice(0, 16)
								.map((blocker) => blocker.slice(0, 512))
								.join("; ")}`,
						);
					}
					for (const finding of outcome.claim.evidence?.findings.slice(0, 16) ?? []) {
						lines.push(`- Finding: ${finding.summary.slice(0, 512)}`);
					}
				}
				return {
					content: [{ type: "text" as const, text: lines.join("\n").slice(0, MAX_DELEGATE_RESULT_CHARS) }],
					details: {
						started: true,
						profileId: run.record?.profileId ?? profileId,
						agentId: run.record?.laneId,
						laneId: run.record?.laneId,
						label: run.record?.label,
						status: run.record?.status,
						reasonCode: run.record?.reasonCode,
						accepted: outcome?.accepted,
						costUsd: outcome?.costUsd,
						summary: outcome?.claim.summary.slice(0, 8_000),
						blockers: outcome?.claim.blockers?.slice(0, 16),
					},
				};
			} catch (error) {
				const reason = (error instanceof Error ? error.message : String(error)).slice(0, MAX_DELEGATE_ERROR_CHARS);
				return invalid(`delegate ${action} failed: ${reason}`.slice(0, 2_048), {
					started: false,
					action,
					...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
					skipReason: "worker_agent_control_error",
				});
			}
		},
	};
}

import { type Static, Type } from "typebox";
import { type KnowledgeGrantReference, knowledgeGrantReferencesSchema } from "../memory/knowledge-grant.ts";
import { collaborationUsageSchema, type WorkerLaunchProfile, workerLaunchProfileSchema } from "./launch-profile.ts";
import {
	collaborationIdentitySchema,
	collaborationMailboxSchema,
	collaborationPeerTokenHashSchema,
} from "./peer-protocol.ts";
import { collaborationPendingQuestionSchema, collaborationResultClaimSchema } from "./result-claim.ts";

const identity = collaborationIdentitySchema;

const shortText = Type.String({ maxLength: 4096 });

export const digestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });

/**
 * A process as a record owner (`ProcessOwner` in kernel/reliability/owner-identity.ts): its pid, Linux start time and
 * host. Written by `ownProcessOwner()` and judged only by `judgeOwner()`, so a reissued pid or a pid from another
 * machine never reads as the recorded process.
 */
export const processOwnerSchema = Type.Object(
	{
		pid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		startTime: Type.Optional(Type.String({ pattern: "^[0-9]{1,32}$" })),
		// The bounds of `isProcessOwnerRecord`, so every owner `ownProcessOwner()` writes validates here.
		hostname: Type.Optional(Type.String({ maxLength: 255 })),
		machineId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{32}$" })),
	},
	{ additionalProperties: false },
);

const startReceiptSchema = Type.Object(
	{
		key: identity,
		parentSessionId: Type.Optional(shortText),
		digest: digestSchema,
		turns: Type.Array(Type.Object({ agentId: identity, turnId: shortText }), { minItems: 1, maxItems: 12 }),
	},
	{ additionalProperties: false },
);

export const taskCorrelationSchema = Type.Object({ goalId: Type.Optional(shortText) }, { additionalProperties: false });

export type CollaborationTaskCorrelation = Static<typeof taskCorrelationSchema>;

/** UTF-8 bound of one turn's projected knowledge; the delivered text stays inside the backend's prompt limit. */
export const MAX_COLLABORATION_KNOWLEDGE_BYTES = 8 * 1024;

/** One new task's knowledge grant: the exact references and their projection rendered by the host. */
export interface CollaborationKnowledgeHandoff {
	readonly references: readonly KnowledgeGrantReference[];
	readonly context: string;
}

const terminalSchema = Type.Union([
	Type.Literal("done"),
	Type.Literal("blocked"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
	Type.Literal("dismissed"),
]);

export type CollaborationTerminal = Static<typeof terminalSchema>;

/** A launched worker's own capability refusal, recorded by the worker before it exits so the controller can report why. */
export const workerRefusalSchema = Type.Object(
	{
		reason: Type.String({ maxLength: 128 }),
		capabilityClass: Type.String({ maxLength: 32 }),
		contextWindow: Type.Optional(Type.Number()),
		message: Type.String({ minLength: 1, maxLength: 1024 }),
	},
	{ additionalProperties: false },
);

export type CollaborationWorkerRefusal = Static<typeof workerRefusalSchema>;

/** Distinct attributed notices a worker records about what a tool-only extension grant ignored. */
export const MAX_COLLABORATION_WORKER_NOTICES = 16;

export const MAX_COLLABORATION_WORKER_NOTICE_LENGTH = 256;

const steeringRequestSchema = Type.Object(
	{
		requestId: Type.String({ maxLength: 128 }),
		priorTurnId: Type.String({ maxLength: 128 }),
		prompt: Type.String({ maxLength: 32768 }),
		answering: Type.Boolean(),
		admittedAt: Type.Number(),
	},
	{ additionalProperties: false },
);

export type CollaborationSteeringRequest = Static<typeof steeringRequestSchema>;

const agentSchema = Type.Object(
	{
		id: identity,
		name: Type.String({ minLength: 1, maxLength: 128 }),
		provider: identity,
		cwd: shortText,
		args: Type.Array(shortText, { maxItems: 128 }),
		env: Type.Record(Type.String(), shortText, { maxProperties: 128 }),
		profile: workerLaunchProfileSchema,
		task: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
		direction: Type.Optional(Type.Union([Type.Literal("right"), Type.Literal("down")])),
		peerTokenHash: Type.Optional(collaborationPeerTokenHashSchema),
		executable: Type.Optional(shortText),
		paneId: Type.Optional(shortText),
		terminalId: Type.Optional(shortText),
		backendName: Type.Optional(identity),
		stopping: Type.Optional(Type.Boolean()),
		/** A backend pane/workspace request is outstanding for this member and its outcome is unknown.
		 * Durable because an absent paneId is not evidence that no resource exists: the reply may have
		 * been lost after the resource was created. Cleared only by an acquisition outcome or a terminal
		 * transition, never inferred. */
		acquiring: Type.Optional(Type.Boolean()),
		/** The process that issued the outstanding acquisition. Only it can learn the request's outcome, so the
		 * acquisition is abandoned exactly when this process is proven gone, whoever controls the job since. */
		acquiredBy: Type.Optional(processOwnerSchema),
		closed: Type.Optional(Type.Boolean()),
		turn: Type.Integer({ minimum: 0, maximum: 128 }),
		turnId: Type.String({ maxLength: 128 }),
		status: Type.Union([Type.Literal("idle"), Type.Literal("reserved"), Type.Literal("running"), terminalSchema]),
		prompt: Type.String({ maxLength: 32768 }),
		/**
		 * Exact owner-knowledge versions projected for this turn's task at reservation; replaced by every reservation.
		 * They stay when the projection is withdrawn before delivery: they record the grant, not a delivery.
		 */
		knowledgeReferences: Type.Optional(knowledgeGrantReferencesSchema("Granted knowledge versions of this turn.")),
		/**
		 * The rendered projection of those versions, delivered with this turn's task and never part of `prompt`
		 * (which becomes durable dispatch history). Replaced by a withdrawal notice before delivery when a granted
		 * version changed or was forgotten; removed by the helper's claim (read at most once) or by settlement.
		 */
		knowledgeContext: Type.Optional(Type.String({ maxLength: MAX_COLLABORATION_KNOWLEDGE_BYTES })),
		/** Current task ownership; an empty object deliberately means no goal. */
		taskCorrelation: Type.Optional(taskCorrelationSchema),
		evidence: Type.String({ maxLength: 16000 }),
		usage: Type.Optional(collaborationUsageSchema),
		resultClaim: Type.Optional(collaborationResultClaimSchema),
		pendingQuestion: Type.Optional(collaborationPendingQuestionSchema),
		workerRefusal: Type.Optional(workerRefusalSchema),
		/** Bounded, distinct `<extension path>: <ignored label>` notices the worker recorded as they happened. */
		workerNotices: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: MAX_COLLABORATION_WORKER_NOTICE_LENGTH }), {
				maxItems: MAX_COLLABORATION_WORKER_NOTICES,
			}),
		),
		helperPid: Type.Optional(Type.Integer({ minimum: 1 })),
		/** The helper's Linux start time beside `helperPid`, so a reissued pid never reads as the live helper.
		 * Absent off Linux, when procfs cannot answer, and in records written before it existed. */
		helperStartTime: Type.Optional(Type.String({ pattern: "^[0-9]{1,32}$" })),
		deadlineAt: Type.Optional(Type.Number()),
		notifiedTurn: Type.Integer({ minimum: 0, maximum: 128 }),
		/** Present only when this coordinator owns dispatch publication. Zero records unacknowledged
		 * intent; absence does not authorize reconstructing another publisher's dispatch contract. */
		notifiedDispatchTurn: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })),
		/** The member's persistent CLI closure has been published to the durable lane projection. A
		 * closure is a fact about the agent, not about a turn, so turn-based deduplication cannot
		 * suppress it and cannot republish it either. */
		notifiedClosure: Type.Optional(Type.Boolean()),
		steering: Type.Optional(steeringRequestSchema),
	},
	{ additionalProperties: false },
);

export const jobSchema = Type.Object(
	{
		version: Type.Literal(1),
		id: identity,
		parentSessionId: shortText,
		parentSessionFile: Type.Optional(shortText),
		/**
		 * Who controls the job. Two things: the SESSION it belongs to (`parentSessionId`, a durable identity that can be
		 * resumed at any time) and the CONTROLLER binding serving it now (`owner`, the live process, fenced by
		 * `generation`). The binding moves only through a fenced transfer that bumps the generation: creation, a session
		 * taking back its own job, or an explicit adoption, which leaves `parentSessionId` unchanged and records the
		 * adopting session in `adoptedBy`. Launch provenance and the CLI's peer identity remain immutable.
		 * Records written before the owner existed carry `parentPid`/`parentStartTime`, upgraded on read.
		 */
		controller: Type.Optional(
			Type.Object(
				{
					parentSessionId: shortText,
					generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
					/** The controlling process; absent only in records that predate controller recording. */
					owner: Type.Optional(processOwnerSchema),
					/** The serving session held a bundle lease in `owner` when bound: `owner` then serves it only while it is
					 * still one of that session's lease holders (a process that switched sessions no longer does). */
					leased: Type.Optional(Type.Boolean()),
					/** The session whose process adopted the job; handoffs publish into it. Absent when the job's own session
					 * serves it. */
					adoptedBy: Type.Optional(shortText),
					adoptedAt: Type.Optional(Type.Number()),
				},
				{ additionalProperties: false },
			),
		),
		sessionName: identity,
		workspaceId: Type.Optional(shortText),
		cwd: shortText,
		title: shortText,
		createdAt: Type.Number(),
		deadlineSeconds: Type.Integer({ minimum: 5, maximum: 86400 }),
		goalId: Type.Optional(shortText),
		specializationKey: Type.Optional(digestSchema),
		startReceipts: Type.Optional(Type.Array(startReceiptSchema, { maxItems: 128 })),
		dismissed: Type.Boolean(),
		variables: Type.Record(Type.String(), shortText, { maxProperties: 128 }),
		metadata: Type.Record(Type.String(), shortText, { maxProperties: 128 }),
		mailbox: collaborationMailboxSchema,
		peerCommand: Type.Optional(Type.String({ maxLength: 16384 })),
		agents: Type.Array(agentSchema, { minItems: 1, maxItems: 12 }),
		placement: Type.Optional(Type.Union([Type.Literal("current-pane"), Type.Literal("managed-workspace")])),
		socketPath: Type.Optional(shortText),
		binPath: Type.Optional(shortText),
		callerPaneId: Type.Optional(shortText),
		callerTerminalId: Type.Optional(shortText),
		callerWorkspaceId: Type.Optional(shortText),
		callerTabId: Type.Optional(shortText),
	},
	{ additionalProperties: false },
);

export type CollaborationAgent = Omit<Static<typeof agentSchema>, "profile"> & { profile: WorkerLaunchProfile };

export type CollaborationJob = Omit<Static<typeof jobSchema>, "agents"> & { agents: CollaborationAgent[] };

export type NewCollaborationJob = Omit<
	CollaborationJob,
	"version" | "variables" | "metadata" | "dismissed" | "agents" | "mailbox" | "controller"
> & {
	agents: Array<Omit<CollaborationAgent, "turn" | "turnId" | "status" | "prompt" | "evidence" | "notifiedTurn">>;
};

export function collaborationLaneId(jobId: string, agentId: string): string {
	return `collaboration:${jobId}:${agentId}`;
}

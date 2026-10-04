import { type Static, Type } from "typebox";
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
		closed: Type.Optional(Type.Boolean()),
		turn: Type.Integer({ minimum: 0, maximum: 128 }),
		turnId: Type.String({ maxLength: 128 }),
		status: Type.Union([Type.Literal("idle"), Type.Literal("reserved"), Type.Literal("running"), terminalSchema]),
		prompt: Type.String({ maxLength: 32768 }),
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
		/** Effective task controller; launch provenance and the CLI's peer identity remain immutable. */
		controller: Type.Optional(
			Type.Object(
				{
					parentSessionId: shortText,
					parentPid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
					generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
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

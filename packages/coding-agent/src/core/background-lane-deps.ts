/**
 * The dependency contract of the background lane coordinator: the session, runtime and channel ports its lanes, routines and
 * daemon are built from, and the outcome type of a bounded wait on running worker attempts. Types only; the coordinator
 * (`background-lane-controller.ts`) is the one module that names them.
 */
import type { SessionManager } from "../kernel/node.ts";
import type { GoalContinuationLoopOptions, GoalContinuationLoopResult } from "./agent-session-contracts.ts";
import type { OwnerChannelControl, OwnerChannelDelivery } from "./channels/owner-channel-types.ts";
import type {
	ForegroundTranscriptWriteDeps,
	ForegroundTranscriptWrites,
} from "./delegation/foreground-parent-writes.ts";
import type { ParentExecutionContext } from "./delegation/parent-execution-context.ts";
import type { SendUserMessageOptions } from "./extensions/types.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { HarnessNoticeKind, HarnessNoticeObservation } from "./harness-notice.ts";
import type { OwnerEvidenceLedger } from "./learning/owner-evidence-ledger.ts";
import type { ModelCapabilityProfile } from "./model-capability.ts";
import type { ParentInputDelivery, ParentInputReceipt } from "./parent-input-delivery.ts";
import type { ProactivityControllerDeps } from "./proactivity/proactivity-controller.ts";
import type { LaneModelResolverDeps } from "./research/lane-model-resolver.ts";
import type { ModelFitnessControllerDeps } from "./research/model-fitness-controller.ts";
import type { ResearchLaneControllerDeps } from "./research/research-lane-controller.ts";
import type { RoutineScope } from "./routines/routine-holder.ts";
import type { SessionSemanticPlaneController } from "./session-semantic-plane-controller.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { NestedCallAdmitter } from "./tools/nested-tool-call.ts";
import type { WorktreeSyncEnginePorts } from "./worktree-sync/runtime.ts";

/** The parent execution context serves worker execution; the other members serve the remaining lanes and routines. */
export interface BackgroundLaneControllerDeps
	extends Omit<ParentExecutionContext, keyof ForegroundTranscriptWrites | "getSessionManager">,
		Pick<ForegroundTranscriptWriteDeps, "reportWorkerTerminal">,
		ResearchLaneControllerDeps,
		ModelFitnessControllerDeps,
		LaneModelResolverDeps,
		Pick<
			ProactivityControllerDeps,
			"deliverNotes" | "captureReviewContext" | "subscribeForegroundActivity" | "aggregateUsageWindow"
		> {
	/**
	 * Observe a capability's kept state; true when the owner is told of it (the session can keep the notice). `onLost`
	 * hears once that a notice reported kept was dropped unsaved.
	 */
	observeHarnessNotice?(
		kind: HarnessNoticeKind,
		read: () => HarnessNoticeObservation | undefined,
		onLost?: () => void,
	): boolean;
	/** The session's transcript writer; worker execution receives only its reader and the transcript writes derived here. */
	getSessionManager(): SessionManager;
	/** The full settings manager: this coordinator hands it to every lane, each of which reads only its own port. */
	getSettingsManager(): SettingsManager;
	/** Host-supplied worktree-sync engine ports, forwarded into every engine-deps build. */
	getWorktreeSyncEnginePorts(): WorktreeSyncEnginePorts | undefined;
	/** True iff the active surface can terminalize a goal through `goal` or `update_goal`.
	 * Explicit tool/profile exclusion and the worker-role ceiling still disable continuation. */
	isGoalToolActive(): boolean;
	/** Capability profile of the SESSION model (gates background lanes, scales continuation budgets). */
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Continuation gate + goal state for the idle autosteer scheduler. */
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	/** Drive-loop boundary: the session's bounded goal-continuation loop (owns `prompt()`, not us). */
	continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult>;
	/** True while the session owns a foreground prompt/retry/follow-up run. */
	isForegroundBusy(): boolean;
	/** Resolve only after the complete foreground retry/follow-up run releases the session. */
	waitForForegroundIdle(): Promise<void>;
	/** Persist an explicit stopped state when the selected surface cannot drive the active goal. */
	markGoalToolUnavailable(): void;
	/**
	 * The session's semantic plane: its bound engine, if any (routine intake judges with it before the session model),
	 * whether System One is configured without one (`/status`), and the choices it runs on, which a bot's session takes.
	 */
	readonly systemOne: Pick<
		SessionSemanticPlaneController,
		"recordingSemanticEngine" | "semanticDecisionEngine" | "configured" | "enabled" | "source"
	>;
	/** What the session's routine runtime holds (`routine-holder.ts`): undefined for a child session that holds none. */
	routineScope(): RoutineScope | undefined;
	getToolInvocationKey(callId: string, toolName: string): string;
	/** The session gate's admission of a sub-call of an admitted call: a routine save admits its watch's check through it. */
	admitNestedToolCall: NestedCallAdmitter;
	/** The session's own tool surface: a routine save arms a watch's check only with a tool the session holds. */
	getForegroundToolNames(): readonly string[];
	deliverParentInput(input: ParentInputDelivery): Promise<ParentInputReceipt>;
	/** The session's `sendUserMessage`: a channel batch enters as a third party's words under its origin. */
	sendUserMessage(text: string, options: SendUserMessageOptions): Promise<void>;
	/** The session's owner channel: an owner batch enters as the owner's words through it (`OwnerChannelSession`). */
	readonly ownerChannel?: OwnerChannelDelivery & { control(): OwnerChannelControl | undefined };
	/** Rebuild the session's tool registry: the channel release tool follows the channel policies. */
	refreshToolRegistry(): void;
	/** The session's genuine owner input: routine tool saves read the current run's owner source, routine intake its words. */
	getOwnerEvidence(): Pick<
		OwnerEvidenceLedger,
		"subscribe" | "readSources" | "findSource" | "listOwnerEvidence" | "currentTurnSources"
	>;
}

/** How one bounded wait on exact running attempts ended. */
export type RunningAttemptWaitOutcome =
	/** These captured attempts left "running"; the terminal ones were observed. */
	| { readonly kind: "changed"; readonly attemptIds: readonly string[] }
	/** The bound elapsed with every captured attempt still running; nothing was observed. */
	| { readonly kind: "timed_out" }
	/** The session was disposed first; nothing about the attempts is implied or observed. */
	| { readonly kind: "disposed" };

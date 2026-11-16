/**
 * The tools the host installs on a worker attempt with the attempt's admitted identity, outside the granted tool surface: the
 * task's event control and the watch the runtime arms for its own wait. Neither takes an identity from the model, neither
 * needs a grant, and neither widens what the worker can do: a watch's check is admitted by the lane's own gate and kept
 * inside the lane's scope (`toolSurface.shellFacts`). Beside them the host follows the worker's own calls and arms its
 * waits on what they start outside it (a push's CI, a dispatched run), as it does for the session, telling the worker while
 * its attempt runs and, once it stopped reading its mailbox, telling the session only what the host left unwatched (also
 * what a note the worker never took asked of it).
 */
import { createHash } from "node:crypto";
import type { AgentTool } from "../../kernel/index.ts";
import { TASK_EVENTS_TOOL_NAME } from "../events/host-event-tool-names.ts";
import { createTaskEventsTool } from "../events/task-events-tool.ts";
import { TASK_WATCH_TOOL_NAME } from "../routines/routine-tool-names.ts";
import { createTaskWatchTool, type TaskWatchPort } from "../routines/task-watch-tool.ts";
import type { NestedCallPurpose } from "../tools/nested-tool-call.ts";
import { WatchAutoArm, type WatchAutoArmNote, watchAutoArmNoteText } from "../watches/watch-auto-arm.ts";
import type { WorkerAttemptExecutorOptions } from "./worker-attempt-executor.ts";
import { WorkerCompletionProtocolError } from "./worker-provider-turn-protocol.ts";

/** The names of the host-installed tools: a call to one is the host's own and skips the grant gate. */
export const WORKER_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([TASK_EVENTS_TOOL_NAME, TASK_WATCH_TOOL_NAME]);

/** The host-installed tools, and the ends of what the host follows for the attempt (its own calls). */
export interface WorkerHostTools {
	readonly tools: AgentTool[];
	/**
	 * The attempt stopped reading its mailbox: the worker takes no more of the host's notes in it (one would start it a new
	 * task), so an arming still in flight tells the session what it left unwatched and nothing else, and a note queued to
	 * the worker that it never took is failed, what it asked for action going to the session. Called in the same step as
	 * the loop's last read of its mailbox (`worker-follow-up-read.ts`), and, for a run that ended without that read (an
	 * error, an abort, a halt), before the attempt's terminal is recorded; once.
	 */
	readonly settle: () => void;
	/** The attempt settled physically: the host stops following its calls (and the run counts as ended). */
	readonly release: () => void;
}

export function createWorkerHostTools(
	options: Pick<
		WorkerAttemptExecutorOptions,
		| "agentControl"
		| "agentId"
		| "conversation"
		| "cwd"
		| "durableHandle"
		| "parentSessionId"
		| "signal"
		| "toolSurface"
		| "warn"
	> & { readonly watches?: TaskWatchPort },
	admissionClosed: () => boolean,
): WorkerHostTools {
	const withEventControl = <T>(operation: () => T): T => {
		options.signal?.throwIfAborted();
		options.toolSurface.assertHealthy();
		if (admissionClosed()) throw new WorkerCompletionProtocolError("Worker event control admission is closed.");
		return options.conversation.withHostEventControl(options.parentSessionId, operation);
	};
	const taskEvents = createTaskEventsTool({
		callerAgentId: options.agentId,
		taskId: options.durableHandle.taskId,
		execution: {
			attemptId: options.durableHandle.attemptId,
			leaseId: options.durableHandle.leaseId,
			fencingToken: options.durableHandle.fencingToken,
		},
		port: {
			readHostEvents: (query, scope) => withEventControl(() => options.agentControl.readHostEvents(query, scope)),
			changeHostEventSubscriptions: (input, scope) =>
				withEventControl(() => options.agentControl.changeHostEventSubscriptions(input, scope)),
		},
	});
	if (!options.watches?.available()) return { tools: [taskEvents], settle: () => {}, release: () => {} };
	const { toolSurface } = options;
	const caller = {
		runtimeId: options.agentId,
		scope: toolSurface.shellFacts,
		admitCall: (toolName: string, args: unknown, signal?: AbortSignal, purpose?: NestedCallPurpose) => {
			options.signal?.throwIfAborted();
			if (admissionClosed()) throw new WorkerCompletionProtocolError("Worker watch admission is closed.");
			return toolSurface.admitHostCall(toolName, args, signal, purpose);
		},
	};
	return {
		tools: [taskEvents, createTaskWatchTool({ caller, port: options.watches })],
		...followOwnCalls(options, options.watches),
	};
}

/** The reason a note of the host's the worker's attempt never took is failed with when the attempt stops reading. */
const UNTAKEN_NOTE_REASON = "worker_attempt_ended:host_note_untaken";

/** A note of the host's queued to the worker's mailbox while its attempt read it, kept until the attempt settles. */
interface QueuedNote {
	readonly messageId: string;
	readonly action: readonly string[];
	readonly callStartedAt: number;
}

/**
 * Arms the worker's own waits on what its calls start outside it, as the session's are armed (`watch-auto-arm.ts`): a push
 * from its checkout arms a `ci` watch on what it pushed, a dispatched run or a release a `github_run` or `release` watch,
 * in the worker's own slots, each waking the worker. A call is read when its body ends, from its own result. While the
 * attempt reads its mailbox the worker is told what was armed, and what was not and why. An arming can finish after that
 * (a dispatched run is listed for up to two minutes after the call): the worker is then told nothing, since a note would
 * start it a new task, and each armed watch still wakes it with its result; what was left unwatched goes to the session
 * root instead, which can act on it or pass it on, unless an owner's stop since the call began ended its work. A note
 * queued to the worker that it had not taken when its attempt stopped reading (an error, an abort, a halt, or a note read
 * and not taken) is failed at the settle, since publishing the terminal would start it as a new task, and what it asked
 * for action goes to the session root the same way; so does a note the worker's runtime did not take. Returns the
 * settle (the attempt stopped reading its mailbox) and the release (the attempt settled physically, after which no call is
 * followed).
 */
function followOwnCalls(
	options: Pick<
		WorkerAttemptExecutorOptions,
		"agentControl" | "agentId" | "cwd" | "durableHandle" | "signal" | "toolSurface" | "warn"
	>,
	watches: TaskWatchPort,
): Pick<WorkerHostTools, "settle" | "release"> {
	const worker = { runtimeId: options.agentId, scope: options.toolSurface.shellFacts };
	let settled = false;
	let notes = 0;
	const queued: QueuedNote[] = [];
	// Keyed by the attempt, whose count starts again at one: the same words told in a later attempt are a message of their own.
	// The worker's and the attempt's ids (a worker's up to 512 characters) are digested, so the key stays inside the 256 a
	// session's parent input id holds when a note goes to the session; the same note keeps its key on every retry.
	const attempt = createHash("sha256")
		.update(JSON.stringify([options.agentId, options.durableHandle.attemptId]))
		.digest("hex")
		.slice(0, 32);
	const key = (text: string) =>
		`watch-auto-arm:${attempt}:${++notes}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
	const toSession = (action: readonly string[], callStartedAt: number) => {
		if (action.length === 0) return;
		const text = action.join("\n");
		watches.noteSessionForWorker(worker, text, key(text), callStartedAt);
	};
	const note = (arming: WatchAutoArmNote, callStartedAt: number) => {
		if (settled) {
			toSession(arming.action, callStartedAt);
			return;
		}
		const text = watchAutoArmNoteText(arming);
		const messageId = watches.noteWorker(worker, text, key(text));
		if (messageId === undefined) toSession(arming.action, callStartedAt);
		else queued.push({ messageId, action: arming.action, callStartedAt });
	};
	const settle = () => {
		if (settled) return;
		settled = true;
		const failures = new Set<string>();
		for (const { messageId, action, callStartedAt } of queued.splice(0)) {
			let failed: boolean;
			try {
				failed = options.agentControl.deadLetterUntakenMessage(options.agentId, messageId, UNTAKEN_NOTE_REASON);
			} catch (error) {
				// Still pending: the note stays the worker's, and the settle goes on for the others and the run's own end.
				failures.add(error instanceof Error ? error.message : String(error));
				continue;
			}
			if (failed) toSession(action, callStartedAt);
		}
		for (const failure of failures)
			options.warn(`Worker ${options.agentId} could not fail a host note its ended attempt never took: ${failure}`);
	};
	const auto = new WatchAutoArm({
		port: () => watches.autoArm(worker),
		cwd: () => options.cwd,
		note: async (arming, callStartedAt) => note(arming, callStartedAt),
		failed: (error, callStartedAt) =>
			note(
				{
					informational: [],
					action: [
						`The host could not arm watches for what one of your calls started: ${error instanceof Error ? error.message : String(error)}. Wait on it yourself if your work needs its result.`,
					],
				},
				callStartedAt,
			),
		disposed: () => options.signal?.aborted === true,
	});
	const unfollow = options.toolSurface.onToolExecution({
		start: (toolCallId, toolName, args) => auto.noteStart(toolCallId, toolName, args),
		end: (toolCallId, result) => auto.noteFinished(toolCallId, result),
	});
	return {
		settle,
		release: () => {
			settle();
			unfollow();
		},
	};
}

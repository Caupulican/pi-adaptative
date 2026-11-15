/**
 * The admission of a watched command's or page's check as the call it would make, shared by every arming of a session's
 * watch (a routine watch, `routine-session-controller.ts`; a session watch, `core/watches/`). The watch's own rules admit the
 * condition first (its canonical form is returned), so the gate is never asked about a check the watch could not make; the
 * check is then the call its tool would make, admitted by the session's gate as a sub-call of the call that arms it: every
 * check a call of that tool faces applies, the System One operation gate included, and a refused call arms nothing. The
 * admitted call never starts, since the monitor makes the checks: the caller consumes it once the watch is saved (an owner
 * approval it claimed is spent arming the watch) and abandons it when the save fails. A session that does not hold the
 * check's tool arms nothing, so arming never widens what the session can run.
 */
import { isDeepStrictEqual } from "node:util";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { NestedCallAdmission, NestedCallAdmitter } from "../tools/nested-tool-call.ts";
import type { WatchCondition } from "./watch-contract.ts";
import { type WorkerWatchAuthority, watchCheckCall, watchCheckRefusal } from "./worker-watch-scope.ts";

/** What a watch's check admission reads: the watch's own rules, the session's gate and the session's tool surface. */
export interface WatchCheckAdmitter {
	/** The watch's own rules (`watch-admission.ts`): the condition in canonical form, or the reason it may not be watched. */
	admitWatch(condition: WatchCondition, worker?: WorkerWatchAuthority): WatchCondition;
	/** The session gate's admission of a sub-call of the tool call being executed. */
	admitSubCall: NestedCallAdmitter;
	/** Whether the session's own tool surface holds a tool: a watch checks only with a tool its session could call. */
	holdsTool(toolName: string): boolean;
}

/** One arming's check: the tool call that arms it, the watch it is for, and the condition already armed (an update keeps it unasked). */
export interface WatchCheckRequest {
	readonly toolCallId: string;
	readonly parentToolName: string;
	readonly watchId: string;
	readonly condition: WatchCondition;
	readonly worker?: WorkerWatchAuthority;
	readonly armed?: WatchCondition;
}

/** The admitted condition and, for a command or page, the admitted check call the caller consumes or abandons. */
export interface AdmittedWatchCheck {
	readonly condition: WatchCondition;
	readonly check: NestedCallAdmission | undefined;
}

export async function admitWatchCheck(
	admitter: WatchCheckAdmitter,
	request: WatchCheckRequest,
	signal?: AbortSignal,
): Promise<AdmittedWatchCheck> {
	const condition = admitter.admitWatch(request.condition, request.worker);
	const call = watchCheckCall(condition);
	if (!call || (request.armed && isDeepStrictEqual(request.armed, condition))) return { condition, check: undefined };
	if (!admitter.holdsTool(call.toolName)) {
		harnessLog.warn("routines", "a watch was refused: the session does not hold its check's tool", () => ({
			tool: call.toolName,
		}));
		throw new Error(
			`This watch's check runs ${call.toolName}, a tool this session does not hold, so it is not armed.`,
		);
	}
	const admission = await admitter.admitSubCall(
		request.toolCallId,
		{
			id: `${request.toolCallId}#watch`,
			toolName: call.toolName,
			args: { ...call.args },
			purpose: { kind: "watch_check", watchId: request.watchId, parentToolName: request.parentToolName },
		},
		signal,
	);
	if (admission.kind === "refused") {
		harnessLog.warn("routines", "a watch was refused: the session's gate refused its check's call", () => ({
			tool: call.toolName,
		}));
		throw watchCheckRefusal(request.watchId, admission);
	}
	return { condition, check: admission };
}

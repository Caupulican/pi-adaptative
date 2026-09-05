import { spawn } from "node:child_process";
import { buildPiResumeLaunchSpec } from "../orchestration/agent-resume.ts";
import type { ResumablePayload } from "./codes.ts";

export interface PiSelfLaunchTarget {
	executable: string;
	argsPrefix: readonly string[];
}

export type ResumablePiAgentLaunchOutcome =
	| {
			started: true;
			pid: number;
			completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	  }
	| { started: false; reason: string };

export function buildResumablePiAgentWakePrompt(payload: ResumablePayload): string {
	const context = payload.agent.resumeContext;
	const taskSummary = payload.taskSummary?.trim().slice(0, 2_000);
	const contextPointers = context.contextPointers
		.slice(0, 20)
		.map(
			(pointer) =>
				`- ${JSON.stringify({ id: pointer.id, kind: pointer.kind, uri: pointer.uri, readOnly: pointer.readOnly }).slice(0, 1_000)}`,
		);
	return [
		"Resume interrupted delegated task; same logical agent/session.",
		...(taskSummary ? [`Task: ${taskSummary}`] : []),
		...(context.latestCheckpointId ? [`Latest checkpoint: ${context.latestCheckpointId}`] : []),
		...(contextPointers.length > 0 ? ["Context pointers:", ...contextPointers] : []),
		"Continue persisted transcript/checkpoints/artifacts; finish with persisted terminal result.",
	].join("\n");
}

/** Launches one exact persisted Pi session; completion is observed only through process events. */
export async function launchResumablePiAgent(options: {
	payload: ResumablePayload;
	target: PiSelfLaunchTarget;
	parentPid: number;
	parentSessionId: string;
	environment: NodeJS.ProcessEnv;
}): Promise<ResumablePiAgentLaunchOutcome> {
	const context = options.payload.agent.resumeContext;
	if (context?.provider !== "pi") {
		return { started: false, reason: "Pi resume context is unavailable." };
	}
	const spec = buildPiResumeLaunchSpec(options.payload.agent, {
		executable: options.target.executable,
		argsPrefix: options.target.argsPrefix,
		parentPid: options.parentPid,
		parentSessionId: options.parentSessionId,
		taskRef: options.payload.taskRef,
		wakePrompt: buildResumablePiAgentWakePrompt(options.payload),
	});
	if ([spec.executable, spec.cwd, ...spec.args].some((value) => value.includes("\0"))) {
		return { started: false, reason: "Resume launch data contains a null byte." };
	}
	try {
		const child = spawn(spec.executable, spec.args, {
			cwd: spec.cwd,
			detached: true,
			stdio: "ignore",
			env: { ...options.environment, ...spec.env },
		});
		return await new Promise<ResumablePiAgentLaunchOutcome>((resolve) => {
			child.once("error", (error) => resolve({ started: false, reason: error.message }));
			child.once("spawn", () => {
				const childPid = child.pid;
				if (childPid === undefined || !Number.isSafeInteger(childPid) || childPid <= 0) {
					resolve({ started: false, reason: "Resume process started without a valid pid." });
					return;
				}
				const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
					(resolveCompletion, rejectCompletion) => {
						child.once("exit", (code, signal) => resolveCompletion({ code, signal }));
						child.once("error", rejectCompletion);
					},
				);
				child.unref();
				resolve({ started: true, pid: childPid, completion });
			});
		});
	} catch (error) {
		return { started: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

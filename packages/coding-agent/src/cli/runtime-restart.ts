import type { AgentSession } from "../core/agent-session.ts";
import type { AgentSessionRuntime, AgentSessionRuntimeResource } from "../core/agent-session-runtime.ts";
import { exitProcess, thrownDetail } from "../core/process-end-recorder.ts";
import { assertReloadQuiescent } from "../core/reload-blockers.ts";
import type { RuntimeRestartRequest } from "../core/runtime-update-controller.ts";
import { isWorkerSession } from "../core/session-role.ts";
import { describeCause, neutralizeControls } from "../core/terminal-warnings.ts";
import type { Args } from "./args.ts";
import { getRuntimeChildChannel } from "./runtime-channel.ts";

/** Preserve grants/options, but neither repeat prompts nor create/fork a session. */
export function applyRuntimeRestartArgs(parsed: Args, handoff: RuntimeRestartRequest): void {
	parsed.session = handoff.sessionFile;
	parsed.sessionId = undefined;
	parsed.fork = undefined;
	parsed.continue = false;
	parsed.resume = false;
	parsed.noSession = false;
	parsed.messages = [];
	parsed.fileArgs = [];
	parsed.name = undefined;
	parsed.model = undefined;
	parsed.provider = undefined;
	parsed.thinking = undefined;
}

interface RuntimeRestartAdapter {
	prepare(request: RuntimeRestartRequest, signal?: AbortSignal): Promise<void>;
	discard(id: string): Promise<void>;
	handoff(id: string): Promise<void>;
	assertQuiescent(): void;
	shutdown(): Promise<void>;
	/** Ends the process once the handoff reached the supervisor. */
	exitHandedOff(): never;
	/** Ends the process, status 1, recording why the teardown or handoff failed. */
	exitFailed(failure: unknown): never;
}

/** Teardown is fenced by the parent: even a partial failure resumes only after this process exits. */
export function createRuntimeRestartHandler(
	adapter: RuntimeRestartAdapter,
): (request: RuntimeRestartRequest, signal?: AbortSignal) => Promise<never> {
	return async (request, signal) => {
		signal?.throwIfAborted();
		adapter.assertQuiescent();
		try {
			await adapter.prepare(request, signal);
		} catch (error) {
			await adapter.discard(request.id).catch(() => {});
			throw error;
		}
		try {
			signal?.throwIfAborted();
			adapter.assertQuiescent();
		} catch (error) {
			await adapter.discard(request.id);
			throw error;
		}
		try {
			await adapter.shutdown();
			await adapter.handoff(request.id);
		} catch (error) {
			return adapter.exitFailed(error);
		}
		return adapter.exitHandedOff();
	};
}

/**
 * Ends a restart whose teardown or handoff failed: every failure is recorded with its stack (the supervisor sees only the status) and
 * reported on stderr after the host's stop.
 */
function exitRestartFailed(failures: readonly unknown[]): never {
	process.stderr.write(`${neutralizeControls(`Restart failed: ${failures.map(describeCause).join("; ")}`)}\n`);
	return exitProcess(1, "restart-failed", failures.map(thrownDetail).join("\n\n"));
}

/** SDK/RPC hosts do not gain process replacement authority from a tool call. */
export async function bindInteractiveRuntimeRestart(runtime: AgentSessionRuntime, stopHost: () => void): Promise<void> {
	const channel = getRuntimeChildChannel();
	if (!channel || isWorkerSession()) return;
	const resource: AgentSessionRuntimeResource = {
		async start(session: AgentSession) {
			session.runtimeUpdates.setSourceOrigin(channel.origin);
			session.runtimeUpdates.setRestartHandler(
				createRuntimeRestartHandler({
					prepare: (request, signal) => channel.request({ type: "prepare", request }, signal),
					discard: (id) => channel.send({ type: "discard", id }),
					handoff: (id) => channel.send({ type: "handoff", id }),
					assertQuiescent: () => {
						if (runtime.session !== session || runtime.isReplacing)
							throw new Error("Session replacement is in progress.");
						assertReloadQuiescent(
							runtime.services.agentDir,
							session.isStreaming,
							session.isCompacting,
							"restart",
						);
					},
					shutdown: async () => {
						stopHost();
						await runtime.dispose();
					},
					exitHandedOff: () => exitProcess(0, "restart"),
					exitFailed: (failure) => exitRestartFailed([failure]),
				}),
				{
					commit: (id) => channel.request({ type: "commit", id }),
					rollback: async () => {
						if (!channel.needsRollback()) return;
						// Both teardown steps run whatever the other did; the supervisor resumes the previous generation once this exits.
						const failures: unknown[] = [];
						for (const step of [stopHost, () => runtime.dispose()]) {
							try {
								await step();
							} catch (error) {
								failures.push(error);
							}
						}
						if (failures.length > 0) exitRestartFailed(failures);
						exitProcess(1, "restart-rollback");
					},
				},
			);
		},
		stop() {},
	};
	runtime.registerSessionResource(resource);
	await resource.start(runtime.session, runtime);
	await channel.send({ type: "ready" });
}

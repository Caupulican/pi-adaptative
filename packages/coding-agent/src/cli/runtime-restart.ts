import type { AgentSession } from "../core/agent-session.ts";
import type { AgentSessionRuntime, AgentSessionRuntimeResource } from "../core/agent-session-runtime.ts";
import { assertReloadQuiescent } from "../core/reload-blockers.ts";
import type { RuntimeRestartRequest } from "../core/runtime-update-controller.ts";
import { isWorkerSession } from "../core/session-role.ts";
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
	exit(code: number): never;
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
		} catch {
			return adapter.exit(1);
		}
		return adapter.exit(0);
	};
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
					exit: (code) => process.exit(code),
				}),
				{
					commit: (id) => channel.request({ type: "commit", id }),
					rollback: async () => {
						if (channel.needsRollback()) {
							try {
								stopHost();
								await runtime.dispose();
							} finally {
								process.exit(1);
							}
						}
					},
				},
			);
		},
		stop() {},
	};
	runtime.registerSessionResource(resource);
	await resource.start(runtime.session);
	await channel.send({ type: "ready" });
}

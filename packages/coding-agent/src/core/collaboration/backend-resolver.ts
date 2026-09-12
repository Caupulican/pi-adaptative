import { isAbsolute } from "node:path";
import { Value } from "typebox/value";
import { type CollaborationBackend, CollaborationBackendError } from "./backend.ts";
import type { CollaborationCommandRunner } from "./command-runner.ts";
import { HerdrBackend } from "./herdr-backend.ts";
import type { HerdrEventChannel } from "./herdr-channel.ts";
import { herdrHandle } from "./herdr-codec.ts";
import { createHerdrBackend, type HerdrServerTerminal, probeHerdrSocket } from "./herdr-runtime.ts";
import type { CollaborationJob } from "./job-store.ts";

export interface HerdrCallerContext {
	paneId: string;
	workspaceId: string;
	tabId: string;
	socketPath: string;
	binPath?: string;
}

export function detectHerdrCallerContext(env: NodeJS.ProcessEnv = process.env): HerdrCallerContext | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const paneId = env.HERDR_PANE_ID?.trim();
	const workspaceId = env.HERDR_WORKSPACE_ID?.trim();
	const tabId = env.HERDR_TAB_ID?.trim();
	const socketPath = env.HERDR_SOCKET_PATH?.trim();
	if (!paneId || !workspaceId || !tabId || !socketPath) return undefined;
	if (!Value.Check(herdrHandle, paneId) || !Value.Check(herdrHandle, workspaceId) || !Value.Check(herdrHandle, tabId))
		return undefined;
	if (!isAbsolute(socketPath) && !socketPath.startsWith("\\\\.\\pipe\\")) return undefined;
	if (socketPath.includes("\0")) return undefined;
	const binPathRaw = env.HERDR_BIN_PATH?.trim();
	const binPath =
		binPathRaw && (isAbsolute(binPathRaw) || binPathRaw.startsWith("\\\\")) && !binPathRaw.includes("\0")
			? binPathRaw
			: undefined;
	return { paneId, workspaceId, tabId, socketPath, binPath };
}

export interface BackendResolverOptions {
	ensureRunning?: boolean;
	configPath?: string;
	run?: CollaborationCommandRunner;
	connect?: (path: string, signal: AbortSignal) => Promise<HerdrEventChannel>;
	onTerminal?: (terminal: HerdrServerTerminal) => void;
}

/** One named resolver across root, helper, restart recovery and cleanup. */
export async function resolveCollaborationBackend(
	job: CollaborationJob,
	options: BackendResolverOptions = {},
): Promise<CollaborationBackend> {
	if (job.placement === "current-pane") {
		const socketPath = job.socketPath;
		if (!socketPath)
			throw new CollaborationBackendError(
				"missing_socket",
				"Saved collaboration job has no socket endpoint for shared placement.",
				"not-submitted",
			);
		if (!job.binPath)
			throw new CollaborationBackendError(
				"missing_bin_path",
				"Saved collaboration job has no executable path for shared placement.",
				"not-submitted",
			);
		const executable = job.binPath;
		const backend = new HerdrBackend({
			executable,
			session: "",
			socketPath,
			shared: true,
			run: options.run,
			connect: options.connect,
		});
		await probeHerdrSocket(socketPath, options.connect);
		return backend;
	}

	return createHerdrBackend({
		session: job.sessionName,
		ensureRunning: options.ensureRunning,
		configPath: options.configPath,
		onTerminal: options.onTerminal,
	});
}

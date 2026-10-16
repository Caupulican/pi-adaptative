import { isAbsolute } from "node:path";
import { Value } from "typebox/value";
import { type CollaborationBackend, CollaborationBackendError } from "./backend.ts";
import type { CollaborationCommandRunner } from "./command-runner.ts";
import { HerdrBackend } from "./herdr-backend.ts";
import { connectHerdrChannel, type HerdrEventChannel } from "./herdr-channel.ts";
import { herdrHandle } from "./herdr-codec.ts";
import { herdrPaneOwnership } from "./herdr-pane-ownership.ts";
import { createHerdrBackend, type HerdrServerTerminal, probeHerdrSocket } from "./herdr-runtime.ts";
import type { CollaborationJob } from "./job-record.ts";

export interface HerdrCallerContext {
	paneId: string;
	workspaceId: string;
	tabId: string;
	socketPath: string;
	binPath?: string;
}

/**
 * What the environment's Herdr claim resolves to. Only `owned` is a caller pane. `foreign` is a stale or inherited
 * id for a pane this process is not in and is never trusted. `unverifiable` is an observer failure: it degrades to
 * the non-Herdr placement, and the reason is reported to the owner.
 */
export type HerdrCallerDetection =
	| { status: "owned"; caller: HerdrCallerContext }
	| { status: "absent" }
	| { status: "foreign"; paneId: string }
	| { status: "unverifiable"; paneId: string; reason: string };

export async function detectHerdrCallerContext(
	env: NodeJS.ProcessEnv = process.env,
	connect: typeof connectHerdrChannel = connectHerdrChannel,
): Promise<HerdrCallerDetection> {
	const claim = herdrCallerClaim(env);
	if (!claim) return { status: "absent" };
	let channel: HerdrEventChannel;
	try {
		channel = await connect(claim.socketPath, AbortSignal.timeout(5000));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { status: "unverifiable", paneId: claim.paneId, reason: `Herdr socket unavailable (${reason})` };
	}
	try {
		const ownership = await herdrPaneOwnership(channel, claim.paneId);
		if (ownership.status === "owned") return { status: "owned", caller: claim };
		if (ownership.status === "foreign") return { status: "foreign", paneId: claim.paneId };
		return { status: "unverifiable", paneId: claim.paneId, reason: ownership.reason };
	} finally {
		channel.close();
	}
}

/** The environment's unverified claim about the caller pane. */
function herdrCallerClaim(env: NodeJS.ProcessEnv): HerdrCallerContext | undefined {
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

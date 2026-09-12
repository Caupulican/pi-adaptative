import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { killTree } from "@caupulican/pi-agent-core/process-tree";
import { getAgentDir } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { canonicalizeWatchDir } from "../../utils/fs-watch.ts";
import { getToolPath } from "../../utils/tools-manager.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { CollaborationBackendError } from "./backend.ts";
import { runCollaborationCommand } from "./command-runner.ts";
import { HerdrBackend } from "./herdr-backend.ts";
import { connectHerdrChannel, type HerdrEventChannel } from "./herdr-channel.ts";
import { ensureHerdrManagedConfiguration } from "./herdr-managed-config.ts";
import { isSupportedHerdrProtocol } from "./herdr-protocol.ts";
import { provisionHerdr } from "./herdr-provision.ts";

export interface HerdrServerTerminal {
	session: string;
	status: "exited" | "failed";
	code: number | null;
	timestamp: number;
}

export interface HerdrRuntimeOptions {
	session: string;
	ensureRunning?: boolean;
	configPath?: string;
	/** Reports daemon termination, not intermediate agent output. */
	onTerminal?: (terminal: HerdrServerTerminal) => void;
}

export type HerdrChannelConnector = (path: string, signal: AbortSignal) => Promise<HerdrEventChannel>;

export async function probeHerdrSocket(
	socketPath: string,
	connect: HerdrChannelConnector = connectHerdrChannel,
	timeoutMs = 5000,
): Promise<void> {
	const channel = await connect(socketPath, AbortSignal.timeout(timeoutMs));
	try {
		const reply = await channel.request("ping", {});
		if (!isSupportedHerdrProtocol(reply))
			throw new CollaborationBackendError(
				"unsupported_protocol",
				"The installed Herdr server does not expose the supported collaboration protocol.",
				"not-submitted",
			);
	} finally {
		channel.close();
	}
}

/** Root and finite worker helpers share this one explicit session/config resolver. */
export async function createHerdrBackend(options: HerdrRuntimeOptions): Promise<HerdrBackend> {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.session))
		throw new Error("An explicit named Herdr session is required.");
	const configPath = options.configPath ?? join(getAgentDir(), "collaboration", "herdr", "config.toml");
	if (!isAbsolute(configPath) || configPath.includes("\0"))
		throw new Error("Herdr configuration path must be absolute.");
	const ensureRunning = options.ensureRunning !== false;
	const executable = ensureRunning ? (await provisionHerdr()).path : getToolPath("herdr");
	if (!executable)
		throw new CollaborationBackendError(
			"not_installed",
			"Herdr is unavailable; an existing collaboration turn will not be relaunched.",
			"not-submitted",
		);
	await ensureHerdrManagedConfiguration(configPath, ensureRunning);
	const env = { ...process.env, HERDR_CONFIG_PATH: configPath };
	const status = await runCollaborationCommand(executable, ["--session", options.session, "status", "server"], {
		env,
		timeoutMs: 10000,
	});
	const socketPath = /^socket:\s*(.+)$/m.exec(status.stdout)?.[1]?.trim();
	if (
		status.reason !== "exited" ||
		status.code !== 0 ||
		!socketPath ||
		socketPath.includes("\0") ||
		(!isAbsolute(socketPath) && !socketPath.startsWith("\\\\.\\pipe\\"))
	)
		throw new CollaborationBackendError(
			"invalid_socket",
			"Herdr did not provide a valid named-session socket.",
			"not-submitted",
		);
	const backend = new HerdrBackend({ executable, session: options.session, configPath, socketPath });
	try {
		await probeHerdrSocket(socketPath);
		return backend;
	} catch (error) {
		if (error instanceof CollaborationBackendError && error.code === "unsupported_protocol") throw error;
		if (!ensureRunning) throw error;
	}

	// HERDR_CONFIG_PATH chooses the config file, not the runtime/socket directory.
	const sessionDir =
		process.platform === "win32"
			? join(process.env.APPDATA ?? dirname(configPath), "herdr", "sessions", options.session)
			: dirname(socketPath);
	await mkdir(sessionDir, { recursive: true, mode: 0o700 });
	const terminalPath = join(sessionDir, "pi-server-terminal.json");
	let probeActive = false;
	let probePending = false;
	let ready = false;
	let closed = false;
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	const readiness = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const failReadiness = (error: Error) => {
		if (closed || ready) return;
		closed = true;
		probePending = false;
		rejectReady?.(error);
	};
	const probe = () => {
		if (closed || ready) return;
		if (probeActive) {
			probePending = true;
			return;
		}
		probeActive = true;
		void probeHerdrSocket(socketPath)
			.then(
				() => {
					if (closed || ready) return;
					ready = true;
					resolveReady?.();
				},
				() => {},
			)
			.finally(() => {
				probeActive = false;
				if (closed || ready) {
					probePending = false;
					return;
				}
				if (probePending) {
					probePending = false;
					probe();
				}
			});
	};
	// Install before spawn; readiness is triggered by socket/session filesystem creation, not output polling.
	const watcher = watch(canonicalizeWatchDir(sessionDir), probe);
	watcher.on("error", (error) => failReadiness(error));
	const child = spawnProcess(executable, ["--session", options.session, "server"], {
		env,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	const terminal = waitForChildProcess(child);
	void terminal
		.then(
			async (code) => {
				failReadiness(new Error("Herdr server terminated before readiness."));
				const record: HerdrServerTerminal = {
					session: options.session,
					status: code === 0 ? "exited" : "failed",
					code,
					timestamp: Date.now(),
				};
				await writeFileAtomic(terminalPath, JSON.stringify(record), { mode: 0o600 });
				options.onTerminal?.(record);
			},
			(error) => failReadiness(error instanceof Error ? error : new Error("Herdr server failed to start.")),
		)
		.catch((error) => {
			process.stderr.write(
				`Collaboration server terminal handoff failed: ${error instanceof Error ? error.message.slice(0, 256) : "unknown failure"}\n`,
			);
		});
	const deadline = setTimeout(() => failReadiness(new Error("Herdr server readiness deadline exceeded.")), 30000);
	probe();
	try {
		await readiness;
		child.unref();
		return backend;
	} catch (error) {
		const cleanup = await killTree(child).catch(() => "failed" as const);
		if (cleanup === "failed")
			throw new Error(
				"Herdr startup failed and cleanup could not confirm process-tree termination; native work may still be running.",
				{ cause: error },
			);
		throw error;
	} finally {
		closed = true;
		probePending = false;
		clearTimeout(deadline);
		watcher.close();
	}
}

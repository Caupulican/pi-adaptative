/**
 * One observation of a watch condition, in code and with no model: what holds now (or the state a change-style
 * condition is in) plus the bounded fact record a firing would carry. An observation that cannot be made (a transport
 * error, a timeout, a file that is not there for a change watch) is `undefined`: it moves nothing, so a flaky network
 * or a busy disk never produces an edge.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { globIterate } from "glob";
import { runRequirementCheck } from "../goals/requirement-checks.ts";
import { entryPath, readEntry } from "../process-matrix/store.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";
import { boundedText } from "../util/bounded-line.ts";
import { PublicWebClient, PublicWebHttpError, PublicWebRedirectError } from "../web/public-web-client.ts";
import type { RoutineWatchObservation } from "./routine-contract.ts";
import { processIsRunning, type WatchAdmission, watchCommandEnvironment } from "./watch-admission.ts";
import {
	isWatchGlob,
	MAX_WATCH_EXCERPT_CHARS,
	MAX_WATCH_LABEL_CHARS,
	WATCH_DEFAULT_COMMAND_TIMEOUT_MS,
	type WatchCondition,
	type WatchFiredEvent,
	watchShortName,
} from "./watch-contract.ts";

export interface WatchSample {
	readonly observation: RoutineWatchObservation;
	readonly event: WatchFiredEvent;
}

/** Longest a file is hashed in full; a larger one is judged by its size and modification time. */
const MAX_HASHED_FILE_BYTES = 16 * 1024 * 1024;
/** Most entries one check of a folder or a glob pattern lists; a larger set is no observation. */
const MAX_WATCHED_ENTRIES = 10_000;
const PORT_CONNECT_TIMEOUT_MS = 5_000;
const HTTP_TIMEOUT_SECONDS = 20;
const MAX_HTTP_BODY_BYTES = 256 * 1024;
const HTTP_ACCEPT = "text/plain,application/json;q=0.9,text/html;q=0.8,application/xml;q=0.7";
/** Characters kept each side of a matched text in a page excerpt. */
const EXCERPT_CONTEXT_CHARS = 100;

/** One entry of a watched folder or pattern: its path, size, modification time and whether it is a folder. */
type WatchedEntry = readonly [path: string, size: number, modifiedMs: number, folder: boolean];

/** What a watched path is now: whether it exists, a file's size, a folder's or pattern's entry count, and the digest of its state. */
interface PathSnapshot {
	readonly exists: boolean;
	readonly size?: number;
	readonly entries?: number;
	readonly state?: string;
}

export interface WatchSamplerDeps {
	readonly admission: Pick<WatchAdmission, "authorize" | "cwd" | "readsContent">;
	readonly agentDir: () => string;
	readonly now: () => number;
	readonly web?: PublicWebClient;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The bounded, redacted words a watched thing wrote, flattened so a fence line cannot be forged from them. */
function excerptOf(text: string): string | undefined {
	const flat = redactKnownSecrets(text)
		.replace(/[\p{Cc}\s]+/gu, " ")
		.trim();
	return flat.length === 0 ? undefined : boundedText(flat, MAX_WATCH_EXCERPT_CHARS);
}

export class WatchSampler {
	private readonly deps: WatchSamplerDeps;
	private readonly web: PublicWebClient;

	constructor(deps: WatchSamplerDeps) {
		this.deps = deps;
		this.web = deps.web ?? new PublicWebClient();
	}

	/** Re-authorizes the condition against the session's authority now (a refusal throws) and observes it once. */
	async sample(condition: WatchCondition, signal: AbortSignal): Promise<WatchSample | undefined> {
		const admitted = this.deps.admission.authorize(condition);
		switch (admitted.type) {
			case "file":
				return this.file(admitted, signal);
			case "process":
				return this.process(admitted);
			case "pid":
				return this.pid(admitted);
			case "port":
				return this.port(admitted, signal);
			case "command":
				return this.command(admitted, signal);
			case "http":
				return this.http(admitted, signal);
		}
	}

	private event(
		condition: WatchCondition["type"],
		change: WatchFiredEvent["change"],
		label: string,
		facts: WatchFiredEvent["facts"],
		excerpt?: string,
	): WatchFiredEvent {
		return {
			version: 1,
			kind: "watch-fired",
			condition,
			change,
			label: boundedText(label.replace(/[\p{Cc}\s]+/gu, " ").trim(), MAX_WATCH_LABEL_CHARS),
			observedAt: new Date(this.deps.now()).toISOString(),
			facts,
			...(excerpt === undefined ? {} : { excerpt }),
		};
	}

	private async file(
		condition: Extract<WatchCondition, { type: "file" }>,
		signal: AbortSignal,
	): Promise<WatchSample | undefined> {
		const label = watchShortName(condition.path);
		const changed = condition.on === "changed";
		const seen = await this.snapshot(condition.path, changed, signal);
		if (seen === undefined) return undefined;
		const facts = {
			...(seen.size === undefined ? {} : { sizeBytes: seen.size }),
			...(seen.entries === undefined ? {} : { entries: seen.entries }),
		};
		if (!changed) {
			const holds = condition.on === "created" ? seen.exists : !seen.exists;
			return { observation: { truth: holds }, event: this.event("file", condition.on, label, facts) };
		}
		// A change is a different content (a folder or pattern: a different set of entries, sizes and times): a path that is
		// not there is no observation, and one that comes back unchanged is the state it was decided at.
		if (seen.state === undefined) return undefined;
		return { observation: { truth: true, state: seen.state }, event: this.event("file", "changed", label, facts) };
	}

	/**
	 * What one path (a file, a folder or a glob pattern) is now. Existence, size and times are metadata, observed for any
	 * path the process can stat; a file's content is digested only where the session may read it, so elsewhere its size
	 * and modification time stand for it. An observation that cannot be made is undefined.
	 */
	private async snapshot(path: string, wantState: boolean, signal: AbortSignal): Promise<PathSnapshot | undefined> {
		if (isWatchGlob(path)) {
			const matches = await this.listMatches(path, signal);
			return matches === undefined
				? undefined
				: {
						exists: matches.length > 0,
						entries: matches.length,
						state: wantState ? digest(["pattern", matches]) : undefined,
					};
		}
		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(path);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? { exists: false } : undefined;
		}
		if (stats.isDirectory()) {
			if (!wantState) return { exists: true };
			const listed = await this.listFolder(path, signal);
			return listed === undefined
				? undefined
				: { exists: true, entries: listed.length, state: digest(["folder", listed]) };
		}
		if (!stats.isFile()) return undefined;
		if (!wantState) return { exists: true, size: stats.size };
		const hashable = stats.size <= MAX_HASHED_FILE_BYTES && this.deps.admission.readsContent(path);
		const content = hashable ? await this.contentDigest(path, signal) : undefined;
		if (hashable && content === undefined) return undefined;
		return {
			exists: true,
			size: stats.size,
			state: digest(["file", stats.size, content ?? Math.floor(stats.mtimeMs)]),
		};
	}

	/** The direct entries of a folder as name, size, modification time and kind; undefined when it cannot be listed in bound. */
	private async listFolder(path: string, signal: AbortSignal): Promise<WatchedEntry[] | undefined> {
		try {
			const names = await readdir(path);
			if (names.length > MAX_WATCHED_ENTRIES) return undefined;
			return await this.describeEntries(
				names.map((name) => join(path, name)),
				signal,
			);
		} catch {
			return undefined;
		}
	}

	/** Every path a glob pattern matches now, as {@link listFolder} describes entries; undefined when it cannot be listed in bound. */
	private async listMatches(pattern: string, signal: AbortSignal): Promise<WatchedEntry[] | undefined> {
		try {
			const paths: string[] = [];
			for await (const match of globIterate(pattern, {
				absolute: true,
				dot: true,
				signal,
				windowsPathsNoEscape: process.platform === "win32",
			})) {
				if (paths.length === MAX_WATCHED_ENTRIES) return undefined;
				paths.push(String(match));
			}
			return await this.describeEntries(paths, signal);
		} catch {
			return undefined;
		}
	}

	/** An entry that vanished between listing and stat is simply not there; every other failure is no observation. */
	private async describeEntries(paths: readonly string[], signal: AbortSignal): Promise<WatchedEntry[]> {
		const entries: WatchedEntry[] = [];
		for (const path of paths) {
			signal.throwIfAborted();
			try {
				const stats = await lstat(path);
				entries.push([path, stats.size, Math.floor(stats.mtimeMs), stats.isDirectory()]);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
	}

	private async contentDigest(path: string, signal: AbortSignal): Promise<string | undefined> {
		try {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
			return hash.digest("hex");
		} catch {
			return undefined;
		}
	}

	private async process(condition: Extract<WatchCondition, { type: "process" }>): Promise<WatchSample | undefined> {
		const agentDir = this.deps.agentDir();
		let entry: Awaited<ReturnType<typeof readEntry>>;
		try {
			entry = await readEntry(agentDir, condition.processId);
		} catch {
			return undefined;
		}
		if (entry === undefined) {
			// An entry that does not read is gone only when its file is absent; an unreadable one is no observation.
			try {
				await access(entryPath(agentDir, condition.processId));
				return undefined;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			}
		}
		// A recorded terminal state, a closed entry or a removed entry all say the process is no longer running.
		const exited = entry === undefined || entry.terminal !== undefined || entry.status === "closed";
		const terminal = entry?.terminal;
		return {
			observation: { truth: exited },
			event: this.event("process", "exited", "", {
				...(terminal?.code != null ? { exitCode: terminal.code } : {}),
				...(terminal?.signal != null ? { signal: terminal.signal } : {}),
			}),
		};
	}

	/** An operating-system process has no exit event to follow: its liveness is probed on the cadence. */
	private pid(condition: Extract<WatchCondition, { type: "pid" }>): WatchSample {
		return {
			observation: { truth: !processIsRunning(condition.pid) },
			event: this.event("pid", "exited", `process ${condition.pid}`, { pid: condition.pid }),
		};
	}

	private port(
		condition: Extract<WatchCondition, { type: "port" }>,
		signal: AbortSignal,
	): Promise<WatchSample | undefined> {
		return new Promise((resolve) => {
			const socket = createConnection({ host: condition.host, port: condition.port });
			const settle = (open: boolean | undefined): void => {
				signal.removeEventListener("abort", onAbort);
				socket.destroy();
				resolve(
					open === undefined
						? undefined
						: {
								observation: { truth: condition.on === "open" ? open : !open },
								event: this.event("port", condition.on, `port ${condition.port}`, {
									port: condition.port,
									open,
								}),
							},
				);
			};
			const onAbort = () => settle(undefined);
			signal.addEventListener("abort", onAbort, { once: true });
			socket.setTimeout(PORT_CONNECT_TIMEOUT_MS, () => settle(undefined));
			socket.once("connect", () => settle(true));
			// Only a refusal says nothing listens; every other error says nothing about the port.
			socket.once("error", (error: NodeJS.ErrnoException) =>
				settle(error.code === "ECONNREFUSED" ? false : undefined),
			);
		});
	}

	private async command(
		condition: Extract<WatchCondition, { type: "command" }>,
		signal: AbortSignal,
	): Promise<WatchSample | undefined> {
		const result = await runRequirementCheck(
			{
				command: condition.command,
				...(condition.expect.exitCode === undefined ? {} : { expectExitCode: condition.expect.exitCode }),
				...(condition.expect.outputContains === undefined
					? {}
					: { outputContains: condition.expect.outputContains }),
			},
			{
				cwd: this.deps.admission.cwd(),
				timeoutMs: condition.timeoutMs ?? WATCH_DEFAULT_COMMAND_TIMEOUT_MS,
				signal,
				// The command was admitted by `sample` immediately before this run; the requirement line is not applied.
				admit: () => undefined,
				env: watchCommandEnvironment(),
			},
		);
		// A command that did not run to an exit (a timeout, a spawn failure, an abort) says nothing about the condition.
		if (result.exitCode === null) return undefined;
		return {
			observation: { truth: result.passed },
			event: this.event("command", "matched", "", { exitCode: result.exitCode }, excerptOf(result.output)),
		};
	}

	private async http(
		condition: Extract<WatchCondition, { type: "http" }>,
		signal: AbortSignal,
	): Promise<WatchSample | undefined> {
		const label = new URL(condition.url).hostname;
		const statusHolds = (status: number): boolean =>
			condition.statusIs === undefined ? status >= 200 && status < 300 : condition.statusIs.includes(status);
		let status: number;
		let redirectHost: string | undefined;
		let text = "";
		try {
			const page = await this.web.get(condition.url, HTTP_ACCEPT, HTTP_TIMEOUT_SECONDS, signal, {
				maxBytes: MAX_HTTP_BODY_BYTES,
				policy: { reach: "ownedServices" },
			});
			status = page.status;
			text = page.text;
		} catch (error) {
			// A completed exchange with another status is a known status without a body; anything else is unknown.
			if (!(error instanceof PublicWebHttpError)) return undefined;
			status = error.status;
			// A redirect to another scheme, host or port is not followed: it is reported by the host it points at.
			if (error instanceof PublicWebRedirectError) redirectHost = error.target.host;
		}
		const at = condition.bodyContains === undefined ? -1 : text.indexOf(condition.bodyContains);
		const bodyHolds = condition.bodyContains === undefined || at >= 0;
		const excerpt =
			at >= 0 && condition.bodyContains !== undefined
				? excerptOf(
						text.slice(
							Math.max(0, at - EXCERPT_CONTEXT_CHARS),
							at + condition.bodyContains.length + EXCERPT_CONTEXT_CHARS,
						),
					)
				: undefined;
		return {
			observation: { truth: statusHolds(status) && bodyHolds },
			event: this.event(
				"http",
				"matched",
				label,
				redirectHost === undefined ? { status } : { status, redirectHost },
				excerpt,
			),
		};
	}
}

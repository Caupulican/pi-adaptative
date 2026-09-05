import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { readBoundedTextFile } from "../../core/util/bounded-file.ts";

interface WorkspaceSnapshot {
	files: Map<string, string>;
	limited: boolean;
}
interface ObservationPort {
	snapshot(cwd: string, signal: AbortSignal): Promise<WorkspaceSnapshot>;
	patch(cwd: string, paths: string[], signal: AbortSignal): Promise<string>;
}
export interface WorkspaceObservationResult {
	paths: string[];
	patch: string;
	note?: string;
}

interface ObservationScope {
	cwd: string;
	abort: AbortController;
	baseline?: WorkspaceSnapshot;
	error?: string;
	ready: Promise<void>;
	queue: Promise<void>;
	overlapped: boolean;
}

// Unlike the tool's git executor, UI observations never spill output or wait for long operations.
function query(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
	return new Promise((resolveResult, reject) => {
		execFile(
			"git",
			["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotepath=false", ...args],
			{
				cwd,
				signal,
				timeout: 2000,
				maxBuffer: 256 * 1024,
				encoding: "utf8",
				windowsHide: true,
			},
			(error, stdout) => (error ? reject(error) : resolveResult(stdout)),
		);
	});
}

const gitObservation: ObservationPort = {
	async snapshot(cwd, signal) {
		// Porcelain paths are root-relative even when the agent operates in a nested directory.
		const [status, prefixOutput] = await Promise.all([
			query(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", "."], signal),
			query(cwd, ["rev-parse", "--show-prefix"], signal),
		]);
		const prefix = prefixOutput.replace(/\r?\n$/, "");
		const records = status.split("\0");
		const files = new Map<string, string>();
		let limited = false;
		for (let i = 0; i < records.length; i++) {
			const record = records[i]!;
			if (!record) continue;
			const state = record.slice(0, 2);
			const rootPath = record.slice(3);
			if (!rootPath.startsWith(prefix)) continue;
			const path = rootPath.slice(prefix.length);
			if (state.includes("R") || state.includes("C")) i++; // NUL rename source follows destination.
			if (files.size >= 128) {
				limited = true;
				break;
			}
			const absolute = resolve(cwd, path);
			const local = relative(cwd, absolute);
			if (isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) continue;
			if (signal.aborted) throw new Error("Observation cancelled");
			let fingerprint = state;
			try {
				const info = await lstat(absolute);
				fingerprint += `:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
				// Reuse the stable bounded-read owner. Large files use metadata, never an unbounded read.
				if (info.isFile() && info.size <= 64 * 1024) {
					const content = await readBoundedTextFile(absolute, 64 * 1024, "Workspace preview");
					fingerprint += createHash("sha256").update(content).digest("hex");
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				fingerprint += ":absent";
			}
			files.set(path, fingerprint);
		}
		return { files, limited };
	},
	patch: (cwd, paths, signal) =>
		query(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=2", "--", ...paths], signal),
};

/** One observation per explicit tool boundary, with cancellation and session-generation fencing. No watcher/poll. */
export class WorkspaceObservation {
	private readonly port: ObservationPort;
	private scope?: ObservationScope;

	constructor(port: ObservationPort = gitObservation) {
		this.port = port;
	}

	begin(cwd: string): Promise<void> {
		this.dispose();
		const scope: ObservationScope = {
			cwd,
			abort: new AbortController(),
			ready: Promise.resolve(),
			queue: Promise.resolve(),
			overlapped: false,
		};
		this.scope = scope;
		scope.ready = this.port.snapshot(cwd, scope.abort.signal).then(
			(snapshot) => {
				scope.baseline = snapshot;
			},
			() => {
				scope.error =
					"Workspace observation unavailable or over budget; edit/write evidence remains visible. Requires a Git worktree.";
			},
		);
		return scope.ready;
	}

	noteExecution(): void {
		if (this.scope && !this.scope.baseline && !this.scope.error) this.scope.overlapped = true;
	}

	observe(): Promise<WorkspaceObservationResult | undefined> {
		const scope = this.scope;
		if (!scope) return Promise.resolve(undefined);
		const result = scope.queue.then(() => this.observeReady(scope));
		scope.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async observeReady(scope: ObservationScope): Promise<WorkspaceObservationResult | undefined> {
		await scope.ready;
		if (this.scope !== scope || scope.abort.signal.aborted) return undefined;
		if (scope.error) return { paths: [], patch: "", note: scope.error };
		try {
			const snapshot = await this.port.snapshot(scope.cwd, scope.abort.signal);
			if (this.scope !== scope) return undefined;
			const previous = scope.overlapped ? undefined : scope.baseline;
			const paths = [...snapshot.files]
				.filter(([path, fingerprint]) => previous?.files.get(path) !== fingerprint)
				.map(([path]) => path);
			if (!snapshot.limited)
				for (const path of previous?.files.keys() ?? []) if (!snapshot.files.has(path)) paths.push(path);
			let patch = "";
			let note = snapshot.limited
				? "Observation limited to 128 dirty paths"
				: scope.overlapped
					? "Initial snapshot overlapped execution; displayed workspace changes may predate this task"
					: undefined;
			if (paths.length) {
				try {
					patch = await this.port.patch(scope.cwd, paths.slice(0, 32), scope.abort.signal);
				} catch {
					note = "Changes observed; diff unavailable or exceeds preview budget";
				}
			}
			if (this.scope !== scope) return undefined;
			scope.baseline = snapshot;
			scope.overlapped = false;
			return { paths, patch, note };
		} catch {
			return this.scope === scope && !scope.abort.signal.aborted
				? { paths: [], patch: "", note: "Workspace observation failed; no claim of a clean workspace" }
				: undefined;
		}
	}

	dispose(): void {
		this.scope?.abort.abort();
		this.scope = undefined;
	}
}

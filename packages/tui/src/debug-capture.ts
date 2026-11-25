/** Buffers opt-in terminal diagnostics and stops each capture at its file byte budget. */
import { constants, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BUFFER_BYTES = 128 * 1024;
const BUFFER_ENTRIES = 256;
const FLUSH_MS = 100;
const TERMINAL_CAPTURE_BYTES = 8 * 1024 * 1024;
const TERMINAL_CAPTURE = /^tui-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d+\.log$/;
const TERMINAL_CAPTURE_AGE_MS = 7 * 86_400_000;
const TERMINAL_CAPTURE_COUNT = 4;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const OPEN_CAPTURE = constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | NO_FOLLOW;
type CapturePreparation = (path: string) => Promise<{ path: string; created?: true } | undefined>;

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function withCaptureLock(path: string, work: () => Promise<void>): Promise<void> {
	const { default: lockfile } = await import("proper-lockfile");
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(path, { realpath: false, retries: 0, onCompromised: () => undefined });
	} catch (error) {
		if (errorCode(error) === "ELOCKED") return;
		throw error;
	}
	try {
		await work();
	} finally {
		await release();
	}
}

export class DebugCapture {
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private writing = false;
	private scheduled = false;
	private started = false;
	private stopped = false;
	private resolvedPath: string | undefined;
	private readonly path: string;
	private readonly maxBytes: number;
	private readonly prepare: CapturePreparation | undefined;

	constructor(path: string, maxBytes: number, prepare?: CapturePreparation) {
		this.path = path;
		this.maxBytes = maxBytes;
		this.prepare = prepare;
	}

	get acceptsEntry(): boolean {
		return !this.stopped && this.pending.length < BUFFER_ENTRIES && this.pendingBytes < BUFFER_BYTES;
	}

	write(text: string): void {
		if (!this.acceptsEntry || text.length === 0 || text.length > BUFFER_BYTES - this.pendingBytes) return;
		const bytes = Buffer.byteLength(text);
		if (bytes > BUFFER_BYTES - this.pendingBytes) return;
		this.pending.push(Buffer.from(text));
		this.pendingBytes += bytes;
		this.schedule();
	}

	private schedule(): void {
		if (this.stopped || this.writing || this.scheduled || this.pendingBytes === 0) return;
		this.scheduled = true;
		setTimeout(() => void this.flush(), FLUSH_MS);
	}

	private async flush(): Promise<void> {
		this.scheduled = false;
		this.writing = true;
		const pending = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		try {
			if (!this.resolvedPath && this.prepare) {
				const prepared = await this.prepare(this.path);
				if (!prepared) return;
				this.resolvedPath = prepared.path;
				this.started = prepared.created === true;
			}
			const path = this.resolvedPath ?? this.path;
			await withCaptureLock(path, () => this.append(path, pending));
		} catch {
			this.stopped = true;
		} finally {
			this.writing = false;
			if (this.stopped) {
				this.pending = [];
				this.pendingBytes = 0;
			}
			this.schedule();
		}
	}

	private async append(path: string, pending: Buffer[]): Promise<void> {
		const file = await fs.open(path, this.started ? OPEN_CAPTURE : OPEN_CAPTURE | constants.O_CREAT, 0o600);
		try {
			this.started = true;
			const stats = await file.stat();
			if (!stats.isFile()) throw new Error("Diagnostic capture requires a regular file");
			let bytes = 0;
			let count = 0;
			for (const chunk of pending) {
				if (stats.size + bytes + chunk.length > this.maxBytes) {
					this.stopped = true;
					break;
				}
				bytes += chunk.length;
				count++;
			}
			if (count === 0) return;
			const batch = count === 1 ? pending[0]! : Buffer.concat(pending.slice(0, count), bytes);
			await file.writeFile(batch);
		} finally {
			await file.close();
		}
	}
}

function createRenderCapture(file: string, maxBytes: number): DebugCapture {
	return new DebugCapture(file, maxBytes, async (path) => {
		await fs.mkdir(dirname(path), { recursive: true });
		return { path };
	});
}

export function createRedrawCapture(): DebugCapture | undefined {
	if (process.env.PI_DEBUG_REDRAW !== "1") return undefined;
	const directory = process.env.PI_TUI_WORK_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return createRenderCapture(join(directory, "pi-debug.log"), 1024 * 1024);
}

export function createFrameCapture(): DebugCapture | undefined {
	if (process.env.PI_TUI_DEBUG !== "1") return undefined;
	const directory = process.env.PI_TUI_WORK_DIR ?? join(tmpdir(), "pi", "work", "debug", "tui");
	return createRenderCapture(join(directory, "render.log"), 4 * 1024 * 1024);
}

export function frameRowSample(rows: readonly string[]): string[] {
	return rows.slice(-24).map((row) => row.slice(0, 256));
}

/** Directory mode retains recent uniquely named terminal captures and leaves other files alone. */
export function createTerminalCapture(target: string): DebugCapture {
	const name = `tui-${new Date().toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "-")}-${process.pid}.log`;
	return new DebugCapture(target, TERMINAL_CAPTURE_BYTES, async (path) => {
		const stat = await fs.stat(path).catch((error: unknown) => {
			if (errorCode(error) !== "ENOENT") throw error;
			return undefined;
		});
		if (!stat?.isDirectory()) return { path };
		const filePath = join(path, name);
		let prepared: { path: string; created: true } | undefined;
		await withCaptureLock(join(path, ".tui-captures"), async () => {
			const file = await fs.open(filePath, OPEN_CAPTURE | constants.O_CREAT, 0o600);
			await file.close();
			await pruneTerminalCaptures(path);
			prepared = { path: filePath, created: true };
		});
		return prepared;
	});
}

async function pruneTerminalCaptures(directory: string): Promise<void> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const cutoff = Date.now() - TERMINAL_CAPTURE_AGE_MS;
	let remaining = TERMINAL_CAPTURE_COUNT;
	for (const { name } of entries.filter((entry) => entry.isFile()).sort((a, b) => b.name.localeCompare(a.name))) {
		if (!TERMINAL_CAPTURE.test(name)) continue;
		const file = join(directory, name);
		try {
			const stats = await fs.lstat(file);
			if (!stats.isFile()) continue;
			if (stats.mtimeMs >= cutoff && stats.size <= TERMINAL_CAPTURE_BYTES && remaining > 0) remaining--;
			else await fs.unlink(file);
		} catch {
			// Another capture may have already pruned the file.
		}
	}
}

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Local model runtime manager (local-model-lifecycle-design.md): Ollama first, interface kept
 * runtime-agnostic. Pi SPAWNS the serve process itself with OWNED model storage
 * (`OLLAMA_MODELS=<agentDir>/models/ollama`) so every downloaded weight lives inside pi's tree —
 * per-model disk accounting is trivial and full cleanup is one directory. If a system server is
 * already running, pi uses it instead of double-installing, with the honest tradeoff surfaced:
 * storage then lives in the system daemon's dir and removal control is limited to `ollama rm`.
 *
 * Hard boundaries (design "Hard boundaries"): lifecycle actions are USER commands only — this
 * module is never exposed as a model-invokable tool; install is GUIDE MODE (exact manual steps,
 * never `curl | sh`); removal is explicit, disclosed, and never automatic.
 */

export interface LocalRuntimeStatus {
	binaryPath?: string;
	binarySource?: "system" | "user" | "pi-owned";
	serverUp: boolean;
	serverUrl: string;
	/** True when the responding server is a child process pi spawned (owned storage applies). */
	managedByPi: boolean;
	/** Owned weights directory (only meaningful for pi-managed serves). */
	ownedModelsDir: string;
}

export interface InstalledLocalModel {
	name: string;
	sizeBytes: number;
}

export interface LocalRuntimeDeps {
	fetchFn?: typeof fetch;
	spawnFn?: (
		command: string,
		args: string[],
		options: { env: NodeJS.ProcessEnv },
	) => Pick<ChildProcess, "pid" | "kill" | "unref" | "on">;
	existsFn?: (path: string) => boolean;
	envPath?: string;
	homeDir?: string;
	sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const HEALTH_TIMEOUT_MS = 2_000;
const START_POLL_ATTEMPTS = 20;
const START_POLL_INTERVAL_MS = 500;

export class OllamaRuntime {
	private readonly _agentDir: string;
	private readonly _baseUrl: string;
	private readonly _fetch: typeof fetch;
	private readonly _spawn: NonNullable<LocalRuntimeDeps["spawnFn"]>;
	private readonly _exists: (path: string) => boolean;
	private readonly _envPath: string;
	private readonly _homeDir: string;
	private readonly _sleep: (ms: number) => Promise<void>;
	private _child: Pick<ChildProcess, "pid" | "kill" | "unref" | "on"> | undefined;

	constructor(args: { agentDir: string; baseUrl?: string; deps?: LocalRuntimeDeps }) {
		this._agentDir = args.agentDir;
		this._baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		this._fetch = args.deps?.fetchFn ?? fetch;
		this._spawn = args.deps?.spawnFn ?? ((command, argv, options) => spawn(command, argv, options));
		this._exists = args.deps?.existsFn ?? existsSync;
		this._envPath = args.deps?.envPath ?? process.env.PATH ?? "";
		this._homeDir = args.deps?.homeDir ?? homedir();
		this._sleep = args.deps?.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	get baseUrl(): string {
		return this._baseUrl;
	}

	ownedModelsDir(): string {
		return join(this._agentDir, "models", "ollama");
	}

	private _findBinary(): { path: string; source: "system" | "user" | "pi-owned" } | undefined {
		const piOwned = join(this._agentDir, "runtimes", "ollama", "bin", "ollama");
		if (this._exists(piOwned)) return { path: piOwned, source: "pi-owned" };
		const userLevel = join(this._homeDir, ".local", "share", "ollama-dist", "bin", "ollama");
		if (this._exists(userLevel)) return { path: userLevel, source: "user" };
		for (const dir of this._envPath.split(delimiter)) {
			if (!dir) continue;
			const candidate = join(dir, "ollama");
			if (this._exists(candidate)) return { path: candidate, source: "system" };
		}
		return undefined;
	}

	private async _serverUp(): Promise<boolean> {
		try {
			const response = await this._fetch(`${this._baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async detect(): Promise<LocalRuntimeStatus> {
		const binary = this._findBinary();
		const serverUp = await this._serverUp();
		return {
			binaryPath: binary?.path,
			binarySource: binary?.source,
			serverUp,
			serverUrl: this._baseUrl,
			managedByPi: this._child !== undefined && serverUp,
			ownedModelsDir: this.ownedModelsDir(),
		};
	}

	/** GUIDE MODE: exact manual steps, printed, never executed (no `curl | sh`, no sudo). */
	installGuide(): string[] {
		return [
			"Ollama is not installed. Pi never runs installers itself — manual steps (user-level, no sudo):",
			"  1. Download the pinned release archive for your platform:",
			"     https://github.com/ollama/ollama/releases (asset: ollama-linux-amd64.tar.zst or your platform)",
			`  2. Extract it to ${join(this._homeDir, ".local", "share", "ollama-dist")}`,
			"  3. Re-run your /models command - pi detects the binary automatically.",
			"Alternatively install system-wide from https://ollama.com/download and pi will use the system server.",
		];
	}

	/**
	 * Start a pi-managed serve with OWNED storage and the hardened env verified on this class of
	 * hardware. No-op (reported) when a server already responds — pi never double-serves.
	 */
	async start(): Promise<{ started: boolean; reason: string }> {
		if (await this._serverUp()) {
			return { started: false, reason: this._child ? "already_running_managed" : "already_running_system" };
		}
		const binary = this._findBinary();
		if (!binary) return { started: false, reason: "binary_missing" };
		mkdirSync(this.ownedModelsDir(), { recursive: true });
		const host = this._baseUrl.replace(/^https?:\/\//, "");
		this._child = this._spawn(binary.path, ["serve"], {
			env: {
				...process.env,
				OLLAMA_HOST: host,
				OLLAMA_MODELS: this.ownedModelsDir(),
				OLLAMA_FLASH_ATTENTION: "1",
				OLLAMA_KV_CACHE_TYPE: "q8_0",
				OLLAMA_NUM_PARALLEL: "1",
				OLLAMA_MAX_LOADED_MODELS: "3",
			},
		});
		this._child.unref?.();
		for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt++) {
			if (await this._serverUp()) return { started: true, reason: "started" };
			await this._sleep(START_POLL_INTERVAL_MS);
		}
		this.stop();
		return { started: false, reason: "health_check_timeout" };
	}

	/** Resource hygiene only: stops the pi-managed serve process; never deletes anything. */
	stop(): { stopped: boolean } {
		if (!this._child) return { stopped: false };
		try {
			this._child.kill("SIGTERM");
		} catch {
			// already gone
		}
		this._child = undefined;
		return { stopped: true };
	}

	async list(): Promise<InstalledLocalModel[]> {
		const response = await this._fetch(`${this._baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`ollama list failed: HTTP ${response.status}`);
		const data = (await response.json()) as { models?: Array<{ name?: string; size?: number }> };
		return (data.models ?? [])
			.filter((model): model is { name: string; size?: number } => typeof model.name === "string")
			.map((model) => ({ name: model.name, sizeBytes: model.size ?? 0 }));
	}

	/** Pull a model through the server API (weights land in the SERVER's models dir). */
	async pull(ref: string, onProgress?: (status: string) => void): Promise<{ ok: boolean; error?: string }> {
		try {
			const response = await this._fetch(`${this._baseUrl}/api/pull`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: ref, stream: true }),
			});
			if (!response.ok || !response.body) {
				return {
					ok: false,
					error: `pull failed: HTTP ${response.status} ${await response.text().catch(() => "")}`,
				};
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let lastStatus = "";
			let errorMessage: string | undefined;
			const handleLine = (line: string): void => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as { status?: string; error?: string };
					if (event.error) errorMessage = event.error;
					if (event.status && event.status !== lastStatus) {
						lastStatus = event.status;
						onProgress?.(event.status);
					}
				} catch {
					// partial line noise
				}
			};
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
			}
			// The stream's FINAL line has no trailing newline — it stays in the buffer and holds
			// the terminal "success"/error event; dropping it misreports every completed pull.
			handleLine(buffer);
			if (errorMessage) return { ok: false, error: errorMessage };
			return lastStatus === "success"
				? { ok: true }
				: { ok: false, error: `pull ended with: ${lastStatus || "unknown"}` };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** EXPLICIT user action only — callers must have shown what gets deleted and confirmed. */
	async remove(ref: string): Promise<{ ok: boolean; error?: string }> {
		try {
			const response = await this._fetch(`${this._baseUrl}/api/delete`, {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: ref }),
			});
			if (!response.ok) {
				return {
					ok: false,
					error: `delete failed: HTTP ${response.status} ${await response.text().catch(() => "")}`,
				};
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
}

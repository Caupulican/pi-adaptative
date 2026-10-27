export interface InstalledCli {
	path: string;
	fileIdentity: string;
	size: number;
}

export interface ReviewedCliInstallation {
	readonly version: string;
	readonly sha256: string;
}

export interface InstalledCliEnvironment {
	readonly path: string;
	readonly cwd: string;
	readonly platform: string;
}

export function captureInstalledCliEnvironment(): InstalledCliEnvironment | undefined {
	if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return undefined;
	return Object.freeze({ path: process.env.PATH ?? "", cwd: process.cwd(), platform: process.platform });
}

/** Resolve executable files without invoking a shell. */
export async function findInstalledCli(
	command: string,
	override?: string,
	signal?: AbortSignal,
	environment?: InstalledCliEnvironment,
): Promise<InstalledCli | undefined> {
	signal?.throwIfAborted();
	if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return undefined;
	const { promises: fs, constants } = process.getBuiltinModule("node:fs");
	const path = process.getBuiltinModule("node:path");
	const context = environment ?? captureInstalledCliEnvironment();
	if (!context) return undefined;
	const directories = context.path.split(path.delimiter).filter(Boolean);
	const names = context.platform === "win32" ? [`${command}.exe`, command] : [command];
	const candidates = override
		? [path.resolve(context.cwd, override)]
		: directories
				.slice(0, 64)
				.flatMap((directory) => names.map((name) => path.resolve(context.cwd, directory, name)));
	for (const candidate of candidates) {
		signal?.throwIfAborted();
		try {
			await fs.access(candidate, constants.X_OK);
			signal?.throwIfAborted();
			const realPath = await fs.realpath(candidate);
			signal?.throwIfAborted();
			const stat = await fs.stat(realPath);
			signal?.throwIfAborted();
			if (!stat.isFile()) continue;
			return {
				path: realPath,
				fileIdentity: `${realPath}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
				size: stat.size,
			};
		} catch {
			signal?.throwIfAborted();
			// An unavailable PATH entry cannot shadow a later executable.
		}
	}
	if (!override && directories.length > 64) throw new Error("Installed CLI lookup exceeded its PATH-entry bound");
	return undefined;
}

/** Query only version metadata. Process output is bounded and never used as a shell command. */
export async function readInstalledCliVersion(
	installation: InstalledCli,
	pattern: RegExp,
	signal?: AbortSignal,
): Promise<string> {
	if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") {
		throw new Error("Installed CLI discovery is unavailable in this runtime");
	}
	const { execFile } = process.getBuiltinModule("node:child_process");
	return new Promise((resolve, reject) => {
		let closed = false;
		let result: { version: string } | { error: Error } | undefined;
		const settle = () => {
			if (!closed || !result) return;
			if ("error" in result) reject(result.error);
			else resolve(result.version);
		};
		const child = execFile(
			installation.path,
			["--version"],
			{ encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024, windowsHide: true, signal },
			(error, stdout) => {
				if (error) {
					result = { error: new Error("Installed CLI version query failed") };
				} else {
					const match = pattern.exec(stdout.trim());
					result = match
						? { version: match[1] }
						: { error: new Error("Installed CLI returned an unsupported version format") };
				}
				settle();
			},
		);
		child.stdin?.end();
		child.once("close", () => {
			closed = true;
			settle();
		});
	});
}

const MAX_INSTALLED_CLI_BYTES = 512 * 1024 * 1024;

/** Compute bounded SHA-256 of an inspected executable without loading the whole file in memory. */
export async function fingerprintInstalledCli(installation: InstalledCli, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") {
		throw new Error("Installed CLI fingerprinting is unavailable in this runtime");
	}
	if (installation.size > MAX_INSTALLED_CLI_BYTES) {
		throw new Error("Installed CLI exceeds inspection bounds");
	}
	const { createReadStream } = process.getBuiltinModule("node:fs");
	const { createHash } = process.getBuiltinModule("node:crypto");
	const hash = createHash("sha256");
	const stream = createReadStream(installation.path, { highWaterMark: 64 * 1024, signal });
	let bytes = 0;
	try {
		for await (const chunk of stream) {
			if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected installed CLI data");
			bytes += chunk.length;
			if (bytes > MAX_INSTALLED_CLI_BYTES) throw new Error("Installed CLI exceeds inspection bounds");
			hash.update(chunk);
		}
		if (bytes !== installation.size) throw new Error("Installed CLI changed during inspection");
		return hash.digest("hex");
	} finally {
		stream.destroy();
	}
}

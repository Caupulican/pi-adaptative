import { accessSync, constants, opendirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { runtimesDir } from "./agent-paths.ts";

/** Includes directory discovery, executable stats/access and subsequent identity validation. */
export const PYTHON_DISCOVERY_METADATA_BOUND = 512;
const MAX_DISCOVERY_STEPS = 128;
const MAX_INTERPRETER_CANDIDATES = 16;

/** Read-only candidates from Pi's installed runtimes and the executable PATH; never starts a process. */
export function installedPythonCandidates(agentDir: string, assertCurrent: () => void): readonly string[] {
	const candidates = new Set<string>();
	let remaining = MAX_DISCOVERY_STEPS;
	const inspect = (path: string): void => {
		assertCurrent();
		if (remaining <= 0 || candidates.size >= MAX_INTERPRETER_CANDIDATES || !isAbsolute(path)) return;
		remaining--;
		try {
			if (!statSync(path).isFile()) return;
			accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
			candidates.add(path);
		} catch {
			// Missing, unreadable or non-executable candidates do not authorize execution.
		}
	};
	const names = process.platform === "win32" ? ["python.exe"] : ["python3", "python"];
	const root = runtimesDir("python", agentDir);
	let directory: ReturnType<typeof opendirSync> | undefined;
	try {
		directory = opendirSync(root);
		while (remaining > 0 && candidates.size < MAX_INTERPRETER_CANDIDATES) {
			assertCurrent();
			remaining--;
			const entry = directory.readSync();
			if (!entry) break;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			for (const name of names)
				inspect(join(root, entry.name, ...(process.platform === "win32" ? [] : ["bin"]), name));
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	} finally {
		directory?.closeSync();
	}
	for (const path of (process.env.PATH ?? "").split(delimiter)) {
		if (remaining <= 0 || candidates.size >= MAX_INTERPRETER_CANDIDATES) break;
		if (!path || !isAbsolute(path)) continue;
		for (const name of names) inspect(join(path, name));
	}
	return [...candidates];
}

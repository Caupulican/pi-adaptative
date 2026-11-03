export interface NpmExec {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * The npm command line: the configured `npmCommand`, else `npm` resolved from PATH.
 * It never derives npm from `process.execPath`, which is pi itself under the Bun-compiled binary.
 * On Windows `npm` is the `npm.cmd` shim, which Node refuses to spawn without a shell (`EINVAL`):
 * spawn it through `spawnProcess`/`spawnProcessSync` (`utils/child-process.ts`, cross-spawn on win32),
 * never through raw `execFile`.
 */
export function npmExec(configured?: readonly string[]): NpmExec {
	if (configured && configured.length > 0 && configured[0]) {
		const [command, ...args] = configured;
		return { command, args };
	}
	return { command: "npm", args: [] };
}

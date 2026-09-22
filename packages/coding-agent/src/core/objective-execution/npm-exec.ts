import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NpmExec {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * Node refuses to spawn `npm.cmd` without a shell (`EINVAL`).
 * The Windows node distribution ships `npm-cli.js` beside `node.exe`; run that with node.
 */
export function npmExec(
	configured?: readonly string[],
	platform: NodeJS.Platform = process.platform,
	execPath: string = process.execPath,
): NpmExec {
	if (configured && configured.length > 0 && configured[0]) {
		const [command, ...args] = configured;
		return { command, args };
	}
	if (platform === "win32") {
		const cli = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
		if (!existsSync(cli)) throw new Error(`npm_cli_unavailable: ${cli}`);
		return { command: execPath, args: [cli] };
	}
	return { command: "npm", args: [] };
}

/** Answers version probe executions for seeded managed tools without running unscripted host processes. */

import { resolve } from "node:path";
import { JSCPD_VERSION } from "../../../src/utils/bundled-jscpd.ts";
import {
	BITWARDEN_CLI_VERSION,
	BITWARDEN_SECRETS_MANAGER_CLI_VERSION,
	FD_VERSION,
	getManagedToolBinaryPath,
	HERDR_VERSION,
	JQ_VERSION,
	type ManagedToolName,
	RG_VERSION,
	UV_VERSION,
} from "../../../src/utils/tools-manager.ts";

const MANAGED_TOOL_PINS: Readonly<Record<ManagedToolName, string>> = {
	bw: BITWARDEN_CLI_VERSION,
	bws: BITWARDEN_SECRETS_MANAGER_CLI_VERSION,
	fd: FD_VERSION,
	herdr: HERDR_VERSION,
	jq: JQ_VERSION,
	jscpd: JSCPD_VERSION,
	rg: RG_VERSION,
	uv: UV_VERSION,
};

const MANAGED_TOOLS: readonly ManagedToolName[] = ["bw", "bws", "fd", "herdr", "jq", "jscpd", "rg", "uv"];

function matchesManagedPath(file: string, managed: string): boolean {
	if (file === managed || resolve(file) === resolve(managed)) {
		return true;
	}
	if (process.platform === "win32") {
		return (
			file.toLowerCase() === managed.toLowerCase() || resolve(file).toLowerCase() === resolve(managed).toLowerCase()
		);
	}
	return false;
}

export interface ManagedToolVersionProbeResult {
	status: number;
	signal: null;
	pid: number;
	stdout: string;
	stderr: string;
	output: [null, string, string];
}

export function answerManagedToolVersionProbe(
	operation: string,
	args: readonly unknown[],
): ManagedToolVersionProbeResult | undefined {
	if (operation !== "spawnSync") {
		return undefined;
	}
	const [file, argv] = args;
	if (typeof file !== "string") {
		return undefined;
	}
	if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--version") {
		return undefined;
	}
	for (const tool of MANAGED_TOOLS) {
		const managed = getManagedToolBinaryPath(tool);
		if (matchesManagedPath(file, managed)) {
			const stdout = `${MANAGED_TOOL_PINS[tool]}\n`;
			return {
				status: 0,
				signal: null,
				pid: 0,
				stdout,
				stderr: "",
				output: [null, stdout, ""],
			};
		}
	}
	return undefined;
}

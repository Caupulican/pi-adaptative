#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { ensureManagedJscpd } from "./utils/bundled-jscpd.ts";

try {
	const binary = ensureManagedJscpd();
	const result = spawnSync(binary, process.argv.slice(2), {
		cwd: process.cwd(),
		env: process.env,
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.signal) process.kill(process.pid, result.signal);
	process.exitCode = result.status ?? 1;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

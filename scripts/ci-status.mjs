#!/usr/bin/env node
/** Repository hook adapter; the installed package owns CI watching, retention and display. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCiStatusCommand } from "../packages/coding-agent/src/host/ci/ci-status-command.ts";

export {
	commitObligation, describeStatus, prePushTargets, readCiStatus,
	reconcile, statusDirectory, statusFile, watch,
} from "../packages/coding-agent/src/host/ci/ci-status-command.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	runCiStatusCommand(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`ci-status: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = process.argv.includes("pre-push") ? 0 : 1;
	});
}

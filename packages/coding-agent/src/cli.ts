#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME, VERSION } from "./config.ts";
import { startCliPowerShellWarmStart } from "./core/tools/early-powershell-session.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const cliArgs = process.argv.slice(2);
const [firstArg] = cliArgs;
const packageCommands = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);

// Fast path: version needs nothing beyond config.ts (already loaded). Mirrors main.ts's
// `parsed.version` output exactly; skipping main's import graph turns ~1s into ~150ms.
// Must run before HTTP/undici setup so a compiled `pi --version` cannot die on dispatcher init.
if ((firstArg === "--version" || firstArg === "-v") && cliArgs.length === 1) {
	console.log(VERSION);
	process.exit(0);
}

const { configureHttpDispatcher } = await import("./core/http-dispatcher.ts");
// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();
if ((cliArgs.includes("--help") || cliArgs.includes("-h")) && !packageCommands.has(firstArg ?? "")) {
	const [{ parseArgs, printHelp }, { takeOverStdout }] = await Promise.all([
		import("./cli/args.ts"),
		import("./core/output-guard.ts"),
	]);
	const parsed = parseArgs(cliArgs);
	if (parsed.mode === "json" || parsed.mode === "rpc" || parsed.print || !process.stdin.isTTY) {
		takeOverStdout();
	}
	printHelp([]);
	process.exit(0);
}

const finiteCommands = new Set(["--version", "-v", "--list-models", "--export"]);
if (!packageCommands.has(firstArg ?? "") && !cliArgs.some((argument) => finiteCommands.has(argument))) {
	startCliPowerShellWarmStart({ cwd: process.cwd(), env: process.env });
}

const { main } = await import("./main.ts");
await main(cliArgs);

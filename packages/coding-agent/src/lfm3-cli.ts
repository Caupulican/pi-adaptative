#!/usr/bin/env node
import { registerBuiltInApiProviders } from "@caupulican/pi-ai/register-builtins";
import { runLfm3Cli } from "./cli/lfm3-command.ts";

registerBuiltInApiProviders();
try {
	await runLfm3Cli(process.argv.slice(2));
} catch (error: unknown) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

import { getAgentDir } from "../config.ts";
import { lfm3Status, setupLfm3 } from "../core/models/lfm3-setup.ts";
import { runLfm3MediaCli } from "./lfm3-media-command.ts";

export async function runLfm3Cli(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	if (command === "describe" || command === "transcribe" || command === "speak" || command === "ask") {
		await runLfm3MediaCli(command, rest);
		return;
	}
	if (command === "status" && rest.length === 0) {
		process.stdout.write(`${lfm3Status(getAgentDir())}\n`);
		return;
	}
	if (command !== "setup")
		throw new Error(
			"Usage: pi lfm3 setup [--trials N] [--model text|vision|audio|omni] [--activate] | status | describe | transcribe | speak | ask",
		);
	let trials = 3;
	let model: string | undefined;
	let activate = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--activate") activate = true;
		else if (arg === "--trials") trials = Number(rest[++i]);
		else if (arg === "--model") model = rest[++i];
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20)
		throw new Error("--trials must be an integer from 1 through 20");
	if (rest.includes("--model") && !model) throw new Error("--model requires an id");
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Setup interrupted"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	try {
		await setupLfm3({
			agentDir: getAgentDir(),
			cwd: process.cwd(),
			trials,
			model,
			activate,
			signal: controller.signal,
			log: (message) => process.stderr.write(`${message}\n`),
		});
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}

/**
 * The yes/no question the launch asks on the terminal before a session opens (forking a session found in another
 * project). Startup keeps typed keys raw until the TUI takes the terminal; the question reads a cooked line, then hands
 * the terminal back to that typeahead.
 */
import { createInterface } from "node:readline";
import { resumeStartupTypeahead } from "./startup-typeahead.ts";

/** Prompt user for yes/no confirmation. Non-interactive callers fail closed instead of waiting on stdin. */
export async function promptConfirm(message: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		let settled = false;
		const finish = (confirmed: boolean) => {
			if (settled) return;
			settled = true;
			rl.removeListener("close", onClose);
			rl.close();
			// readline leaves the terminal cooked on close; startup still holds typed keys raw.
			resumeStartupTypeahead();
			resolve(confirmed);
		};
		const onClose = () => finish(false);
		rl.once("close", onClose);
		rl.question(`${message} [y/N] `, (answer) => {
			const normalized = answer.trim().toLowerCase();
			finish(normalized === "y" || normalized === "yes");
		});
	});
}

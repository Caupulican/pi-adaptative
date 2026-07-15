import { spawnProcess, waitForChildProcess } from "./child-process.ts";

export interface ExternalEditorCommand {
	command: string;
	args: string[];
}

/** Parse the small command-line form conventionally stored in VISUAL/EDITOR. */
export function parseExternalEditorCommand(value: string): ExternalEditorCommand | undefined {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let tokenStarted = false;

	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (quote) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			if (character === "\\" && value[index + 1] === quote) {
				current += quote;
				index++;
				continue;
			}
			current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			tokenStarted = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}
		current += character;
		tokenStarted = true;
	}
	if (quote || !tokenStarted) return undefined;
	args.push(current);
	const [command, ...commandArgs] = args;
	return command ? { command, args: commandArgs } : undefined;
}

export async function runExternalEditor(commandLine: string, filePath: string): Promise<number | null> {
	const parsed = parseExternalEditorCommand(commandLine);
	if (!parsed) return null;
	try {
		const child = spawnProcess(parsed.command, [...parsed.args, filePath], {
			stdio: "inherit",
			windowsHide: false,
		});
		return await waitForChildProcess(child);
	} catch {
		return null;
	}
}

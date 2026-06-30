import fs from "node:fs";

export function isAutomataAvailable(args: { executablePath?: string; dbPath?: string }): boolean {
	if (!args.executablePath || !args.dbPath) {
		return false;
	}
	try {
		const execExists = fs.existsSync(args.executablePath);
		const dbExists = fs.existsSync(args.dbPath);
		return execExists && dbExists;
	} catch {
		return false;
	}
}

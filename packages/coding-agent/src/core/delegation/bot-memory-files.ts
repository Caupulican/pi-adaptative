/** File operations for the durable memory artifacts of bots and teams. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";

/** A competing initializer or outcome append owns any file that already exists. */
export function createMemoryHeader(filePath: string, header: string): void {
	try {
		writeFileSync(filePath, header, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export function appendBoundedFile(filePath: string, line: string, maxLines = 80): void {
	mkdirSync(dirname(filePath), { recursive: true });
	withFileLockSync(
		filePath,
		() => {
			let lines = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/) : [];
			lines.push(line);
			if (lines.length > maxLines) lines = lines.slice(-maxLines);
			writeFileAtomicSync(filePath, lines.join("\n"));
		},
		{ retries: 0 },
	);
}

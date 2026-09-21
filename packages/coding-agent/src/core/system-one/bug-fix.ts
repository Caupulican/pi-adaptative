/** A bug-fix request names the word bug, bugs, or bugfix. The letter sequence inside debug does not count. */
export function requestsBugFix(id: string, description: string | undefined): boolean {
	return /\bbugs?\b|\bbug[-_]?fix\b/i.test(`${id}\n${description ?? ""}`);
}

/** Matches the managed Herdr session's explicit shell, not an ambient user shell dialect. */
export function herdrCommand(
	executable: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	environment: Readonly<Record<string, string>> = {},
): string {
	const entries = Object.entries(environment);
	if (
		!executable ||
		entries.length > 8 ||
		entries.some(([name]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) ||
		[executable, ...args, ...Object.values(environment)].some((value) => value.includes("\0") || value.length > 16384)
	)
		throw new Error("Invalid structured collaboration command.");
	const quote = (value: string) => `'${value.replaceAll("'", platform === "win32" ? "''" : "'\\''")}'`;
	const words = [executable, ...args].map(quote);
	const assignments = entries
		.map(([name, value]) => `${platform === "win32" ? "$env:" : ""}${name}=${quote(value)}`)
		.join(platform === "win32" ? "; " : " ");
	return `${assignments ? `${assignments}${platform === "win32" ? "; " : " "}` : ""}${platform === "win32" ? "& " : ""}${words.join(" ")}`;
}

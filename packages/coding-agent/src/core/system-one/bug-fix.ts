/** The same bug-fix text the objective controller already uses for JEV-019. */
export function requestsBugFix(id: string, description: string | undefined): boolean {
	return id.toLowerCase().includes("bug") || (description ?? "").toLowerCase().includes("bug");
}

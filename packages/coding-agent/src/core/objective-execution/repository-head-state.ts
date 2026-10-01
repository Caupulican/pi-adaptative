/** Git's successful porcelain branch header proves an unborn HEAD without hiding command failures. */
export function parseRepositoryHeadRecord(record: string): string | undefined {
	if (record === "# branch.oid (initial)") return "unborn";
	return /^# branch\.oid ([0-9a-f]{40,64})$/.exec(record)?.[1];
}

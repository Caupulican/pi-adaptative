/** Environment names follow the execution backend, independently of path or shell syntax. */
export interface ExecutionEnvironment {
	readonly variables: Readonly<Record<string, string | undefined>>;
	readonly caseSensitive: boolean;
}

/** Copy and merge explicit layers, then apply exclusions. Never borrows the operator environment. */
export function composeExecutionEnvironment(
	base: ExecutionEnvironment,
	additions: readonly Readonly<Record<string, string | undefined>>[],
	omitted: readonly string[] = [],
): Record<string, string | undefined> {
	if (typeof base.caseSensitive !== "boolean") throw new Error("Execution environment requires a case policy.");
	const identity = (name: string) => (base.caseSensitive ? name : name.toUpperCase());
	const entries = new Map<string, { name: string; value: string }>();
	for (const layer of [base.variables, ...additions]) {
		for (const [name, value] of Object.entries(layer)) {
			if (name.includes("\0") || (value !== undefined && (typeof value !== "string" || value.includes("\0"))))
				throw new Error("Invalid execution environment entry.");
			const key = identity(name);
			if (value === undefined) entries.delete(key);
			else entries.set(key, { name, value });
		}
	}
	for (const name of omitted) entries.delete(identity(name));
	const result: Record<string, string | undefined> = Object.create(null);
	for (const { name, value } of entries.values()) result[name] = value;
	return result;
}

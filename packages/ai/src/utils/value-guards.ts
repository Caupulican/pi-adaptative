/** Accepts non-null object records while excluding arrays; custom prototypes remain valid. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

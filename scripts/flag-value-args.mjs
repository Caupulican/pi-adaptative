export function requireFlagValue(argv, index) {
	const flag = argv[index];
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${String(flag)} requires a value`);
	return value;
}

/**
 * Reads the values of a flow spec: each reader takes a raw value and the path that names it, returns a usable value,
 * and adds a line to `problems` when the spec broke a rule, so that every problem of a spec is named at once.
 */

const MAX_TEXT = 96;

export function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNumber(value, path, problems, { min, max, fallback, integer = false }) {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
		problems.push(`${path}: must be ${integer ? "a whole number" : "a number"}`);
		return fallback ?? min;
	}
	if (value < min || value > max) {
		problems.push(`${path}: must be between ${min} and ${max}`);
		return Math.min(Math.max(value, min), max);
	}
	return value;
}

export function readText(value, path, problems, required = false) {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT) {
		problems.push(`${path}: must be text of 1 to ${MAX_TEXT} characters`);
		return undefined;
	}
	return value.replace(/\s+/g, " ").trim();
}

export function readTextList(value, path, problems, max) {
	if (value === undefined) return [];
	const list = typeof value === "string" ? [value] : value;
	if (!Array.isArray(list) || list.length > max) {
		problems.push(`${path}: must be a list of at most ${max} lines of text`);
		return [];
	}
	return list.flatMap((entry, index) => readText(entry, `${path}[${index}]`, problems, true) ?? []);
}

export function readOneOf(value, allowed, path, problems, fallback) {
	if (value === undefined && fallback !== undefined) return fallback;
	if (!allowed.includes(value)) {
		problems.push(`${path}: must be one of ${allowed.join(", ")}`);
		return fallback ?? allowed[0];
	}
	return value;
}

/** Reads a 1-based `round` and intra-round `at` second from `entry` and returns `{ round, at, time }` (0-based `round`). */
export function readPeriodMoment(entry, path, problems, rounds, loop) {
	const round = readNumber(entry.round, `${path}.round`, problems, { min: 1, max: rounds, fallback: 1, integer: true });
	const at = readNumber(entry.at, `${path}.at`, problems, { min: 0, max: loop, fallback: 0 });
	return { round: round - 1, at, time: (round - 1) * loop + at };
}

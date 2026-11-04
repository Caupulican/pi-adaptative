/**
 * Arguments the host filled for a call.
 *
 * A tool may declare parameters as session identity (`AgentTool.sessionIdentity`): when the model leaves one
 * empty, the host runs the call with the value the session already established. The persisted call keeps the
 * arguments as the model wrote them, so the outcome has to say what actually ran; otherwise a failure caused by
 * the filled value has no visible cause and the model repeats a call it believes it made differently.
 */

/** One declared parameter the model left empty and the host ran with a value. */
export interface HostFilledArgument {
	readonly name: string;
	readonly value: string;
}

const MAX_REPORTED_ARGUMENTS = 8;
const MAX_REPORTED_VALUE_CHARS = 128;

/** An argument the model did not supply: absent, null or an empty string. */
export function isVacantArgument(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

/** The declared parameters that were empty in the model's arguments and carry a value in the executed ones. */
export function hostFilledArguments(
	declared: readonly string[] | undefined,
	modelArguments: unknown,
	executedArguments: unknown,
): HostFilledArgument[] {
	if (!declared || declared.length === 0) return [];
	if (typeof executedArguments !== "object" || executedArguments === null) return [];
	const executed = executedArguments as Record<string, unknown>;
	const supplied =
		typeof modelArguments === "object" && modelArguments !== null ? (modelArguments as Record<string, unknown>) : {};
	const filled: HostFilledArgument[] = [];
	for (const name of declared) {
		const value = executed[name];
		if (typeof value === "string" && !isVacantArgument(value) && isVacantArgument(supplied[name])) {
			filled.push({ name, value });
		}
	}
	return filled;
}

function describeFilled(filled: readonly HostFilledArgument[]): string {
	const shown = filled.slice(0, MAX_REPORTED_ARGUMENTS).map(({ name, value }) => {
		const text = value.length > MAX_REPORTED_VALUE_CHARS ? `${value.slice(0, MAX_REPORTED_VALUE_CHARS - 1)}…` : value;
		return `${name}=${JSON.stringify(text)}`;
	});
	const omitted = filled.length - shown.length;
	return omitted > 0 ? `${shown.join(", ")} and ${omitted} more` : shown.join(", ");
}

/** The line a result carries when the call ran with host-filled arguments and no failure record names them. */
export function hostFilledArgumentsNote(filled: readonly HostFilledArgument[]): string {
	return `[harness] The omitted ${describeFilled(filled)} was filled from this session before the call ran. Pass an explicit value to use another.`;
}

/** The sentence a failure record's correction carries, so the cause stays visible in the ledger and on a replay. */
export function hostFilledArgumentsCorrection(filled: readonly HostFilledArgument[]): string {
	return `The harness filled the omitted ${describeFilled(filled)} from this session before the call ran; if that value is not the intended one, pass an explicit value.`;
}

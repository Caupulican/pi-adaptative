/** The revision check of a routine write that names the revision its caller read. */

/** A routine changed (another writer) between the revision its caller read and the write that names it. */
export class RoutineRevisionChangedError extends Error {
	constructor() {
		super("Routine revision changed; read current state before retrying.");
		this.name = "RoutineRevisionChangedError";
	}
}

/** Throws {@link RoutineRevisionChangedError} when the caller named a revision (`expected`) other than `current`'s. */
export function assertRoutineRevision(current: number | undefined, expected: number | undefined): void {
	if (expected !== undefined && current !== expected) throw new RoutineRevisionChangedError();
}

/**
 * The stays of a scene: the times every journey holds an item at a station. A trial's rack and a lane's row both draw
 * what a station held over one round, so the reading of those times lives on its own, apart from either drawing.
 */

/** The stations that hold an item for a stay; a queue holds one per slot, the others one at a time. */
export const HOLDING_KINDS = ["queue", "worker", "trial", "card", "batch"];

/** Whether a journey runs in `round` (0-based). A journey with no `rounds` list runs in every round. */
export function runInRound(run, round) {
	return run.rounds === undefined || round === undefined || run.rounds.includes(round);
}

/**
 * The stays of every journey at one station, in the order the journeys are declared: each with the journey and the
 * segment it belongs to, and its start and end in seconds from the beginning of the round. Pass `round` to restrict to
 * journeys active in that round. A journey must end inside the loop, so no stay runs past it.
 */
export function staysAt(scene, station, round) {
	const stays = [];
	for (const run of scene.runs) {
		if (!runInRound(run, round)) continue;
		for (const segment of run.segments)
			if (segment.kind === "work" && segment.node === station)
				stays.push({ run, segment, start: run.start + segment.from, end: run.start + segment.to });
	}
	return stays;
}

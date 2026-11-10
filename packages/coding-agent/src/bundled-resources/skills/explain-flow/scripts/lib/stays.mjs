/**
 * The stays of a scene: the times every journey holds an item at a station. A trial's rack and a lane's row both draw
 * what a station held over one round, so the reading of those times lives on its own, apart from either drawing.
 */

/** The stations that hold an item for a stay; a queue holds one per slot, the others one at a time. */
export const HOLDING_KINDS = ["queue", "worker", "trial"];

/**
 * The stays of every journey at one station, in the order the journeys are declared: each with the journey and the
 * segment it belongs to, and its start and end in seconds from the beginning of the round. A journey must end inside
 * the loop, so no stay runs past it.
 */
export function staysAt(scene, station) {
	const stays = [];
	for (const run of scene.runs)
		for (const segment of run.segments)
			if (segment.kind === "work" && segment.node === station)
				stays.push({ run, segment, start: run.start + segment.from, end: run.start + segment.to });
	return stays;
}

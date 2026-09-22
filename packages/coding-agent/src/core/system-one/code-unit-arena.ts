/**
 * The feature arena behind semantic duplicate search: every indexed unit's calls (interned ids) and
 * structural fingerprints (32-bit window hashes) in CSR typed arrays, with inverted postings, on
 * SharedArrayBuffers so scan workers read them without a copy.
 *
 * Scoring a probe touches only its informative postings through sparse accumulators that are reset per
 * probe, so a whole-repository scan costs the postings it touches, never all pairs. Structural overlap
 * is a sorted merge. The module imports nothing, so a worker thread can load it on its own.
 */

/** One unit's features: sorted unique call ids, sorted unique window hashes, token count. */
export interface UnitFeatures {
	readonly calls: Int32Array;
	readonly windows: Int32Array;
	readonly tokenCount: number;
	/** Interned identities used to exclude a unit's own entry: same path and (same name or same code). */
	readonly pathId: number;
	readonly nameId: number;
	readonly codeId: number;
}

export interface ArenaBuffers {
	readonly unitCount: number;
	readonly vocabularySize: number;
	readonly callOffsets: Int32Array;
	readonly callIds: Int32Array;
	readonly windowOffsets: Int32Array;
	readonly windowHashes: Int32Array;
	readonly tokenCounts: Int32Array;
	readonly pathIds: Int32Array;
	readonly nameIds: Int32Array;
	readonly codeIds: Int32Array;
	readonly callPostingOffsets: Int32Array;
	readonly callPostings: Int32Array;
	/** Sorted unique window hashes and, per hash, its posting range. */
	readonly windowKeys: Int32Array;
	readonly windowPostingOffsets: Int32Array;
	readonly windowPostings: Int32Array;
	readonly weights: Float64Array;
	readonly norms: Float64Array;
}

export interface ScoringParameters {
	/** Below this in both similarities a candidate is dropped. */
	readonly minSimilarity: number;
	/** Below this many tokens in either unit, structure is too generic to compare. */
	readonly structuralMinTokens: number;
	readonly limit: number;
}

export interface ScoredCandidate {
	readonly unit: number;
	readonly callSimilarity: number;
	readonly structuralSimilarity: number;
}

function shared<T extends Int32Array | Float64Array>(
	Kind: { new (buffer: SharedArrayBuffer): T; BYTES_PER_ELEMENT: number },
	length: number,
): T {
	return new Kind(new SharedArrayBuffer(Math.max(1, length) * Kind.BYTES_PER_ELEMENT));
}

function csr(lists: readonly Int32Array[]): { offsets: Int32Array; values: Int32Array } {
	const offsets = shared(Int32Array, lists.length + 1);
	let total = 0;
	for (let index = 0; index < lists.length; index += 1) {
		offsets[index] = total;
		total += lists[index]?.length ?? 0;
	}
	offsets[lists.length] = total;
	const values = shared(Int32Array, total);
	for (let index = 0; index < lists.length; index += 1) values.set(lists[index] ?? new Int32Array(), offsets[index]);
	return { offsets, values };
}

/** Build the arena from unit features. Linear in the total feature count plus a sort of window keys. */
export function buildArena(units: readonly UnitFeatures[], vocabularySize: number): ArenaBuffers {
	const unitCount = units.length;
	const calls = csr(units.map((unit) => unit.calls));
	const windows = csr(units.map((unit) => unit.windows));
	const tokenCounts = shared(Int32Array, unitCount);
	const pathIds = shared(Int32Array, unitCount);
	const nameIds = shared(Int32Array, unitCount);
	const codeIds = shared(Int32Array, unitCount);
	units.forEach((unit, index) => {
		tokenCounts[index] = unit.tokenCount;
		pathIds[index] = unit.pathId;
		nameIds[index] = unit.nameId;
		codeIds[index] = unit.codeId;
	});

	// Call postings: counting sort by call id; units are visited in order, so each posting is sorted.
	const callCounts = new Int32Array(vocabularySize + 1);
	for (const call of calls.values) callCounts[call + 1] += 1;
	const callPostingOffsets = shared(Int32Array, vocabularySize + 1);
	for (let call = 0; call < vocabularySize; call += 1)
		callPostingOffsets[call + 1] = callPostingOffsets[call]! + callCounts[call + 1]!;
	const callPostings = shared(Int32Array, calls.values.length);
	const callCursor = callPostingOffsets.slice(0, vocabularySize);
	for (let unit = 0; unit < unitCount; unit += 1)
		for (let at = calls.offsets[unit]!; at < calls.offsets[unit + 1]!; at += 1)
			callPostings[callCursor[calls.values[at]!]!++] = unit;

	// Window postings: sort (hash, unit) pairs once; keys are the unique hashes, searched by bisection.
	const pairCount = windows.values.length;
	const order = new Uint32Array(pairCount);
	const pairUnits = new Int32Array(pairCount);
	for (let unit = 0, at = 0; unit < unitCount; unit += 1)
		for (let cursor = windows.offsets[unit]!; cursor < windows.offsets[unit + 1]!; cursor += 1, at += 1) {
			order[at] = at;
			pairUnits[at] = unit;
		}
	order.sort((left, right) => windows.values[left]! - windows.values[right]! || pairUnits[left]! - pairUnits[right]!);
	let keyCount = 0;
	for (let index = 0; index < pairCount; index += 1)
		if (index === 0 || windows.values[order[index]!] !== windows.values[order[index - 1]!]) keyCount += 1;
	const windowKeys = shared(Int32Array, keyCount);
	const windowPostingOffsets = shared(Int32Array, keyCount + 1);
	const windowPostings = shared(Int32Array, pairCount);
	for (let index = 0, key = -1; index < pairCount; index += 1) {
		const hash = windows.values[order[index]!]!;
		if (key < 0 || windowKeys[key] !== hash) {
			key += 1;
			windowKeys[key] = hash;
			windowPostingOffsets[key] = index;
		}
		windowPostings[index] = pairUnits[order[index]!]!;
	}
	windowPostingOffsets[keyCount] = pairCount;

	// Squared IDF per call from its exact document frequency, and each unit's norm over its calls.
	const weights = shared(Float64Array, vocabularySize);
	for (let call = 0; call < vocabularySize; call += 1) {
		const frequency = callPostingOffsets[call + 1]! - callPostingOffsets[call]!;
		weights[call] = Math.log((unitCount + 1) / (frequency + 1)) ** 2;
	}
	const norms = shared(Float64Array, unitCount);
	for (let unit = 0; unit < unitCount; unit += 1) {
		let norm = 0;
		for (let at = calls.offsets[unit]!; at < calls.offsets[unit + 1]!; at += 1) norm += weights[calls.values[at]!]!;
		norms[unit] = norm;
	}

	return {
		unitCount,
		vocabularySize,
		callOffsets: calls.offsets,
		callIds: calls.values,
		windowOffsets: windows.offsets,
		windowHashes: windows.values,
		tokenCounts,
		pathIds,
		nameIds,
		codeIds,
		callPostingOffsets,
		callPostings,
		windowKeys,
		windowPostingOffsets,
		windowPostings,
		weights,
		norms,
	};
}

function bisect(sorted: Int32Array, value: number, from = 0, to = sorted.length): number {
	let low = from;
	let high = to - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const found = sorted[middle]!;
		if (found < value) low = middle + 1;
		else if (found > value) high = middle - 1;
		else return middle;
	}
	return -1;
}

function sortedIntersection(
	a: Int32Array,
	aFrom: number,
	aTo: number,
	b: Int32Array,
	bFrom: number,
	bTo: number,
): number {
	let count = 0;
	let i = aFrom;
	let j = bFrom;
	while (i < aTo && j < bTo) {
		const left = a[i]!;
		const right = b[j]!;
		if (left === right) {
			count += 1;
			i += 1;
			j += 1;
		} else if (left < right) i += 1;
		else j += 1;
	}
	return count;
}

/** Reusable per-thread accumulators, sized to the arena, reset only where a probe touched them. */
export class ScoringScratch {
	readonly dot: Float64Array;
	readonly sharedWindows: Int32Array;
	readonly touched: Int32Array;
	readonly seen: Uint8Array;

	constructor(unitCount: number) {
		this.dot = new Float64Array(unitCount);
		this.sharedWindows = new Int32Array(unitCount);
		this.touched = new Int32Array(unitCount);
		this.seen = new Uint8Array(unitCount);
	}
}

/**
 * The indexed units most similar to a probe, by IDF cosine of calls or structural window overlap.
 * `self` is the probe's own arena index when it is an indexed unit (-1 otherwise). Postings longer than
 * `max(8, 2√units)` carry no identity and are not traversed; their calls still count exactly.
 */
export function scoreProbe(
	arena: ArenaBuffers,
	probe: UnitFeatures,
	self: number,
	parameters: ScoringParameters,
	scratch: ScoringScratch,
): ScoredCandidate[] {
	const informativeLimit = Math.max(8, Math.sqrt(arena.unitCount) * 2);
	let touchedCount = 0;
	const touch = (unit: number) => {
		if (scratch.seen[unit] === 0) {
			scratch.seen[unit] = 1;
			scratch.touched[touchedCount++] = unit;
		}
	};

	let probeNorm = 0;
	const commonCalls: number[] = [];
	for (const call of probe.calls) {
		const known = call >= 0 && call < arena.vocabularySize;
		// An unseen call has document frequency 0: it weighs as the rarest possible.
		const weight = known ? arena.weights[call]! : Math.log(arena.unitCount + 1) ** 2;
		probeNorm += weight;
		if (!known) continue;
		const from = arena.callPostingOffsets[call]!;
		const to = arena.callPostingOffsets[call + 1]!;
		if (to - from > informativeLimit) {
			commonCalls.push(call);
			continue;
		}
		for (let at = from; at < to; at += 1) {
			const unit = arena.callPostings[at]!;
			touch(unit);
			scratch.dot[unit] += weight;
		}
	}

	let commonWindows = 0;
	for (const hash of probe.windows) {
		const key = bisect(arena.windowKeys, hash);
		if (key < 0) continue;
		const from = arena.windowPostingOffsets[key]!;
		const to = arena.windowPostingOffsets[key + 1]!;
		if (to - from > informativeLimit) {
			commonWindows += 1;
			continue;
		}
		for (let at = from; at < to; at += 1) {
			const unit = arena.windowPostings[at]!;
			touch(unit);
			scratch.sharedWindows[unit] += 1;
		}
	}

	const scored: ScoredCandidate[] = [];
	for (let index = 0; index < touchedCount; index += 1) {
		const unit = scratch.touched[index]!;
		const dotInformative = scratch.dot[unit]!;
		const windowsInformative = scratch.sharedWindows[unit]!;
		scratch.dot[unit] = 0;
		scratch.sharedWindows[unit] = 0;
		scratch.seen[unit] = 0;
		if (unit === self) continue;
		if (
			arena.pathIds[unit] === probe.pathId &&
			(arena.nameIds[unit] === probe.nameId || arena.codeIds[unit] === probe.codeId)
		)
			continue;

		const unitWindowsFrom = arena.windowOffsets[unit]!;
		const unitWindowsTo = arena.windowOffsets[unit + 1]!;
		const largest = Math.max(probe.windows.length, unitWindowsTo - unitWindowsFrom);
		// Shared windows can only be the counted informative ones plus the common ones: an upper bound.
		const structurallyReachable =
			largest > 0 && windowsInformative + commonWindows >= parameters.minSimilarity * largest;
		// The candidate set: a unit sharing an informative call, or one whose structure can still pass. A unit
		// reached only through windows still gets its full call cosine, common calls included.
		if (dotInformative === 0 && !structurallyReachable) continue;

		let callSimilarity = 0;
		const unitNorm = arena.norms[unit]!;
		if (probeNorm > 0 && unitNorm > 0) {
			let dot = dotInformative;
			const from = arena.callOffsets[unit]!;
			const to = arena.callOffsets[unit + 1]!;
			for (const call of commonCalls) if (bisect(arena.callIds, call, from, to) >= 0) dot += arena.weights[call]!;
			callSimilarity = dot / Math.sqrt(probeNorm * unitNorm);
		}

		let structuralSimilarity = 0;
		const comparable = Math.min(probe.tokenCount, arena.tokenCounts[unit]!) >= parameters.structuralMinTokens;
		if (comparable && structurallyReachable)
			structuralSimilarity =
				sortedIntersection(
					probe.windows,
					0,
					probe.windows.length,
					arena.windowHashes,
					unitWindowsFrom,
					unitWindowsTo,
				) / largest;

		if (Math.max(callSimilarity, structuralSimilarity) >= parameters.minSimilarity)
			scored.push({ unit, callSimilarity, structuralSimilarity });
	}
	const rank = (candidate: ScoredCandidate) => Math.max(candidate.callSimilarity, candidate.structuralSimilarity);
	return scored.sort((left, right) => rank(right) - rank(left)).slice(0, parameters.limit);
}

/** An indexed unit's own features, read back from the arena (for scan probes). */
export function arenaUnitFeatures(arena: ArenaBuffers, unit: number): UnitFeatures {
	return {
		calls: arena.callIds.subarray(arena.callOffsets[unit], arena.callOffsets[unit + 1]),
		windows: arena.windowHashes.subarray(arena.windowOffsets[unit], arena.windowOffsets[unit + 1]),
		tokenCount: arena.tokenCounts[unit]!,
		pathId: arena.pathIds[unit]!,
		nameId: arena.nameIds[unit]!,
		codeId: arena.codeIds[unit]!,
	};
}

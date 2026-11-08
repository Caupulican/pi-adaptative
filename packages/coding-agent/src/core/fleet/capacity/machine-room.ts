/**
 * The machine terms of the room formula (memory and the shared heap of in-process lanes), from facts the runtime
 * reports. A lane admitted a moment ago has not grown the heap or the resident set yet, so each term subtracts what the
 * running lanes are expected to cost beyond what the process has already grown since its idle baseline: the expected
 * cost is counted once, whether or not it shows in the readings yet.
 *
 * Per-lane costs are seeds, not measurements: a lane is charged a quarter of the process's idle heap, at least 32 MiB,
 * for both terms (an in-process lane's memory is its heap). A runtime without a meaningful heap ceiling (Bun reports a
 * `heap_size_limit` that is not a V8 old-space limit) leaves the heap term unbounded.
 */

import { freemem, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import type { RoomTerm } from "../fleet-types.ts";

const MIB = 1024 * 1024;

/** The smallest per-lane cost a seed may charge. */
export const LANE_COST_FLOOR_BYTES = 32 * MIB;
/** Seed fraction of the idle heap one in-process lane is charged; a starting value until costs are learned. */
export const LANE_SEED_FRACTION = 0.25;
/** In-process lanes are admitted while the heap stays under this share of its ceiling. */
export const HEAP_USE_CEILING = 0.7;
/** Free memory kept for the rest of the machine: this floor or the configured percent of total memory, whichever is larger. */
export const MEMORY_RESERVE_FLOOR_BYTES = 1024 * MIB;

export interface MachineFacts {
	readonly availableMemory: number;
	readonly totalMemory: number;
	readonly rss: number;
	readonly usedHeap: number;
	/** Undefined when the runtime has no meaningful heap ceiling. */
	readonly heapLimit: number | undefined;
}

export interface MachineBaseline {
	readonly idleRss: number;
	readonly idleHeap: number;
	readonly laneCost: number;
}

export function readMachineFacts(): MachineFacts {
	const heap = getHeapStatistics();
	return {
		// libuv's available memory honors a cgroup limit and reads MemAvailable on Linux; free memory is the fallback.
		availableMemory: typeof process.availableMemory === "function" ? process.availableMemory() : freemem(),
		totalMemory: totalmem(),
		rss: process.memoryUsage.rss(),
		usedHeap: heap.used_heap_size,
		heapLimit: process.versions.bun ? undefined : heap.heap_size_limit,
	};
}

let processBaseline: MachineBaseline | undefined;

/**
 * The idle baseline of this process, read when its first fleet is built. A later fleet in the same process (a second
 * session, the away host, a harness world) is built on a heap that already holds the earlier ones, which is not idle.
 */
export function processMachineBaseline(): MachineBaseline {
	processBaseline ??= machineBaseline(readMachineFacts());
	return processBaseline;
}

export function machineBaseline(facts: MachineFacts): MachineBaseline {
	return {
		idleRss: facts.rss,
		idleHeap: facts.usedHeap,
		laneCost: Math.max(LANE_COST_FLOOR_BYTES, facts.usedHeap * LANE_SEED_FRACTION),
	};
}

/** The memory and heap terms for `running` lanes already admitted. */
export function machineRoomTerms(
	facts: MachineFacts,
	baseline: MachineBaseline,
	running: number,
	reserveMemoryPercent: number,
): [memory: RoomTerm, heap: RoomTerm] {
	const expected = running * baseline.laneCost;
	const unseenMemory = Math.max(0, expected - Math.max(0, facts.rss - baseline.idleRss));
	const reserve = Math.max(MEMORY_RESERVE_FLOOR_BYTES, (facts.totalMemory * reserveMemoryPercent) / 100);
	const memoryRoom = Math.floor((facts.availableMemory - reserve - unseenMemory) / baseline.laneCost);
	const memory: RoomTerm = {
		reason: "machine_memory",
		room: Math.max(0, memoryRoom),
		waitKey: "machine:memory",
		detail: `free memory is within the reserve (${running} running)`,
	};
	if (facts.heapLimit === undefined || facts.heapLimit <= 0)
		return [memory, { reason: "machine_heap", room: Number.POSITIVE_INFINITY, waitKey: "machine:heap", detail: "" }];
	const unseenHeap = Math.max(0, expected - Math.max(0, facts.usedHeap - baseline.idleHeap));
	const heapRoom = Math.floor((HEAP_USE_CEILING * facts.heapLimit - facts.usedHeap - unseenHeap) / baseline.laneCost);
	return [
		memory,
		{
			reason: "machine_heap",
			room: Math.max(0, heapRoom),
			waitKey: "machine:heap",
			detail: `the shared heap is near its ceiling (${running} running)`,
		},
	];
}

/** Durable view checkpoints and their tree-backed projection. */

import { join } from "node:path";
import { ContinuousChatCorruptError, readJsonFile, writeDurableAtomic } from "./continuous-chat-index.ts";
import { checkpointContinuousChatRecovery } from "./continuous-chat-recovery.ts";
import {
	type ContinuousChatNodeCoordinate,
	type ContinuousChatTreeNode,
	continuousChatNodeFirstMessage,
	continuousChatNodeKey,
	continuousChatNodeMessageCount,
	renderContinuousChatViewLine,
} from "./continuous-chat-tree.ts";
import {
	advanceContinuousChatView,
	type ContinuousChatViewEntry,
	type ContinuousChatViewKind,
	type ContinuousChatViewState,
	createContinuousChatView,
	fitContinuousChatViewInBackground,
	parseContinuousChatView,
	refreshContinuousChatView,
} from "./continuous-chat-view.ts";
import { CONTINUOUS_CHAT_TOP_LEVEL } from "./continuous-chat-work-queue.ts";

/** Turn view, then causal view. */
export type ViewPair = [ContinuousChatViewState, ContinuousChatViewState];
type ReadViewNode = (coordinate: ContinuousChatNodeCoordinate) => Promise<ContinuousChatTreeNode | undefined>;

interface ViewStoragePort {
	rootDir: string;
	readNode: ReadViewNode;
}

const TURN_VIEW_FILE = "view.json";
const CAUSAL_VIEW_FILE = "compaction-view.json";

export function viewFileName(kind: ContinuousChatViewKind): string {
	return kind === "turn" ? TURN_VIEW_FILE : CAUSAL_VIEW_FILE;
}

/** The persisted view, or undefined when it was never written. Malformed content is corruption. */
export async function readViewFile(
	rootDir: string,
	kind: ContinuousChatViewKind,
): Promise<ContinuousChatViewState | undefined> {
	const filePath = join(rootDir, viewFileName(kind));
	const parsed = await readJsonFile(filePath, "persisted view");
	if (parsed === undefined) return undefined;
	const view = parseContinuousChatView(parsed, kind);
	if (view === undefined) throw new ContinuousChatCorruptError(filePath, "Invalid persisted view");
	return view;
}

function serializeView(view: ContinuousChatViewState): string {
	return `${JSON.stringify(view)}\n`;
}

export async function persistView(rootDir: string, kind: ContinuousChatViewKind, serialized: string): Promise<void> {
	await writeDurableAtomic(join(rootDir, viewFileName(kind)), serialized);
}

/**
 * Advances a view one arriving leaf at a time to `expectedMessages`, then refreshes its lines against the current tree.
 * Only the arrivals commit a pending batch; the closing refresh is a background fit.
 */
function catchUpView(
	view: ContinuousChatViewState,
	expectedMessages: number,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewState {
	let next = view;
	while (next.totalMessages < expectedMessages) next = advanceContinuousChatView(next, next.totalMessages, nodes);
	return refreshContinuousChatView(next, nodes, "background");
}

/** Whether two views have the same partition and the same lines. Revisions are ignored, since a refresh bumps them. */
function sameLayout(a: ContinuousChatViewState, b: ContinuousChatViewState): boolean {
	return (
		a.totalMessages === b.totalMessages &&
		a.batchPending === b.batchPending &&
		a.entries.length === b.entries.length &&
		a.entries.every((entry, index) => {
			const other = b.entries[index];
			return (
				other !== undefined &&
				entry.level === other.level &&
				entry.ordinal === other.ordinal &&
				entry.size === other.size
			);
		})
	);
}

/** Coordinates of the message leaves [from, to). */
function leafCoordinates(from: number, to: number): ContinuousChatNodeCoordinate[] {
	return Array.from({ length: Math.max(0, to - from) }, (_, offset) => ({ level: 0, ordinal: from + offset }));
}

/**
 * The persisted views caught up to `expected`. A view never stored is created here, valid only while nothing is
 * logged: the empty view is persisted before the first log or root write.
 */
export async function loadContinuousChatViews(
	port: ViewStoragePort,
	expected: number,
	signal?: AbortSignal,
): Promise<ViewPair> {
	const views: ViewPair = [createContinuousChatView("turn"), createContinuousChatView("causal")];
	const persisted: [boolean, boolean] = [true, true];
	for (const index of [0, 1] as const) {
		signal?.throwIfAborted();
		const kind: ContinuousChatViewKind = index === 0 ? "turn" : "causal";
		const filePath = join(port.rootDir, viewFileName(kind));
		const stored = await readViewFile(port.rootDir, kind);
		if (stored === undefined) {
			if (expected > 0) throw new ContinuousChatCorruptError(filePath, "Persisted view is missing");
			persisted[index] = false;
			continue;
		}
		if (stored.totalMessages > expected) throw new ContinuousChatCorruptError(filePath, "Invalid persisted view");
		views[index] = stored;
	}
	return settleContinuousChatViews(port, views, persisted, expected, signal);
}

/** Catches both views up to `expected`, and persists each one that was never stored or whose layout changed. */
export async function settleContinuousChatViews(
	port: ViewStoragePort,
	views: ViewPair,
	persisted: [boolean, boolean],
	expected: number,
	signal?: AbortSignal,
): Promise<ViewPair> {
	const coordinates = [
		...views[0].entries,
		...views[1].entries,
		...leafCoordinates(Math.min(views[0].totalMessages, views[1].totalMessages), expected),
	];
	const nodes = await presentContinuousChatNodes(port.readNode, coordinates, true, signal);
	signal?.throwIfAborted();
	// Each view is fitted on its own, as the reference fits its two views: the causal view never inherits a merge.
	const settled: ViewPair = [catchUpView(views[0], expected, nodes), catchUpView(views[1], expected, nodes)];
	for (const index of [0, 1] as const) {
		signal?.throwIfAborted();
		if (!persisted[index] || !sameLayout(views[index], settled[index])) {
			await persistView(port.rootDir, settled[index].kind, serializeView(settled[index]));
		}
	}
	return settled;
}

/**
 * Present nodes for `coordinates`. With `ancestors`, every present ancestor is included too. A node is present only
 * after both its children, so the climb stops at the first missing ancestor: nothing above it can be present.
 */
export async function presentContinuousChatNodes(
	readNode: ReadViewNode,
	coordinates: Iterable<ContinuousChatNodeCoordinate>,
	ancestors: boolean,
	signal?: AbortSignal,
): Promise<Map<string, ContinuousChatTreeNode>> {
	const nodes = new Map<string, ContinuousChatTreeNode>();
	const visited = new Set<string>();
	const pending = [...coordinates];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		await checkpointContinuousChatRecovery(signal, visited.size);
		const key = continuousChatNodeKey(next);
		if (visited.has(key)) continue;
		visited.add(key);
		const node = await readNode(next);
		if (node === undefined) continue;
		nodes.set(key, node);
		if (ancestors && next.level < CONTINUOUS_CHAT_TOP_LEVEL) {
			pending.push({ level: next.level + 1, ordinal: Math.floor(next.ordinal / 2) });
		}
	}
	return nodes;
}

/** The built part of a causal view. A straddling entry is split into its children until each piece ends by `end`. */
export async function cutContinuousChatView(
	readNode: ReadViewNode,
	entries: readonly ContinuousChatViewEntry[],
	end: number,
	filePath: string,
): Promise<ContinuousChatViewEntry[]> {
	const cut: ContinuousChatViewEntry[] = [];
	const visit = async (coordinate: ContinuousChatNodeCoordinate): Promise<void> => {
		const first = continuousChatNodeFirstMessage(coordinate);
		if (first >= end) return;
		const node = await readNode(coordinate);
		if (node !== undefined && first + continuousChatNodeMessageCount(coordinate.level) <= end) {
			const size = Buffer.byteLength(`${renderContinuousChatViewLine(node)}\n`, "utf8");
			cut.push({ level: coordinate.level, ordinal: coordinate.ordinal, size });
			return;
		}
		if (coordinate.level === 0) {
			throw new ContinuousChatCorruptError(filePath, `Causal prefix reaches unbuilt message ${first}`);
		}
		await visit({ level: coordinate.level - 1, ordinal: coordinate.ordinal * 2 });
		await visit({ level: coordinate.level - 1, ordinal: coordinate.ordinal * 2 + 1 });
	};
	for (const entry of entries) await visit(entry);
	return cut;
}

/** Tree reads and fit work happen outside the writer lock. The caller validates revision before adopting the proposal. */
export async function proposeContinuousChatViewFit(
	readNode: ReadViewNode,
	view: ContinuousChatViewState,
): Promise<{ view: ContinuousChatViewState; serialized: string } | undefined> {
	const snapshot = { ...view, entries: [...view.entries] };
	const nodes = await presentContinuousChatNodes(readNode, snapshot.entries, true);
	const proposal = await fitContinuousChatViewInBackground(snapshot, nodes, checkpointContinuousChatRecovery);
	return sameLayout(snapshot, proposal) ? undefined : { view: proposal, serialized: serializeView(proposal) };
}

/**
 * The path envelopes a session's file tools are scoped by. A worker process is confined by its role; any other session is
 * confined by the private path scope it was created with (`SessionPrivatePathScope`), never by the process it runs in:
 * a scope denies the private harness roots, a scope with `confinedWrites` also writes as a worker does (inside its
 * working directory or its write roots, never to a harness resource), and a scope with `readRoots` reads only inside them
 * (`readScope`, applied by `wrapToolWithReadScope`). A session with neither keeps host-wide access.
 */
import { resolve } from "node:path";
import type { CapabilityEnvelope } from "./contracts.ts";
import { WORKER_WRITE_SCOPE_GUIDANCE } from "./lane-tool-admission.ts";
import type { SessionReadScope } from "./session-read-scope.ts";
import {
	buildWorkerSessionDefaultWriteScopeEnvelope,
	buildWorkerSessionHarnessWriteEnvelope,
	buildWorkerSessionPrivatePathEnvelope,
	buildWorkerSessionWriteRootsEnvelope,
	type SessionPrivatePathScope,
	WORKER_HARNESS_WRITE_GUIDANCE,
} from "./worker-session-private-scope.ts";

/** What a confined session that answers the owner directly does after a write outside its working directory is refused. */
const OWNER_SESSION_WRITE_SCOPE_GUIDANCE =
	"This session writes only inside its working directory. Do not route around this: finish what is in scope and tell the owner the absolute path you need to write and why.";

/** What a confined session that answers the owner directly does after a write to a harness resource is refused. */
const OWNER_SESSION_HARNESS_WRITE_GUIDANCE =
	"Harness resources (skills, extensions, prompts, settings, hooks, git config) are owner-only for this session. Tell the owner the change you want as a proposal; the owner applies it.";

export interface SessionPathEnvelope {
	readonly envelope: CapabilityEnvelope;
	/** What the refused call is told to do next; none for the private roots, whose refusal names them. */
	readonly guidance?: string;
}

export interface SessionPathEnvelopes {
	/** The private harness roots, denied to reads and writes; its denied paths also guard the process tools. */
	readonly privatePaths?: CapabilityEnvelope;
	/** Every envelope a file tool call is checked against, in order. */
	readonly scopes: readonly SessionPathEnvelope[];
	/** The roots a session with `readRoots` reads in, with its private paths still denied; unset reads host-wide. */
	readonly readScope?: SessionReadScope;
	/**
	 * The roots a session that writes as a worker does writes in: its write roots, else its allowed paths, else its working
	 * directory. Unset writes host-wide. Its confinement and the ceiling it holds over its workers read this one value.
	 */
	readonly writeRoots?: readonly string[];
}

export function buildSessionPathEnvelopes(options: {
	readonly cwd: string;
	readonly agentDir: string;
	/** The process is a worker: its own launch environment names its allowed roots and readable files. */
	readonly workerProcess: boolean;
	readonly scope?: SessionPrivatePathScope;
	/** Paths the session reads although a private root holds them (its own tool-stream run directory). */
	readonly exemptReadPaths: readonly string[];
}): SessionPathEnvelopes {
	const { cwd, agentDir, workerProcess, scope } = options;
	if (!workerProcess && !scope) return { scopes: [] };
	// A worker's allowed roots and readable files come from its launch environment (the builders' defaults).
	const allowedPaths = workerProcess ? undefined : (scope?.allowedPaths ?? []);
	const privatePaths = buildWorkerSessionPrivatePathEnvelope(
		cwd,
		agentDir,
		allowedPaths,
		workerProcess ? undefined : [],
		scope?.deniedPaths,
		options.exemptReadPaths,
	);
	const scopes: SessionPathEnvelope[] = [{ envelope: privatePaths }];
	let writeRoots: readonly string[] | undefined;
	if (workerProcess || scope?.confinedWrites) {
		const writeScope = scope?.writeRoots?.length
			? buildWorkerSessionWriteRootsEnvelope(cwd, scope.writeRoots)
			: buildWorkerSessionDefaultWriteScopeEnvelope(cwd, allowedPaths);
		// Without a write scope of its own the session writes only where its allowed paths confine it.
		writeRoots = (writeScope ?? privatePaths).allowedPaths?.map((root) => resolve(cwd, root));
		if (writeScope)
			scopes.push({
				envelope: writeScope,
				guidance: workerProcess ? WORKER_WRITE_SCOPE_GUIDANCE : OWNER_SESSION_WRITE_SCOPE_GUIDANCE,
			});
		scopes.push({
			envelope: buildWorkerSessionHarnessWriteEnvelope(cwd, agentDir),
			guidance: workerProcess ? WORKER_HARNESS_WRITE_GUIDANCE : OWNER_SESSION_HARNESS_WRITE_GUIDANCE,
		});
	}
	// The session's own tool-stream run directory stays readable: its truncated tool output lives there.
	const readScope = scope?.readRoots && {
		cwd,
		readRoots: [...scope.readRoots.map((root) => resolve(cwd, root)), ...options.exemptReadPaths],
		deniedPaths: privatePaths.deniedPaths ?? [],
		exemptReadPaths: options.exemptReadPaths,
	};
	return { privatePaths, scopes, ...(readScope ? { readScope } : {}), ...(writeRoots ? { writeRoots } : {}) };
}

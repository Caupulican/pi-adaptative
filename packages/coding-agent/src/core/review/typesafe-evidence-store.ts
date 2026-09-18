import { createHash } from "node:crypto";
import { typeSafeEvidenceDir } from "../agent-paths.ts";
import { type ArtifactStore, createFileArtifactStore, isMissingArtifactMarker } from "../context/context-artifacts.ts";
import { withSessionBundleAdmission } from "../orchestration/session-bundle-lifecycle.ts";

export interface TypeSafeEvidenceRef {
	id: string;
	sha256: string;
	bytes: number;
}

export interface TypeSafeEvidencePage {
	id: string;
	sha256: string;
	offset: number;
	totalChars: number;
	text: string;
	nextOffset?: number;
}

class TypeSafeEvidenceUnavailableError extends Error {
	constructor() {
		super("TypeSafe evidence is unavailable");
	}
}

/** Lossless evidence storage, independent of live transcript/detail retention. */
export class TypeSafeEvidenceStore {
	private readonly artifacts: ArtifactStore;
	private readonly admit: <T>(operation: () => T) => T;
	private readonly inherited: readonly TypeSafeEvidenceStore[];

	constructor(
		artifacts: ArtifactStore,
		admit: <T>(operation: () => T) => T = (operation) => operation(),
		inherited: readonly TypeSafeEvidenceStore[] = [],
	) {
		this.artifacts = artifacts;
		this.admit = admit;
		this.inherited = inherited;
	}

	static file(agentDir: string, parentSessionId: string, lineageIds: readonly string[] = []): TypeSafeEvidenceStore {
		return new TypeSafeEvidenceStore(
			createFileArtifactStore({ baseDir: typeSafeEvidenceDir(agentDir, parentSessionId) }),
			(operation) => withSessionBundleAdmission(agentDir, parentSessionId, operation),
			[...new Set(lineageIds)]
				.filter((id) => id !== parentSessionId)
				.map((id) => TypeSafeEvidenceStore.file(agentDir, id)),
		);
	}

	save(toolCallId: string, record: Record<string, unknown>): TypeSafeEvidenceRef {
		return this.admit(() => {
			const content = JSON.stringify({ version: 1, toolCallId, record });
			const sha256 = createHash("sha256").update(content).digest("hex");
			const stored = this.artifacts.write({
				kind: "tool_output",
				toolName: "typesafe_review",
				command: sha256,
				content,
				createdAtTurn: 0,
				reproducible: false,
			});
			if (
				stored.content !== content ||
				stored.ref.command !== sha256 ||
				!this.artifacts.addReference(stored.ref.id, `typesafe:${stored.ref.id}`)
			) {
				throw new Error("TypeSafe evidence could not be retained");
			}
			return { id: stored.ref.id, sha256, bytes: Buffer.byteLength(content) };
		});
	}

	/** Every character is reachable by continuation; paging changes projection, never stored evidence. */
	read(id: string, offset = 0): TypeSafeEvidencePage {
		if (!/^[a-f0-9]{24}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0)
			throw new Error("Invalid TypeSafe evidence reference or offset");
		try {
			return this.admit(() => {
				const stored = this.artifacts.read(id);
				if (isMissingArtifactMarker(stored)) {
					if (stored.reason === "unavailable") throw new Error("TypeSafe evidence could not be read");
					throw new TypeSafeEvidenceUnavailableError();
				}
				const sha256 = createHash("sha256").update(stored.content).digest("hex");
				if (stored.ref.command !== sha256 || offset > stored.content.length)
					throw new Error("TypeSafe evidence integrity or offset check failed");
				const end = Math.min(stored.content.length, offset + 8_192);
				return {
					id,
					sha256,
					offset,
					totalChars: stored.content.length,
					text: stored.content.slice(offset, end),
					...(end < stored.content.length ? { nextOffset: end } : {}),
				};
			});
		} catch (error) {
			if (!(error instanceof TypeSafeEvidenceUnavailableError)) throw error;
		}
		// The current lock has been released. Never nest two session-bundle locks;
		// lineage comes from SessionManager, never an agent-supplied session identifier.
		for (const ancestor of this.inherited) {
			try {
				return ancestor.read(id, offset);
			} catch (error) {
				if (!(error instanceof TypeSafeEvidenceUnavailableError)) throw error;
			}
		}
		throw new TypeSafeEvidenceUnavailableError();
	}
}

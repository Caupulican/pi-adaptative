import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import { isMissingArtifactMarker } from "../context/context-artifacts.ts";
import { type CredentialExposureBoundary, isProtectedCredentialPath } from "../secrets/credential-exposure-guard.ts";

export const MAX_TYPESAFE_EVIDENCE_SOURCE_BYTES = 512 * 1024;
export const MAX_TYPESAFE_REFERENCED_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_TYPESAFE_EVIDENCE_REFERENCES = 16;

export const typeSafeEvidenceReferenceSchema = Type.String();
export type TypeSafeEvidenceReferenceInput = Static<typeof typeSafeEvidenceReferenceSchema>;
type TypeSafeEvidenceReference =
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "artifact"; readonly id: string }
	| { readonly kind: "git_diff"; readonly paths: readonly string[]; readonly staged?: boolean };

export interface TypeSafeMaterializedSource {
	readonly id: string;
	readonly kind: TypeSafeEvidenceReference["kind"];
	readonly label: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly redacted: boolean;
	readonly content: string;
}

export interface TypeSafeEvidenceManifestEntry {
	readonly id: string;
	readonly kind: TypeSafeEvidenceReference["kind"];
	readonly label: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly redacted: boolean;
	readonly canonicalPath?: string;
	readonly canonicalPaths?: readonly string[];
	readonly artifactId?: string;
}

export interface TypeSafeMaterializedEvidence {
	readonly state: {
		readonly schema_version: "1.0";
		readonly sources: readonly TypeSafeMaterializedSource[];
	};
	readonly manifest: readonly TypeSafeEvidenceManifestEntry[];
}

export interface TypeSafeEvidenceMaterializerDeps {
	getCwd(): string;
	artifactStore?: ArtifactStore;
	credentialBoundary?: CredentialExposureBoundary;
}

interface RawSource {
	kind: TypeSafeEvidenceReference["kind"];
	label: string;
	content: string;
	sha256: string;
	bytes: number;
	canonicalPath?: string;
	canonicalPaths?: readonly string[];
	artifactId?: string;
}

function digest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function readBoundedFile(path: string): { content: string; sha256: string; bytes: number } {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) throw new Error("System One evidence source is not a regular file");
		if (stat.size > MAX_TYPESAFE_EVIDENCE_SOURCE_BYTES) throw new Error("System One evidence source exceeds 512 KiB");
		const buffer = Buffer.allocUnsafe(MAX_TYPESAFE_EVIDENCE_SOURCE_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		if (offset > MAX_TYPESAFE_EVIDENCE_SOURCE_BYTES) throw new Error("System One evidence source exceeds 512 KiB");
		const snapshot = buffer.subarray(0, offset);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
		} catch {
			throw new Error("TypeSafe file evidence must be UTF-8 text");
		}
		return { content, sha256: createHash("sha256").update(snapshot).digest("hex"), bytes: offset };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function runGitDiff(cwd: string, paths: readonly string[], staged: boolean, signal?: AbortSignal): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			["diff", "--no-ext-diff", "--no-color", ...(staged ? ["--cached"] : []), "--", ...paths],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: MAX_TYPESAFE_EVIDENCE_SOURCE_BYTES,
				windowsHide: true,
				...(signal ? { signal } : {}),
			},
			(error, stdout) => {
				if (error) {
					if (signal?.aborted) reject(signal.reason ?? error);
					else if (error.message.includes("maxBuffer"))
						reject(new Error("TypeSafe git diff evidence exceeds 512 KiB"));
					else reject(new Error("TypeSafe git diff evidence could not be read"));
					return;
				}
				resolvePromise(stdout);
			},
		);
	});
}

function normalizeReference(reference: TypeSafeEvidenceReferenceInput): TypeSafeEvidenceReference {
	const schemes = ["git-diff-staged:", "git-diff:", "artifact:", "file:"] as const;
	const scheme = schemes.find((candidate) => reference.startsWith(candidate));
	const value = scheme ? reference.slice(scheme.length) : "";
	if (!scheme || !value.trim())
		throw new Error("System One evidence reference requires file:, artifact:, git-diff:, or git-diff-staged:");
	if (scheme === "file:") return { kind: "file", path: value };
	if (scheme === "artifact:") return { kind: "artifact", id: value };
	return { kind: "git_diff", paths: [value], ...(scheme === "git-diff-staged:" ? { staged: true } : {}) };
}

/** Host-owned evidence acquisition. The model names references; this owner resolves and snapshots them. */
export class TypeSafeEvidenceMaterializer {
	private readonly deps: TypeSafeEvidenceMaterializerDeps;

	constructor(deps: TypeSafeEvidenceMaterializerDeps) {
		this.deps = deps;
	}

	private canonicalFile(rawPath: string, cwd: string): string {
		const canonical = safeRealpathSync(resolve(cwd, rawPath));
		if (!isPathWithinScope(canonical, cwd))
			throw new Error(`System One evidence path is outside the task directory: ${rawPath}`);
		if (isProtectedCredentialPath(canonical, cwd, this.deps.credentialBoundary))
			throw new Error(`System One evidence path is a protected credential file: ${rawPath}`);
		return canonical;
	}

	private async rawSource(
		reference: TypeSafeEvidenceReference,
		cwd: string,
		signal?: AbortSignal,
	): Promise<RawSource> {
		signal?.throwIfAborted();
		if (reference.kind === "file") {
			const canonicalPath = this.canonicalFile(reference.path, cwd);
			const snapshot = readBoundedFile(canonicalPath);
			return {
				kind: reference.kind,
				label: relative(cwd, canonicalPath).split(sep).join("/") || ".",
				...snapshot,
				canonicalPath,
			};
		}
		if (reference.kind === "artifact") {
			const artifactId = reference.id.startsWith("tool-output:")
				? reference.id.slice("tool-output:".length)
				: reference.id;
			if (!/^[a-f0-9]{24}$/u.test(artifactId)) throw new Error("Invalid TypeSafe artifact evidence id");
			const stored = this.deps.artifactStore?.read(artifactId);
			if (!stored || isMissingArtifactMarker(stored))
				throw new Error(`TypeSafe artifact evidence is not available: ${artifactId}`);
			if (stored.ref.path && isProtectedCredentialPath(stored.ref.path, cwd, this.deps.credentialBoundary))
				throw new Error(`TypeSafe artifact evidence names a protected credential file: ${artifactId}`);
			if (Buffer.byteLength(stored.content) > MAX_TYPESAFE_EVIDENCE_SOURCE_BYTES)
				throw new Error("System One evidence source exceeds 512 KiB");
			return {
				kind: reference.kind,
				label: `${stored.ref.toolName ?? stored.ref.kind}:${artifactId}`,
				content: stored.content,
				sha256: digest(stored.content),
				bytes: Buffer.byteLength(stored.content),
				artifactId,
			};
		}
		if (reference.paths.length === 0) throw new Error("TypeSafe git diff evidence requires at least one path");
		const canonicalPaths = reference.paths.map((path) => this.canonicalFile(path, cwd));
		const relativePaths = canonicalPaths.map((path) => relative(cwd, path).split(sep).join("/"));
		const content = await runGitDiff(cwd, relativePaths, reference.staged === true, signal);
		return {
			kind: reference.kind,
			label: `${reference.staged ? "staged" : "working-tree"} diff: ${relativePaths.join(", ")}`,
			content,
			sha256: digest(content),
			bytes: Buffer.byteLength(content),
			canonicalPaths,
		};
	}

	async materialize(
		references: readonly TypeSafeEvidenceReferenceInput[],
		signal?: AbortSignal,
	): Promise<TypeSafeMaterializedEvidence> {
		if (references.length === 0 || references.length > MAX_TYPESAFE_EVIDENCE_REFERENCES)
			throw new Error(`System One evidence requires from 1 through ${MAX_TYPESAFE_EVIDENCE_REFERENCES} references`);
		const cwd = safeRealpathSync(this.deps.getCwd());
		const sensitiveValues = (await this.deps.credentialBoundary?.getSensitiveValues?.()) ?? [];
		const redact =
			this.deps.credentialBoundary?.createSensitiveTextRedactor?.(sensitiveValues) ??
			((text: string) => this.deps.credentialBoundary?.redactSensitiveText(text, sensitiveValues) ?? text);
		const sources: TypeSafeMaterializedSource[] = [];
		const manifest: TypeSafeEvidenceManifestEntry[] = [];
		let totalSourceBytes = 0;
		let totalSubmittedBytes = 0;
		for (let index = 0; index < references.length; index++) {
			const raw = await this.rawSource(normalizeReference(references[index]), cwd, signal);
			totalSourceBytes += raw.bytes;
			if (totalSourceBytes > MAX_TYPESAFE_REFERENCED_EVIDENCE_BYTES)
				throw new Error("System One referenced evidence exceeds 1 MiB");
			const content = redact(raw.content);
			const submittedBytes = Buffer.byteLength(content);
			if (submittedBytes > MAX_TYPESAFE_EVIDENCE_SOURCE_BYTES)
				throw new Error("Redacted System One evidence source exceeds 512 KiB");
			totalSubmittedBytes += submittedBytes;
			if (totalSubmittedBytes > MAX_TYPESAFE_REFERENCED_EVIDENCE_BYTES)
				throw new Error("Redacted System One referenced evidence exceeds 1 MiB");
			const common = {
				id: `source-${index + 1}`,
				kind: raw.kind,
				label: raw.label,
				redacted: content !== raw.content,
			};
			sources.push({ ...common, sha256: digest(content), bytes: submittedBytes, content });
			manifest.push({
				...common,
				sha256: raw.sha256,
				bytes: raw.bytes,
				...(raw.canonicalPath ? { canonicalPath: raw.canonicalPath } : {}),
				...(raw.canonicalPaths ? { canonicalPaths: raw.canonicalPaths } : {}),
				...(raw.artifactId ? { artifactId: raw.artifactId } : {}),
			});
		}
		return { state: { schema_version: "1.0", sources }, manifest };
	}
}

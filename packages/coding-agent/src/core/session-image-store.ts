import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ImageContent } from "@caupulican/pi-ai";
import { attachmentsDir } from "./agent-paths.ts";

const FILE_PREFIX = "pi-clip";
const MAX_SCANNED_ENTRIES = 10_000;
const MAX_STORED_FILES = 512;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SEQUENCE = 999_999;
const FILE_PATTERN = /^pi-clip-([0-9a-f]{16})-(\d{6})-([0-9a-f]{12})\.(png|jpg|webp|gif)$/;

export interface StoredSessionImage {
	readonly sequence: number;
	readonly path: string;
	readonly mimeType: string;
	readonly bytes: Uint8Array;
}

export interface SessionImageStoreOptions {
	agentDir: string;
	cwd: string;
	sessionId: string;
	directory?: string;
	now?: () => number;
}

interface StoredImageEntry {
	path: string;
	sessionKey: string;
	sequence: number;
	digest: string;
	mimeType: string;
	bytes: number;
	mtimeMs: number;
}

interface StoreScan {
	entries: StoredImageEntry[];
	complete: boolean;
}

function extensionForMimeType(mimeType: string): "png" | "jpg" | "webp" | "gif" {
	switch (mimeType.split(";", 1)[0]?.trim().toLowerCase()) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}

function mimeTypeForExtension(extension: string): string {
	switch (extension) {
		case "jpg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

function resolveConfiguredDirectory(directory: string, cwd: string): string {
	const trimmed = directory.trim();
	const expanded = trimmed === "~" ? homedir() : trimmed.replace(/^~(?=[/\\])/, homedir());
	return resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

export function resolveSessionImageDirectory(options: SessionImageStoreOptions): string {
	return options.directory?.trim()
		? resolveConfiguredDirectory(options.directory, options.cwd)
		: attachmentsDir(options.agentDir);
}

export class SessionImageStore {
	readonly directory: string;
	private readonly sessionKey: string;
	private readonly now: () => number;

	constructor(options: SessionImageStoreOptions) {
		this.directory = resolveSessionImageDirectory(options);
		this.sessionKey = createHash("sha256").update(options.sessionId).digest("hex").slice(0, 16);
		this.now = options.now ?? Date.now;
	}

	/** Validate and durably retain provider-neutral image content, reusing its claimed sequence only
	 * when that sequence already contains the exact same bytes and normalized MIME type. */
	retainContent(content: ImageContent, preferredSequence?: number): StoredSessionImage {
		const compactBase64 = content.data.trim();
		if (!/^image\/(?:png|jpeg|webp|gif)(?:;|$)/iu.test(content.mimeType.trim())) {
			throw new Error(`Unsupported image MIME type: ${content.mimeType}`);
		}
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compactBase64) || compactBase64.length % 4 === 1) {
			throw new Error("Image content is not valid base64");
		}
		const bytes = Buffer.from(compactBase64, "base64");
		if (bytes.toString("base64").replace(/=+$/u, "") !== compactBase64.replace(/=+$/u, "")) {
			throw new Error("Image content is not canonical base64");
		}
		const normalizedMimeType = mimeTypeForExtension(extensionForMimeType(content.mimeType));
		if (preferredSequence !== undefined) {
			const existing = this.read(preferredSequence);
			if (existing && existing.mimeType === normalizedMimeType && Buffer.from(existing.bytes).equals(bytes)) {
				return existing;
			}
		}
		return this.write(bytes, normalizedMimeType);
	}

	write(bytes: Uint8Array, mimeType: string): StoredSessionImage {
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new Error(`Clipboard image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
		}
		mkdirSync(this.directory, { recursive: true });
		const directoryStats = lstatSync(this.directory);
		if (!directoryStats.isDirectory()) {
			throw new Error(`Attachment path is not a directory: ${this.directory}`);
		}

		const before = this.scan();
		if (!before.complete) {
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		}
		let sequence = Math.max(
			0,
			...before.entries.filter((entry) => entry.sessionKey === this.sessionKey).map((entry) => entry.sequence),
		);
		const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
		const extension = extensionForMimeType(mimeType);
		let path = "";
		let written = false;
		while (sequence < MAX_SEQUENCE) {
			sequence++;
			path = resolve(
				this.directory,
				`${FILE_PREFIX}-${this.sessionKey}-${String(sequence).padStart(6, "0")}-${digest}.${extension}`,
			);
			try {
				writeFileSync(path, bytes, { flag: "wx" });
				written = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		if (!written) {
			throw new Error("Clipboard image sequence is exhausted");
		}

		try {
			this.prune(path);
		} catch (error) {
			try {
				unlinkSync(path);
			} catch {}
			throw error;
		}
		return { sequence, path, mimeType: mimeTypeForExtension(extension), bytes: new Uint8Array(bytes) };
	}

	read(sequence: number): StoredSessionImage | undefined {
		if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) return undefined;
		const scan = this.scan();
		if (!scan.complete) return undefined;
		const entry = scan.entries.find(
			(candidate) => candidate.sessionKey === this.sessionKey && candidate.sequence === sequence,
		);
		return entry ? this.readEntry(entry) : undefined;
	}

	readLatest(): StoredSessionImage | undefined {
		const scan = this.scan();
		if (!scan.complete) return undefined;
		const entries = scan.entries
			.filter((entry) => entry.sessionKey === this.sessionKey)
			.sort((left, right) => right.sequence - left.sequence);
		for (const entry of entries) {
			const image = this.readEntry(entry);
			if (image) return image;
		}
		return undefined;
	}

	resolveReferences(text: string): ImageContent[] {
		try {
			const explicitSequences: number[] = [];
			const explicitPattern = /(?:\[\s*)?(?:image|screenshot|picture|photo)\s*#?\s*(\d{1,6})(?:\s*\])?/gi;
			for (const match of text.matchAll(explicitPattern)) {
				const sequence = Number(match[1]);
				if (!explicitSequences.includes(sequence)) explicitSequences.push(sequence);
			}

			const resolved = explicitSequences
				.map((sequence) => this.read(sequence))
				.filter((image): image is StoredSessionImage => image !== undefined);
			if (resolved.length === 0 && this.referencesLatestImage(text)) {
				const latest = this.readLatest();
				if (latest) resolved.push(latest);
			}
			return resolved.map((image) => ({
				type: "image",
				data: Buffer.from(image.bytes).toString("base64"),
				mimeType: image.mimeType,
			}));
		} catch {
			return [];
		}
	}

	private referencesLatestImage(text: string): boolean {
		return (
			/\b(?:the|this|that|latest|last|pasted|attached|clipboard)\s+(?:image|screenshot|picture|photo)\b/i.test(
				text,
			) ||
			/\b(?:look at|inspect|review|describe|analy[sz]e|check)\s+(?:(?:the|this|that|latest|last|pasted|attached|clipboard)\s+)?(?:image|screenshot|picture|photo)\b/i.test(
				text,
			)
		);
	}

	private readEntry(entry: StoredImageEntry): StoredSessionImage | undefined {
		try {
			const stats = lstatSync(entry.path);
			if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_IMAGE_BYTES)
				return undefined;
			const bytes = readFileSync(entry.path);
			const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
			if (digest !== entry.digest) return undefined;
			return {
				sequence: entry.sequence,
				path: entry.path,
				mimeType: entry.mimeType,
				bytes: new Uint8Array(bytes),
			};
		} catch {
			return undefined;
		}
	}

	private scan(): StoreScan {
		if (!existsSync(this.directory)) return { entries: [], complete: true };
		const entries: StoredImageEntry[] = [];
		let scanned = 0;
		let complete = true;
		const handle = opendirSync(this.directory);
		try {
			while (true) {
				const directoryEntry = handle.readSync();
				if (!directoryEntry) break;
				if (scanned >= MAX_SCANNED_ENTRIES) {
					complete = false;
					break;
				}
				scanned++;
				if (!directoryEntry.isFile() || directoryEntry.isSymbolicLink()) continue;
				const match = FILE_PATTERN.exec(directoryEntry.name);
				if (!match) continue;
				const path = resolve(this.directory, directoryEntry.name);
				try {
					const stats = lstatSync(path);
					if (!stats.isFile() || stats.isSymbolicLink()) continue;
					entries.push({
						path,
						sessionKey: match[1]!,
						sequence: Number(match[2]),
						digest: match[3]!,
						mimeType: mimeTypeForExtension(match[4]!),
						bytes: stats.size,
						mtimeMs: stats.mtimeMs,
					});
				} catch {}
			}
		} finally {
			handle.closeSync();
		}
		return { entries, complete };
	}

	private prune(protectedPath: string): void {
		const scan = this.scan();
		if (!scan.complete) {
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		}
		const now = this.now();
		for (const entry of scan.entries) {
			if (entry.path !== protectedPath && now - entry.mtimeMs > MAX_AGE_MS) {
				try {
					unlinkSync(entry.path);
				} catch {}
			}
		}

		const retained = this.scan();
		if (!retained.complete) {
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		}
		const oldestFirst = retained.entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
		let totalBytes = oldestFirst.reduce((total, entry) => total + entry.bytes, 0);
		let totalFiles = oldestFirst.length;
		for (const entry of oldestFirst) {
			if (totalFiles <= MAX_STORED_FILES && totalBytes <= MAX_TOTAL_BYTES) break;
			if (entry.path === protectedPath) continue;
			try {
				unlinkSync(entry.path);
				totalFiles--;
				totalBytes -= entry.bytes;
			} catch {}
		}
		if (totalFiles > MAX_STORED_FILES || totalBytes > MAX_TOTAL_BYTES) {
			throw new Error("Attachment retention bounds could not be enforced");
		}
	}
}

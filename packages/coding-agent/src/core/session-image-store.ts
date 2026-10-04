import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ImageContent } from "@caupulican/pi-ai";
import { attachmentsDir } from "./agent-paths.ts";

const FILE_PREFIX = "pi-clip";
const MAX_SCANNED_ENTRIES = 10_000;
const MAX_STORED_FILES = 512;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A pin is a sidecar file next to a stored image; a pinned image is exempt from pruning while its pin is fresh. */
const PIN_SUFFIX = ".pin";
/** A pin never outlives this since its last refresh, so an abandoned session cannot hold images forever. */
const MAX_PIN_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Pins hold images outside the retention budget, so the held bytes are bounded on their own. */
const MAX_PINNED_BYTES = 256 * 1024 * 1024;
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
	/** A fresh pin holds this image: pruning never deletes it and its size is outside the retention budget. */
	pinned: boolean;
}

interface StoredPin {
	path: string;
	mtimeMs: number;
}

interface StoreScan {
	entries: StoredImageEntry[];
	/** Pin sidecars by the file name of the image they hold. */
	pins: Map<string, StoredPin>;
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

	/**
	 * Hold this session's images with these sequences against pruning, durably (a sidecar file per image, so
	 * the hold survives a restart and applies to every process that prunes the shared directory). Refreshes
	 * an existing pin. Returns the sequences that could not be held because the image is no longer stored.
	 */
	pin(sequences: readonly number[]): number[] {
		if (sequences.length === 0) return [];
		const scan = this.scan();
		if (!scan.complete)
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		const missing: number[] = [];
		let pinnedBytes = scan.entries.reduce((total, candidate) => total + (candidate.pinned ? candidate.bytes : 0), 0);
		for (const sequence of new Set(sequences)) {
			const entry = scan.entries.find(
				(candidate) => candidate.sessionKey === this.sessionKey && candidate.sequence === sequence,
			);
			// An image beyond the pinned-bytes bound is reported like a missing one: the restore notice names
			// it, and the owner's queued text is never lost over an attachment.
			if (!entry || (!entry.pinned && pinnedBytes + entry.bytes > MAX_PINNED_BYTES)) {
				missing.push(sequence);
				continue;
			}
			if (!entry.pinned) pinnedBytes += entry.bytes;
			writeFileSync(`${entry.path}${PIN_SUFFIX}`, "", { flag: "w" });
		}
		return missing;
	}

	/** Release every pin this session holds except the given sequences; released images become ordinary prunable files. */
	unpinExcept(keep: readonly number[]): void {
		const scan = this.scan();
		const kept = new Set(keep);
		for (const entry of scan.entries) {
			if (entry.sessionKey !== this.sessionKey || kept.has(entry.sequence)) continue;
			const pin = scan.pins.get(basename(entry.path));
			if (!pin) continue;
			try {
				unlinkSync(pin.path);
			} catch {}
		}
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
		if (!existsSync(this.directory)) return { entries: [], pins: new Map(), complete: true };
		const entries: StoredImageEntry[] = [];
		const pins = new Map<string, StoredPin>();
		const now = this.now();
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
				if (directoryEntry.name.endsWith(PIN_SUFFIX)) {
					const imageName = directoryEntry.name.slice(0, -PIN_SUFFIX.length);
					if (!FILE_PATTERN.test(imageName)) continue;
					const pinPath = resolve(this.directory, directoryEntry.name);
					try {
						const stats = lstatSync(pinPath);
						if (stats.isFile() && !stats.isSymbolicLink())
							pins.set(imageName, { path: pinPath, mtimeMs: stats.mtimeMs });
					} catch {}
					continue;
				}
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
						pinned: false,
					});
				} catch {}
			}
		} finally {
			handle.closeSync();
		}
		for (const entry of entries) {
			const pin = pins.get(basename(entry.path));
			entry.pinned = pin !== undefined && now - pin.mtimeMs <= MAX_PIN_AGE_MS;
		}
		return { entries, pins, complete };
	}

	private prune(protectedPath: string): void {
		const scan = this.scan();
		if (!scan.complete) {
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		}
		const now = this.now();
		for (const entry of scan.entries) {
			if (entry.path !== protectedPath && !entry.pinned && now - entry.mtimeMs > MAX_AGE_MS) {
				try {
					unlinkSync(entry.path);
				} catch {}
			}
		}
		// A pin whose image is gone or whose last refresh is too old holds nothing: remove it.
		const stored = new Set(scan.entries.map((entry) => basename(entry.path)));
		for (const [imageName, pin] of scan.pins) {
			if (stored.has(imageName) && now - pin.mtimeMs <= MAX_PIN_AGE_MS) continue;
			try {
				unlinkSync(pin.path);
			} catch {}
		}

		const retained = this.scan();
		if (!retained.complete) {
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		}
		// Pinned images are held by a live queued input and sit outside the budget (their count is bounded by
		// the queued record), so only the remaining files compete for it.
		const oldestFirst = retained.entries
			.filter((entry) => !entry.pinned)
			.sort((left, right) => left.mtimeMs - right.mtimeMs);
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

import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ImageContent } from "@caupulican/pi-ai";
import { attachmentsDir } from "./agent-paths.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "./util/atomic-file.ts";
import { isPlainRecord } from "./util/value-guards.ts";

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
const CLAIM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_FILE_PATTERN = /^pi-pin-([0-9a-f]{16})-([0-9a-f-]{36})\.json$/;
const MAX_CLAIM_BYTES = 128 * 1024;
const MAX_CLAIM_IMAGES = 128;

export function isImagePinClaimId(value: unknown): value is string {
	return typeof value === "string" && CLAIM_ID_PATTERN.test(value);
}

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
	claims: Map<string, StoredImageClaim>;
	complete: boolean;
	entryCount: number;
}

interface StoredImageClaim {
	path: string;
	images: string[];
	sealed: boolean;
	mtimeMs: number;
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

	/** Directory-wide: pruning and the pin-byte budget are shared by every session here. */
	private withStoreLock<T>(operation: () => T): T {
		mkdirSync(this.directory, { recursive: true });
		if (!lstatSync(this.directory).isDirectory())
			throw new Error(`Attachment path is not a directory: ${this.directory}`);
		return withFileLockSync(resolve(this.directory, ".image-store"), operation, { retries: 0 });
	}

	/** Validate and durably retain provider-neutral image content, reusing its claimed sequence only
	 * when that sequence already contains the exact same bytes and normalized MIME type. */
	retainContent(content: ImageContent, preferredSequence?: number): StoredSessionImage {
		return this.withStoreLock(() => this.retainContentLocked(content, preferredSequence));
	}

	private retainContentLocked(content: ImageContent, preferredSequence?: number): StoredSessionImage {
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
			const existing = this.readStored(preferredSequence);
			if (existing && existing.mimeType === normalizedMimeType && Buffer.from(existing.bytes).equals(bytes)) {
				return existing;
			}
		}
		return this.writeLocked(bytes, normalizedMimeType);
	}

	write(bytes: Uint8Array, mimeType: string): StoredSessionImage {
		return this.withStoreLock(() => this.writeLocked(bytes, mimeType));
	}

	private writeLocked(bytes: Uint8Array, mimeType: string): StoredSessionImage {
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new Error(`Clipboard image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`);
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
	 * Refresh a published claim without changing membership, or legacy sidecars for an older record.
	 * Returns sequences refused because their exact image is absent or the shared byte budget is full.
	 */
	pin(sequences: readonly number[], claimId?: string): number[] {
		return this.withStoreLock(() => this.pinLocked(sequences, claimId));
	}

	private pinLocked(sequences: readonly number[], claimId?: string, preparing = false, exactName?: string): number[] {
		if (sequences.length === 0) return [];
		const scan = this.scan();
		if (!scan.complete)
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		const missing: number[] = [];
		const claimPath = claimId === undefined ? undefined : this.claimPath(claimId);
		const existingClaim = claimPath === undefined ? undefined : scan.claims.get(claimPath);
		if (preparing && existingClaim?.sealed) throw new Error("A published image pin claim is immutable.");
		const claimed = new Set(existingClaim?.images ?? []);
		let pinnedBytes = scan.entries.reduce((total, candidate) => total + (candidate.pinned ? candidate.bytes : 0), 0);
		let entryCount = scan.entryCount;
		if (claimPath !== undefined && !preparing) {
			if (!existingClaim?.sealed) return [...new Set(sequences)];
			const held = scan.entries.filter((entry) => claimed.has(basename(entry.path)));
			const addedBytes = held.reduce((total, entry) => total + (entry.pinned ? 0 : entry.bytes), 0);
			if (pinnedBytes + addedBytes > MAX_PINNED_BYTES) return [...new Set(sequences)];
			this.writeClaim(claimPath, existingClaim.images, true);
			return [...new Set(sequences)].filter(
				(sequence) => this.findEntry(scan, sequence, existingClaim) === undefined,
			);
		}
		for (const sequence of new Set(sequences)) {
			const entry =
				exactName === undefined
					? this.findEntry(scan, sequence)
					: scan.entries.find(
							(candidate) => basename(candidate.path) === exactName && candidate.sequence === sequence,
						);
			// Refusal is explicit even when the bytes remain readable; restore reports pin loss separately.
			if (!entry || (!entry.pinned && pinnedBytes + entry.bytes > MAX_PINNED_BYTES)) {
				missing.push(sequence);
				continue;
			}
			if (claimPath === undefined) {
				const newSidecar = !scan.pins.has(basename(entry.path));
				if (newSidecar && entryCount >= MAX_SCANNED_ENTRIES) {
					missing.push(sequence);
					continue;
				}
				writeFileSync(`${entry.path}${PIN_SUFFIX}`, "", { flag: "w" });
				if (newSidecar) entryCount++;
			} else {
				if (
					[...claimed].some(
						(name) => Number(FILE_PATTERN.exec(name)![2]) === sequence && name !== basename(entry.path),
					)
				)
					throw new Error(`Image pin claim already holds a different attachment at sequence ${sequence}.`);
				claimed.add(basename(entry.path));
			}
			if (!entry.pinned) pinnedBytes += entry.bytes;
		}
		if (claimPath !== undefined && (claimed.size > 0 || existingClaim)) {
			if (!existingClaim && scan.entryCount >= MAX_SCANNED_ENTRIES)
				throw new Error("Attachment directory has no room for an image pin claim.");
			this.writeClaim(claimPath, [...claimed], !preparing);
		}
		return missing;
	}

	/** Retain and pin before another writer may prune. The caller owns this unpublished claim. */
	retainPinnedContent(claimId: string, content: ImageContent, preferredSequence?: number): StoredSessionImage {
		return this.withStoreLock(() => {
			this.claimPath(claimId);
			const stored = this.retainContentLocked(content, preferredSequence);
			if (this.pinLocked([stored.sequence], claimId, true).length > 0)
				throw new Error(`Queued image ${stored.sequence} could not be pinned within the attachment budget.`);
			return stored;
		});
	}

	/** Seal membership before publishing a record that names the claim. */
	sealPinClaim(claimId: string): void {
		this.withStoreLock(() => {
			const path = this.claimPath(claimId);
			const claim = this.readClaim(path, this.sessionKey);
			if (!claim) throw new Error("Queued image pin claim is missing.");
			this.writeClaim(path, claim.images, true);
		});
	}

	/** Release only this publication's claim; other records' pins are independent. */
	releasePinClaim(claimId: string): void {
		this.withStoreLock(() => {
			const path = this.claimPath(claimId);
			// Validate existing bytes before deletion, including session and exact image names.
			if (!this.readClaim(path, this.sessionKey)) return;
			try {
				unlinkSync(path);
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
		});
	}

	private claimPath(claimId: string): string {
		if (!CLAIM_ID_PATTERN.test(claimId)) throw new Error("Invalid image pin claim identity.");
		return resolve(this.directory, `pi-pin-${this.sessionKey}-${claimId}.json`);
	}

	private writeClaim(path: string, images: string[], sealed: boolean): void {
		if (images.length > MAX_CLAIM_IMAGES) throw new Error("Image pin claim exceeds its reference bound.");
		writeFileAtomicSync(path, JSON.stringify({ version: 1, images, sealed }));
	}

	private readClaim(path: string, sessionKey: string): StoredImageClaim | undefined {
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CLAIM_BYTES)
			throw new Error("Invalid image pin claim file or byte bound.");
		const descriptor = openSync(path, "r");
		let value: unknown;
		try {
			const opened = fstatSync(descriptor);
			if (!opened.isFile() || opened.size > MAX_CLAIM_BYTES || opened.ino !== stats.ino || opened.dev !== stats.dev)
				throw new Error("Image pin claim changed while opening it.");
			const bytes = Buffer.alloc(MAX_CLAIM_BYTES + 1);
			let size = 0;
			while (size < bytes.length) {
				const count = readSync(descriptor, bytes, size, bytes.length - size, size);
				if (count === 0) break;
				size += count;
			}
			if (size > MAX_CLAIM_BYTES) throw new Error("Image pin claim exceeds its byte bound.");
			value = JSON.parse(bytes.toString("utf8", 0, size));
		} finally {
			closeSync(descriptor);
		}
		if (
			!isPlainRecord(value) ||
			value.version !== 1 ||
			typeof value.sealed !== "boolean" ||
			!Array.isArray(value.images) ||
			value.images.length > MAX_CLAIM_IMAGES ||
			!value.images.every((name) => typeof name === "string" && FILE_PATTERN.exec(name)?.[1] === sessionKey) ||
			new Set(value.images).size !== value.images.length ||
			new Set(value.images.map((name) => FILE_PATTERN.exec(name)![2])).size !== value.images.length
		)
			throw new Error("Malformed image pin claim.");
		return { path, images: value.images, sealed: value.sealed, mtimeMs: stats.mtimeMs };
	}

	private findEntry(scan: StoreScan, sequence: number, claim?: StoredImageClaim): StoredImageEntry | undefined {
		const matches = scan.entries.filter(
			(entry) =>
				entry.sessionKey === this.sessionKey &&
				entry.sequence === sequence &&
				(claim === undefined || claim.images.includes(basename(entry.path))),
		);
		if (matches.length > 1) throw new Error(`Attachment sequence ${sequence} is ambiguous.`);
		return matches[0];
	}

	/** Preserve an unreadable attachment's exact durable identity during record replacement. */
	retainPinnedReference(
		claimId: string,
		sequence: number,
		mimeType: string,
		name?: string,
		sourceClaimId?: string,
	): { sequence: number; mimeType: string; name: string } {
		return this.withStoreLock(() => {
			const scan = this.scan();
			if (!scan.complete) throw new Error("Attachment directory exceeds its inspection bound.");
			if (name === undefined) {
				const sourceClaim =
					sourceClaimId === undefined ? undefined : scan.claims.get(this.claimPath(sourceClaimId));
				if (sourceClaimId !== undefined && !sourceClaim)
					throw new Error("Restored image pin claim is unavailable.");
				const source = this.findEntry(scan, sequence, sourceClaim);
				if (source) name = basename(source.path);
			}
			if (name === undefined) throw new Error("Restored image identity is unavailable.");
			const reference = this.exactReference(name, sequence);
			if (reference.mimeType !== mimeType) throw new Error("Restored image MIME type does not match its identity.");
			const entry = scan.entries.find((candidate) => candidate.path === reference.path);
			if (!entry || entry.bytes < 1 || entry.bytes > MAX_IMAGE_BYTES)
				throw new Error("Restored image is unavailable.");
			if (this.pinLocked([sequence], claimId, true, name).length > 0)
				throw new Error("Restored image could not be pinned.");
			return { sequence: entry.sequence, mimeType: entry.mimeType, name };
		});
	}

	private exactReference(
		name: string,
		sequence: number,
	): Pick<StoredImageEntry, "path" | "sequence" | "mimeType" | "digest"> {
		const match = FILE_PATTERN.exec(name);
		if (!match || match[1] !== this.sessionKey || Number(match[2]) !== sequence || sequence < 1)
			throw new Error("Invalid exact attachment identity.");
		return {
			path: resolve(this.directory, name),
			sequence,
			mimeType: mimeTypeForExtension(match[4]!),
			digest: match[3]!,
		};
	}

	/** Release legacy sidecars except the given sequences. Publication claims have independent ownership. */
	unpinExcept(keep: readonly number[]): void {
		this.withStoreLock(() => this.unpinExceptLocked(keep));
	}

	private unpinExceptLocked(keep: readonly number[]): void {
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

	read(sequence: number, claimId?: string, name?: string): StoredSessionImage | undefined {
		return this.readStored(sequence, claimId, name);
	}

	private readStored(sequence: number, claimId?: string, exactName?: string): StoredSessionImage | undefined {
		if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) return undefined;
		if (exactName !== undefined) return this.readEntry(this.exactReference(exactName, sequence));
		if (claimId !== undefined) {
			const claim = this.readClaim(this.claimPath(claimId), this.sessionKey);
			const name = claim?.images.find((name) => Number(FILE_PATTERN.exec(name)![2]) === sequence);
			if (!name) return undefined;
			return this.readEntry(this.exactReference(name, sequence));
		}
		const scan = this.scan(false);
		if (!scan.complete) throw new Error("Attachment directory exceeds its inspection bound.");
		const entry = this.findEntry(scan, sequence);
		return entry ? this.readEntry(entry) : undefined;
	}

	readLatest(): StoredSessionImage | undefined {
		const scan = this.scan(false);
		if (!scan.complete) throw new Error("Attachment directory exceeds its inspection bound.");
		const entries = scan.entries
			.filter((entry) => entry.sessionKey === this.sessionKey)
			.sort((left, right) => right.sequence - left.sequence);
		for (const entry of entries) {
			const exact = this.findEntry(scan, entry.sequence);
			const image = exact ? this.readEntry(exact) : undefined;
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

	private readEntry(
		entry: Pick<StoredImageEntry, "path" | "sequence" | "mimeType" | "digest">,
	): StoredSessionImage | undefined {
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
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
	}

	private scan(readClaims = true): StoreScan {
		const entries: StoredImageEntry[] = [];
		const pins = new Map<string, StoredPin>();
		const claims = new Map<string, StoredImageClaim>();
		const now = this.now();
		let scanned = 0;
		let complete = true;
		let handle: ReturnType<typeof opendirSync>;
		try {
			handle = opendirSync(this.directory);
		} catch (error) {
			if (isMissingFileError(error)) return { entries, pins, claims, complete: true, entryCount: 0 };
			throw error;
		}
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
				const claimMatch = CLAIM_FILE_PATTERN.exec(directoryEntry.name);
				if (claimMatch) {
					if (!readClaims) continue;
					if (!CLAIM_ID_PATTERN.test(claimMatch[2]!)) throw new Error("Malformed image pin claim filename.");
					const path = resolve(this.directory, directoryEntry.name);
					const claim = this.readClaim(path, claimMatch[1]!);
					if (claim) claims.set(path, claim);
					continue;
				}
				if (directoryEntry.name.endsWith(PIN_SUFFIX)) {
					const imageName = directoryEntry.name.slice(0, -PIN_SUFFIX.length);
					if (!FILE_PATTERN.test(imageName)) continue;
					const pinPath = resolve(this.directory, directoryEntry.name);
					try {
						const stats = lstatSync(pinPath);
						if (stats.isFile() && !stats.isSymbolicLink())
							pins.set(imageName, { path: pinPath, mtimeMs: stats.mtimeMs });
					} catch (error) {
						if (!isMissingFileError(error)) throw error;
					}
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
				} catch (error) {
					if (!isMissingFileError(error)) throw error;
				}
			}
		} finally {
			handle.closeSync();
		}
		const claimedNames = new Set(
			[...claims.values()].filter((claim) => now - claim.mtimeMs <= MAX_PIN_AGE_MS).flatMap((claim) => claim.images),
		);
		for (const entry of entries) {
			const pin = pins.get(basename(entry.path));
			entry.pinned =
				claimedNames.has(basename(entry.path)) || (pin !== undefined && now - pin.mtimeMs <= MAX_PIN_AGE_MS);
		}
		return { entries, pins, claims, complete, entryCount: scanned };
	}

	private prune(protectedPath: string): void {
		const scan = this.scan();
		if (!scan.complete) {
			throw new Error(`Attachment directory exceeds the ${MAX_SCANNED_ENTRIES}-entry inspection bound`);
		}
		const now = this.now();
		for (const claim of scan.claims.values()) {
			if (now - claim.mtimeMs > MAX_PIN_AGE_MS) unlinkSync(claim.path);
		}
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

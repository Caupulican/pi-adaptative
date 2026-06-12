/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, open, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@caupulican/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

const MAX_ATTACHMENT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_IMAGE_BYTES = 128 * 1024 * 1024;

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Pathology guard only: real screenshots/photos sit far below this.
			if (stats.size > MAX_ATTACHMENT_IMAGE_BYTES) {
				text += `<file name="${absolutePath}">[Image is ${Math.round(stats.size / (1024 * 1024))}MB, beyond the inline decode guard; not attached.]</file>\n`;
				continue;
			}
			// Handle image file
			const content = await readFile(absolutePath);

			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				const resized = await resizeImage(content, mimeType);
				if (!resized) {
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,
				};
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: content.toString("base64"),
				};
			}

			images.push(attachment);

			// Add text reference to image with optional dimension note
			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				// Bound the attachment: a giant file would spike the heap and overflow
				// the context anyway. The leading window plus a note keeps the rest
				// reachable in batches through the read tool.
				if (stats.size > MAX_ATTACHMENT_TEXT_BYTES) {
					const handle = await open(absolutePath, "r");
					let head: string;
					try {
						const buffer = Buffer.allocUnsafe(MAX_ATTACHMENT_TEXT_BYTES);
						const { bytesRead } = await handle.read(buffer, 0, MAX_ATTACHMENT_TEXT_BYTES, 0);
						head = buffer.subarray(0, bytesRead).toString("utf-8");
					} finally {
						await handle.close();
					}
					const lastNewline = head.lastIndexOf("\n");
					if (lastNewline > 0) head = head.slice(0, lastNewline);
					text += `<file name="${absolutePath}">\n${head}\n[File is ${Math.round(stats.size / (1024 * 1024))}MB; attached the leading window only. Read further slices with the read tool using offset.]\n</file>\n`;
					continue;
				}
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}

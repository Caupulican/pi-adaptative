/** Portable on-disk names and their authenticated machine and job identifiers. */
import { WIRE_ID } from "./protocol.ts";

/** The extension of a record file, and of the cancel marker kept beside it. */
export const RECORD_EXTENSION = "json";
export const CANCEL_EXTENSION = "cancel";
/** A record or marker file name: the machine id as lowercase hex, the job id, then the extension. */
const NAMED_FILE = /^((?:[0-9a-f]{2})+)\.([A-Za-z0-9_-]+)\.(json|cancel)$/;

/** The machine id and job id of a logical name `<machineId>.<jobId>`; undefined for a name that holds neither. */
export function splitRecordName(name: string): { readonly machineId: string; readonly jobId: string } | undefined {
	const separator = name.lastIndexOf(".");
	if (separator < 0) return undefined;
	const machineId = name.slice(0, separator);
	const jobId = name.slice(separator + 1);
	return WIRE_ID.test(machineId) && WIRE_ID.test(jobId) ? { machineId, jobId } : undefined;
}

/**
 * The file a logical record name is stored under: `<machineTag>.<jobId>.<extension>`, the machine id as lowercase hex. Hex is a safe
 * file-name part on Windows and Linux (no reserved character, no case folding) and never spells a reserved device name. Neither part
 * holds a dot, so the file name parses back to its machine and job without reading the file (`parseNamedFile`).
 */
export function recordFileName(name: string, extension: string = RECORD_EXTENSION): string {
	const parts = splitRecordName(name);
	if (parts === undefined) throw new Error("a job record name is a machine id and a job id");
	return `${Buffer.from(parts.machineId, "utf8").toString("hex")}.${parts.jobId}.${extension}`;
}

/**
 * The logical name, machine, job and extension a record or marker file name holds; undefined for a file name this build does not parse.
 */
export function parseNamedFile(
	file: string,
):
	| { readonly name: string; readonly machineId: string; readonly jobId: string; readonly extension: string }
	| undefined {
	const match = NAMED_FILE.exec(file);
	if (!match) return undefined;
	const machineId = Buffer.from(match[1], "hex").toString("utf8");
	const jobId = match[2];
	return WIRE_ID.test(machineId) && WIRE_ID.test(jobId)
		? { name: `${machineId}.${jobId}`, machineId, jobId, extension: match[3] }
		: undefined;
}

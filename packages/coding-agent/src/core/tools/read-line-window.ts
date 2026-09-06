import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import { StreamingLineDecoder } from "@caupulican/pi-ai/streaming-lines";

export interface ReadLine {
	text: string;
	originalIndex: number;
	window?: { startColumn: number; totalChars: number };
}

export interface ReadLineWindowDetails {
	line: number;
	startColumn: number;
	endColumn: number;
	totalColumns: number;
	nextColumn?: number;
}

/** A bounded, unfiltered source window. Continuations use UTF-16 positions without splitting characters. */
export function readLineWindow(line: ReadLine, column = 1) {
	const totalColumns = line.window?.totalChars ?? line.text.length;
	if (column > totalColumns + 1)
		throw new Error(`Column ${column} is beyond line ${line.originalIndex} (${totalColumns} UTF-16 units)`);
	const base = line.window?.startColumn ?? 0;
	const decoder = new StreamingLineDecoder(Math.floor(DEFAULT_MAX_BYTES / 4), {
		overflow: "window",
		lineEndings: "lf",
		startColumn: Math.max(0, column - 1 - base),
	});
	decoder.pushRecords(line.text);
	const window = decoder.finishRecord() ?? { text: "", startColumn: 0, totalChars: 0 };
	const startColumn = base + window.startColumn + 1;
	const endColumn = startColumn + window.text.length - 1;
	const nextColumn = endColumn < totalColumns ? endColumn + 1 : undefined;
	const lineWindow: ReadLineWindowDetails = {
		line: line.originalIndex,
		startColumn,
		endColumn,
		totalColumns,
		nextColumn,
	};
	const continuation =
		nextColumn !== undefined
			? `Use read on the same path with offset=${line.originalIndex} column=${nextColumn} to continue this line.`
			: `End of line. Use offset=${line.originalIndex + 1} for subsequent lines, if any.`;
	return {
		text: `${window.text}\n\n[Line ${line.originalIndex}, columns ${startColumn}-${endColumn} of ${totalColumns} (UTF-16 units; unfiltered character window). ${continuation}]`,
		lineWindow,
	};
}

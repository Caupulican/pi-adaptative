import {
	countFileLinesSync,
	readBoundedTextFile,
	readBoundedTextFileSync,
	readFilePrefixSync,
} from "../../src/core/util/bounded-file.ts";

const [, , mode, path] = process.argv;
try {
	if (mode === "async") await readBoundedTextFile(path, 64, "Probe");
	else if (mode === "text") readBoundedTextFileSync(path, 64, "Probe");
	else if (mode === "prefix") readFilePrefixSync(path, 64, "Probe");
	else if (mode === "lines") countFileLinesSync(path, "Probe");
	else throw new Error("Unknown bounded reader probe");
	process.stdout.write("read");
} catch (error) {
	process.stdout.write(error instanceof Error ? error.message : "Unexpected probe failure");
}

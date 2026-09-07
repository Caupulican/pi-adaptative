import { assessPathWithinEnvelopeSync } from "../../src/core/autonomy/envelope-enforcement.ts";

const [method, mode] = process.argv.slice(2);
const root = "/synthetic/project";
const target = `${root}/source.txt`;
const failure = () => {
	throw new Error("Synthetic backend failure");
};
const probe = (path) => {
	if (method === "parent" && path === target) return undefined;
	if (mode === "sync") return failure();
	return new Promise((_resolve, reject) => {
		setImmediate(() => reject(new Error("Synthetic backend failure")));
	});
};
const authority = {
	flavor: "posix",
	canonicalPath: probe,
	...(method === "safeRealpath" ? { safeRealpath: probe } : {}),
};
const result = assessPathWithinEnvelopeSync(
	{ id: "synthetic", capabilities: ["filesystem.read"] },
	target,
	{ cwd: root, pathAuthority: authority },
);
console.log(JSON.stringify(result));

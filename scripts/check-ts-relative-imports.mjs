import { resolve } from "node:path";
import {
	isCallExpression,
	isExportDeclaration,
	isImportDeclaration,
	isImportExpression,
	isImportTypeNode,
	isLiteralTypeNode,
	isStringLiteralLikeNode,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

const configPath = resolve(process.argv[2] ?? "tsconfig.json");
const api = new API({ cwd: process.cwd() });
const failures = [];

function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

function getImportTypeSpecifier(node) {
	if (!isLiteralTypeNode(node.argument)) return undefined;
	if (!isStringLiteralLikeNode(node.argument.literal)) return undefined;
	return node.argument.literal;
}

try {
	const snapshot = api.updateSnapshot({ openProject: configPath });
	const project = snapshot.getProject(configPath);
	if (!project) throw new Error(`TypeScript project was not loaded from ${configPath}`);

	for (const file of [...project.rootFiles].sort()) {
		if (file.endsWith(".d.ts")) continue;
		const sourceFile = project.program.getSourceFile(file);
		if (!sourceFile) throw new Error(`TypeScript project did not return its root file ${file}`);

		function checkSpecifier(node) {
			if (!isRelativeJavaScriptSpecifier(node.text)) return;
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			failures.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
		}

		function visit(node) {
			if (isImportDeclaration(node) && isStringLiteralLikeNode(node.moduleSpecifier)) {
				checkSpecifier(node.moduleSpecifier);
			} else if (isExportDeclaration(node) && node.moduleSpecifier && isStringLiteralLikeNode(node.moduleSpecifier)) {
				checkSpecifier(node.moduleSpecifier);
			} else if (
				isCallExpression(node) &&
				isImportExpression(node.expression) &&
				node.arguments[0] &&
				isStringLiteralLikeNode(node.arguments[0])
			) {
				checkSpecifier(node.arguments[0]);
			} else if (isImportTypeNode(node)) {
				const specifier = getImportTypeSpecifier(node);
				if (specifier) checkSpecifier(specifier);
			}

			node.forEachChild(visit);
		}

		visit(sourceFile);
	}
} finally {
	api.close();
}

if (failures.length > 0) {
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

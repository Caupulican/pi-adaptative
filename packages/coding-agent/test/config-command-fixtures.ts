interface CounterCommandOptions {
	output?: string;
	exitCode?: number;
}

function createNodeConfigCommand(source: string): string {
	const encodedSource = Buffer.from(source, "utf-8").toString("base64");
	return `!node -e "eval(Buffer.from('${encodedSource}','base64').toString('utf-8'))"`;
}

export function createOutputConfigCommand(output: string): string {
	return createNodeConfigCommand(`process.stdout.write(${JSON.stringify(output)});`);
}

export function createCounterConfigCommand(filePath: string, options: CounterCommandOptions = {}): string {
	const source = [
		`const fs=require('node:fs');`,
		`const filePath=${JSON.stringify(filePath)};`,
		`const count=Number.parseInt(fs.readFileSync(filePath,'utf-8').trim(),10);`,
		`fs.writeFileSync(filePath,String(count+1));`,
		options.output === undefined ? "" : `process.stdout.write(${JSON.stringify(options.output)});`,
		options.exitCode === undefined ? "" : `process.exit(${options.exitCode});`,
	].join("");
	return createNodeConfigCommand(source);
}

export function createReadFileConfigCommand(filePath: string): string {
	return createNodeConfigCommand(
		`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(filePath)},'utf-8'));`,
	);
}

export function createPipeConfigCommand(): string {
	const sourceCommand = createOutputConfigCommand("hello world").slice(1);
	return process.platform === "win32"
		? `!${sourceCommand} | ForEach-Object { $_ -replace ' ', '-' }`
		: `!${sourceCommand} | tr ' ' '-'`;
}

export interface ProcessMemoryMb {
	rssMb: number;
	heapUsedMb: number;
	externalMb: number;
}

const BYTES_PER_MB = 1024 * 1024;

/** Current process memory usage, rounded to whole megabytes. */
export function getProcessMemoryMb(): ProcessMemoryMb {
	const usage = process.memoryUsage();
	return {
		rssMb: Math.round(usage.rss / BYTES_PER_MB),
		heapUsedMb: Math.round(usage.heapUsed / BYTES_PER_MB),
		externalMb: Math.round(usage.external / BYTES_PER_MB),
	};
}

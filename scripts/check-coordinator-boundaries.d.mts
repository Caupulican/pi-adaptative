export const COORDINATOR_MAX_LINES: number;

export interface BoundaryFailure {
	failures: string[];
}

export function checkCoordinatorBoundaries(options?: {
	root?: string;
	maxLines?: number;
	boundaries?: Array<{
		path: string;
		required?: string[];
		forbidden?: string[];
	}>;
	skipGoalStatusScan?: boolean;
	scanRoot?: string;
}): { failures: string[]; ok?: boolean };

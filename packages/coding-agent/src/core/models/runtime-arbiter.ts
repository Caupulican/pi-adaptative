export type ResidencyControl = "full" | "keep-alive" | "advisory";
export type RuntimeRole = "active" | "router" | "bench" | "probe";

export interface RuntimeResidentModel {
	adapterId: string;
	model: string;
	bytes: number;
	lastUsedAtMs: number;
	priority: number;
	pinned?: boolean;
	residencyControl: ResidencyControl;
}

export interface RuntimeLoadRequest {
	model: string;
	bytes: number;
	role: RuntimeRole;
	priority: number;
	nowMs: number;
	minDwellMs?: number;
	pinActiveModel?: string;
	reservations?: RuntimeReservation[];
	recentEvictions?: RuntimeEvictionRecord[];
}

export interface RuntimeReservation {
	model: string;
	bytes: number;
	priority: number;
}

export interface RuntimeEvictionRecord {
	evicted: string;
	loaded: string;
	atMs: number;
}

export type RuntimeResidencyPlan =
	| { status: "fits"; evict: RuntimeResidentModel[]; requiredBytes: number; budgetBytes: number }
	| { status: "refuse"; reason: string; evict: RuntimeResidentModel[]; requiredBytes: number; budgetBytes: number };

export interface RuntimeResidencyAdapter {
	id: string;
	residencyControl: ResidencyControl;
	list(): Promise<RuntimeResidentModel[]>;
	ensureResident(model: string): Promise<void>;
	release(model: string): Promise<void>;
}

export function planRuntimeResidency(args: {
	budgetBytes: number;
	residents: readonly RuntimeResidentModel[];
	request: RuntimeLoadRequest;
}): RuntimeResidencyPlan {
	const requestedModels = new Map<string, { bytes: number; priority: number }>();
	requestedModels.set(args.request.model, { bytes: args.request.bytes, priority: args.request.priority });
	for (const reservation of args.request.reservations ?? []) {
		const existing = requestedModels.get(reservation.model);
		if (!existing || reservation.bytes > existing.bytes) {
			requestedModels.set(reservation.model, { bytes: reservation.bytes, priority: reservation.priority });
		}
	}

	const residentByModel = new Map(args.residents.map((resident) => [resident.model, resident]));
	const residentBytes = args.residents.reduce((sum, resident) => sum + resident.bytes, 0);
	const missingBytes = [...requestedModels].reduce((sum, [model, request]) => {
		return residentByModel.has(model) ? sum : sum + request.bytes;
	}, 0);
	const requiredBytes = residentBytes + missingBytes;
	if (requiredBytes <= args.budgetBytes) {
		return { status: "fits", evict: [], requiredBytes, budgetBytes: args.budgetBytes };
	}

	if (hasPingPongRisk(args.request)) {
		return { status: "refuse", reason: "anti-thrash", evict: [], requiredBytes, budgetBytes: args.budgetBytes };
	}

	let projectedBytes = requiredBytes;
	const evict: RuntimeResidentModel[] = [];
	const candidates = args.residents
		.filter((resident) => !requestedModels.has(resident.model))
		.filter((resident) => !resident.pinned && resident.model !== args.request.pinActiveModel)
		.filter((resident) => resident.residencyControl !== "advisory")
		.filter(
			(resident) =>
				args.request.minDwellMs === undefined ||
				args.request.nowMs - resident.lastUsedAtMs >= args.request.minDwellMs,
		)
		.sort((left, right) => left.priority - right.priority || left.lastUsedAtMs - right.lastUsedAtMs);
	for (const candidate of candidates) {
		evict.push(candidate);
		projectedBytes -= candidate.bytes;
		if (projectedBytes <= args.budgetBytes) {
			return { status: "fits", evict, requiredBytes, budgetBytes: args.budgetBytes };
		}
	}
	return {
		status: "refuse",
		reason: "insufficient-evictable-memory",
		evict,
		requiredBytes,
		budgetBytes: args.budgetBytes,
	};
}

function hasPingPongRisk(request: RuntimeLoadRequest): boolean {
	return (request.recentEvictions ?? []).some(
		(record) => record.evicted === request.model && request.nowMs - record.atMs <= (request.minDwellMs ?? 0),
	);
}

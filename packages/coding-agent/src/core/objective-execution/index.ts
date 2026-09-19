/**
 * Public Objective Execution Module Exports.
 */

export {
	buildDeliveryBundle,
	type DeliveryArtifact,
	type DeliveryBundle,
	type DeliveryTerminalStatus,
	type DeliveryVerificationRecord,
} from "./delivery-bundle.ts";
export {
	GoalCompatibilityAdapter,
	type GoalCompatibilityAdapterDeps,
	type LegacyEvidence,
	type LegacyGoalStart,
	type LegacyRequirement,
	type LegacySatisfyRequirement,
} from "./goal-compatibility-adapter.ts";
export {
	CURRENT_GOAL_MIGRATION_VERSION,
	computeGoalStateDigest,
	GOAL_MIGRATION_SCHEMA_VERSION,
	GoalMigrationError,
	type GoalMigrationRecord,
	migrateGoalState,
} from "./goal-state-migration.ts";
export {
	type DisagreementTelemetryEvent,
	type ExecutionLoopMode,
	ObjectiveExecutionController,
	type ObjectiveExecutionControllerDeps,
} from "./objective-execution-controller.ts";
export {
	completionFailuresToRepairWork,
	REPAIR_WORK_SCHEMA_VERSION,
	type RepairWork,
	type RepairWorkClass,
	RepairWorkValidationError,
	validateRepairWork,
} from "./objective-repair-work.ts";
export {
	OBJECTIVE_ROUTE_SCHEMA_VERSION,
	type ObjectiveRoute,
	type ObjectiveRouteName,
	ObjectiveRouteValidationError,
	type ObjectiveTerminalResult,
	routeToTerminal,
	VALID_OBJECTIVE_ROUTES,
	validateObjectiveRoute,
} from "./objective-route.ts";
export {
	composeObjectiveRoute,
	type RouteCompositionInput,
} from "./objective-route-policy.ts";
export {
	type ObjectiveRouteProjection,
	projectObjectiveForRouting,
	type SemanticRouteJudgments,
} from "./objective-route-projector.ts";
export {
	ObjectiveStallDetector,
	type StallEvaluation,
	type StallTrackerState,
} from "./objective-stall-fingerprint.ts";

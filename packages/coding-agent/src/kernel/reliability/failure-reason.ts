export type FailureReason =
	| "overloaded"
	| "rate_limit"
	| "server_error"
	| "network"
	| "stream_stall"
	| "runaway_output"
	| "context_overflow"
	| "auth"
	| "billing_or_quota"
	/** The provider refuses this model for the credential in use (not on the account's plan). */
	| "model_unsupported"
	| "aborted"
	| "unknown";

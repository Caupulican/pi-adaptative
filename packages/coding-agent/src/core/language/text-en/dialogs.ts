/**
 * The English words of the connection dialogs: the login and OAuth dialogs, the controller that runs the login and
 * logout flows, the frame around a human question, the session-start readiness prompt and the yes/no prompts. The
 * question and the options a model writes are not here: only the frame the owner reads around them is.
 */

export const DIALOGS = {
	login: {
		title: (provider: string) => `Login to ${provider}`,
		/** The line under the link that says how to open it. */
		openClickMac: "Cmd+click to open",
		openClickOther: "Ctrl+click to open",
		enterCode: (code: string) => `Enter code: ${code}`,
		examplePlaceholder: (placeholder: string) => `e.g., ${placeholder}`,
		toCancel: "to cancel",
		toSubmit: "to submit",
		toClose: "to close",
	},
	oauth: {
		titleLogin: "Select provider to configure:",
		titleLogout: "Select provider to logout:",
		configured: " ✓ configured",
		subscriptionConfigured: "subscription configured",
		apiKeyConfigured: "API key configured",
		environmentKey: (label: string) => ` ✓ env: ${label}`,
		environmentKeyDefault: "API key",
		runtimeKey: " ✓ runtime API key",
		customKey: " ✓ custom API key",
		modelsJsonKey: " ✓ key in models.json",
		modelsJsonCommand: " ✓ command in models.json",
		unconfigured: "unconfigured",
		noProviders: "No providers available",
		noLoggedIn: "No providers logged in. Use /login first.",
		noMatching: "No matching providers",
	},
	authDialogs: {
		loggedOut: (provider: string) => `Logged out of ${provider}`,
		apiKeyRemoved: (provider: string) =>
			`Removed stored API key for ${provider}. Environment variables and models.json config are unchanged.`,
		logoutFailed: (message: string) => `Logout failed: ${message}`,
		methodTitle: "Select authentication method:",
		methodSubscription: "Use a subscription",
		methodApiKey: "Use an API key",
		noSubscriptionProviders: "No subscription providers available.",
		noApiKeyProviders: "No API key providers available.",
		unknownLoginProvider: (reference: string) =>
			`Unknown login provider "${reference}". Use /login to select from available providers.`,
		noStoredCredentials:
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		noStoredCredentialsFor: (reference: string) =>
			`No stored credentials found for "${reference}". Use /logout to select a saved provider.`,
		typesafeStatus: "System One is available through systemone; TypeSafe authentication is checked on first use.",
		loggedIn: (provider: string) => `Logged in to ${provider}`,
		apiKeySaved: (provider: string) => `Saved API key for ${provider}`,
		noDefaultModel: (action: string, provider: string) =>
			`${action}, but no default model is configured for provider "${provider}". Use /model to select a model.`,
		noModels: (action: string) =>
			`${action}, but no models are available for that provider. Use /model to select a model.`,
		defaultModelUnavailable: (action: string, modelId: string) =>
			`${action}, but its default model "${modelId}" is not available. Use /model to select a model.`,
		selectModelFailed: (action: string, message: string) =>
			`${action}, but selecting its default model failed: ${message}. Use /model to select a model.`,
		statusSelected: (action: string, modelId: string, authPath: string) =>
			`${action}. Selected ${modelId}. Credentials saved to ${authPath}`,
		statusSaved: (action: string, authPath: string) => `${action}. Credentials saved to ${authPath}`,
		bedrockTitle: "Set up Amazon Bedrock:",
		bedrockSsoProfile: (profile: string) => `Sign in with SSO profile "${profile}"`,
		bedrockSso: "Sign in with an AWS SSO profile",
		bedrockOther: "Use IAM, bearer, or role credentials",
		bedrockCredentialInfoTitle: "Amazon Bedrock setup",
		bedrockCredentialUses: "Amazon Bedrock uses AWS credentials instead of a single API key.",
		bedrockCredentialConfigure:
			"Configure IAM keys, a bearer token, or role-based credentials, then verify their exact region.",
		see: "See:",
		bedrockVerified: (message: string, count: number, region: string) =>
			`${message} Verified ${count} model${count === 1 ? "" : "s"} in ${region}.`,
		bedrockReady: "Amazon Bedrock credentials are ready.",
		bedrockSignedIn: (profile: string) => `Signed in with AWS profile "${profile}".`,
		bedrockSsoTitle: "Amazon Bedrock SSO",
		regionPrompt: "AWS region (required):",
		ssoProfilePrompt: "AWS SSO profile name:",
		ssoProfileExample: "my-work-profile",
		regionEmpty: "AWS region cannot be empty.",
		profileEmpty: "AWS profile name cannot be empty.",
		apiKeyEmpty: "API key cannot be empty.",
		apiKeyNotSaved:
			"API key was not saved; it is available only in this session. Check credential storage permissions and retry.",
		verifyingAws: "Verifying AWS identity, Bedrock profiles, and model access...",
		waitingForSso: "Waiting for AWS SSO authentication...",
		usingProfile: (profile: string) => `Using AWS profile: ${profile}`,
		bedrockRegion: (region: string) => `Bedrock region: ${region}`,
		finishSignIn: "Complete the IAM Identity Center sign-in in your browser.",
		apiKeyPrompt: "Enter API key:",
		manualCodePrompt: "Paste redirect URL below, or complete login in browser:",
		waitingForAuth: "Waiting for authentication...",
		configureFailed: (provider: string) => `Failed to configure ${provider}: `,
		signInFailed: (provider: string) => `Failed to sign in to ${provider}: `,
		saveApiKeyFailed: (provider: string) => `Failed to save API key for ${provider}: `,
		loginFailed: (provider: string) => `Failed to login to ${provider}: `,
	},
	question: {
		/** The headings of a human question and its answer, as the conversation shows them. */
		assistant: "Assistant",
		you: "You",
		waiting: "Waiting for your answer",
		status: "Question status",
		clipboardLimit: "Conversation exceeds clipboard limit; use /export for the complete session.",
	},
	readiness: {
		/** Why the harness cannot start a worker, and the one setting change that fixes it. */
		delegationOff: "Delegation is turned off, so the orchestrator cannot start workers.",
		delegationFix: "Turn delegation on",
		workersNoModel: "Workers have no model they are allowed to use, so delegated work would fail.",
		workersFix: "Let workers use this session's model",
		skip: "Not now",
		auto: "Set it up for me (subscriptions first; API keys stay unused unless you say so)",
		sessionModel: (modelRef: string) => `This session's model (${modelRef})`,
		/** The ask itself, behind the problem the probe reported. */
		choosePrompt: (problem: string) =>
			`${problem} Choose how workers get their model, or pick a worker profile: one model every worker uses (a hard task raises only its thinking).`,
		delegationOn: "Delegation is on.",
		workersSubscriptions: (providers: string) =>
			`Workers will use your subscriptions (${providers}). API keys are left unused.`,
		workersModel: (modelRef: string) =>
			`Workers will use ${modelRef}. Change it any time under workerDelegation.modelPins in settings.`,
	},
	selectionPrompts: {
		yes: "Yes",
		no: "No",
	},
};

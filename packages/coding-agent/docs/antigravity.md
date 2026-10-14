# Gemini 4 Argon through Antigravity

Sign in with `/login` and select **Google Antigravity**. Pi discovers the models available to that account; it does not add models the account cannot access. Select an advertised `gemini-4-argon-low`, `gemini-4-argon-medium`, or `gemini-4-argon-high` model with `/model`.

Each variant uses its catalog thinking level. Selecting a different reasoning effort does not override a fixed variant; select the corresponding model instead. If the account advertises an unpreset `gemini-4-argon`, it supports Low, Medium, and High, with Medium as the default. Argon uses thinking levels rather than thinking-token budgets, and Pi omits its unsupported temperature parameter.

Existing Antigravity credentials refresh their discovered catalog when the packaged client identity or catalog format changes. Refresh failures remain visible. If the account has no Argon models, check its entitlement in AGY; refreshing Pi cannot grant access. Google lists Argon availability by plan in its [model documentation](https://www.antigravity.google/docs/models/).

The reviewed AGY 1.3.5 presets have a 1,048,576-token context window and a 65,536-token output cap. Thinking counts toward that output cap. Pi uses the account's advertised limits when discovering models. Google’s larger background long-decode API is a separate transport and is not provided by this Antigravity integration.

Argon is also present in the refreshed Google and OpenRouter catalogs. Those routes use their own API credentials and provider limits; they do not use Antigravity subscription credentials. See Google's [Argon API documentation](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon).

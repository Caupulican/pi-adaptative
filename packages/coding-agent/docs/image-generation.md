# ChatGPT subscription image generation

`image_generate` creates or edits one image using the active `openai-codex` provider's stored ChatGPT OAuth login. It uses GPT Image 2 through the subscription image backend. Selecting an OpenAI API-key model, another provider, or having an API key without a ChatGPT login does not enable this tool. There is no API-key billing fallback.

Per-turn model routing only narrows the current tool surface; it never grants additional tools. Routing from another provider to ChatGPT therefore does not newly activate image generation. Explicitly selecting the ChatGPT session model restores the requested image tool. Routing away from ChatGPT temporarily hides it and restores it when the routed turn settles. Native worker sessions never register this root-owned tool.

The request contract follows the local Codex image implementation: a JSON request to the subscription Images generation or edit endpoint, not a Responses conversation or an external CLI process. OpenAI documents built-in image generation as using Codex usage limits; backend availability still depends on the account and rollout. [OpenAI image-generation documentation](https://learn.chatgpt.com/docs/image-generation).

## Inputs and outputs

For a new image, supply `prompt`. For an edit, supply the prompt and exactly one reference mode:

- `referenced_image_paths`: one to five local PNG, JPEG, WEBP or GIF files. Prefer this when the images have known paths.
- `num_last_images_to_include`: one to five images from the current conversation, preserving their original order. This is a recent-image window, not stable identity selection; unrelated newer images can enter the window. Missing references fail rather than silently changing the operation into generation.

Paths use the existing credential/path guards and bounded file reader. References are sent as image data, not remotely fetched URLs. Provider and OAuth checks are repeated before submitting the request after asynchronous credential resolution.

The original result is retained by the existing session attachment store and returned with an absolute path and image sequence. Results at most 4 MiB of base64 also appear inline. Larger originals remain available by path; `read` can produce a bounded preview. The existing attachment retention policy applies: 512 files / 512 MiB, a 30-day age bound, and bounded directory inspection. Copy artwork into the project if it must outlive attachment retention. Storage failure after generation is reported explicitly and never triggers another generation request.

## Bounds and failure behavior

Prompts are capped at 32 KiB UTF-8. Each reference is capped at 10 MiB, with five references maximum. One generated image is capped at 32 MiB decoded; the HTTP response allows its base64 representation plus 64 KiB of metadata. Error bodies are capped at 64 KiB. Streaming body reads use bounded geometric allocation; this endpoint returns completed JSON, not preview-image SSE events.

OAuth resolution has a 30-second waiting bound. Image requests have a five-minute default deadline; the low-level adapter accepts a maximum ten-minute deadline. Cancellation closes response consumption and prevents late credential resolution from submitting a request. An OAuth refresh already in progress may finish in the existing credential owner after the tool stops waiting.

Each tool execution submits at most one image request. Authentication rejection, unavailable entitlement, usage limits, malformed responses, cancellation, timeout and network interruption are visible failures. No backend body, bearer token, or arbitrary transport-error text is included in diagnostics. A canceled or interrupted request may still have consumed subscription usage or completed remotely; there is no remote cancellation or idempotent-retrieval guarantee, and no automatic transport retry. A new model-requested call is a new generation, not recovery of the prior call.

Reported image token usage is retained when supplied by the backend. Monetary cost is zero in the local usage record because this is subscription metering, not proof that generation is free or unlimited.

## Verification limits

Coverage uses mocked HTTP transport and temporary local artifacts, including entitlement rejection, malformed and oversized data, secret reflection, cancellation, deadline expiry, provider changes and storage failure. It does not prove that a particular account has entitlement or that the private subscription backend contract will remain unchanged. No real images or paid requests are used in these tests. Full image decoding is not used as a security validator; format checks inspect supported signatures. Filesystem checks are not a sandbox against an adversarial concurrent filesystem writer. This implementation adds no image studio, browser session or alternate provider path.

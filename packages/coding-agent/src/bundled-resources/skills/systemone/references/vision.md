# Vision

Use `action: "vision"` for UI screenshots and general image judgments. Check `status`'s `capabilities.images` first. Vision uses TypeSafe's experimental image and Box capability; OpenRouter vision is refused explicitly without switching provider. Results carry `accepted: null` and stay advisory.

Supply `vision: {state, questions, images}`. Each `images` entry maps a distinctive `<name>` placeholder to `{path, reason}` for an explicitly selected local PNG or JPEG inside the task directory. Put placeholders in state, instructions or criteria. Put a shared image in state once: repeating a placeholder repeats its image context and cost.

- **Comparison:** label the reference and the current image in state, then batch narrow Choice, Noul or Score questions about visible properties.
- **Localization:** add a Box question and `boxes[questionId]` with `image` (the placeholder), `presenceQuestion`, `minimumPresence` and `minimumConfidence`. The companion presence question must be a unique Noul with `instructions: null` and no criteria. Define the target only in the Box instructions and disambiguate repeated targets. Low presence, low or null confidence and padding-only rectangles never produce a candidate.
- **Crop:** an optional integer `crop: {left, top, right, bottom}` uses EXIF-upright source pixels; source files are never changed.

Returned candidates use upright source pixels, never desktop input coordinates. Check the current image, layout and focus before using a target. No screen is captured and no transcript image is uploaded; pixels are not credential-redacted. An image judgment never authorizes a click or satisfies a completion gate, and a screenshot's appearance cannot establish application behavior. Vision attempts are never retried automatically. Limits per request: 16 MiB per image, 40 million pixels, 8 selections; partition larger requests explicitly. Full examples and retained-evidence semantics: `docs/system-one-images.md`.

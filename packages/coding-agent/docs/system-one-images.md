# System One images

The root and workers granted `systemone` can judge screenshots, photos, diagrams and other
selected still images. Use `action: "vision"` for visual classification, quality scoring,
comparison, change detection and target localization. This uses the configured TypeSafe
credential and pinned `jev-1.14.0`. Text evaluation and review retain their existing model.
`status` reports `capabilities.images`, `boxes`, and `visionModel`. OpenRouter image requests
are explicitly unsupported; the host never changes provider or borrows another provider's key.

TypeSafe describes [images](https://docs.typesafe.ai/images) and
[Box](https://docs.typesafe.ai/primitives/box) as experimental and not production-ready.
Every vision result has `accepted: null`, `advisoryOnly: true`, and `experimental: true`.
It is evidence to inspect, never completion approval or permission to click a control.

## Judge and compare

Select files inside the current task directory. Every image needs a distinctive `<name>`
reference and a relevance reason. References work in state, instructions and Choice, Noul
or Score criteria. Put a shared image in state once and refer to its field from questions:
each repeated placeholder adds image context and cost, even though the file uploads once.

```json
{
  "action": "vision",
  "vision": {
    "state": {
      "reference": "<reference>",
      "current": "<current>",
      "requirement": "The primary action remains visible and its label is readable."
    },
    "images": {
      "<reference>": {"path": "captures/reference.png", "reason": "Owner-selected reference layout"},
      "<current>": {"path": "captures/current.png", "reason": "Current layout to review"}
    },
    "questions": {
      "primary_visible": {"type": "noul", "instructions": "Is the primary action visible in `current`?"},
      "layout_change": {
        "type": "choice",
        "instructions": "Compared with `reference`, how does `current` position the primary action?",
        "criteria": {"same": "Same layout position", "moved": "Different position", "absent": "Action absent", "unclear": "Insufficient visual evidence"}
      },
      "legibility": {
        "type": "score",
        "instructions": "How legible is the primary action label in `current`?",
        "criteria": ["Unreadable or absent", "Partially readable", "Fully readable"]
      }
    }
  }
}
```

The same primitives work on product photos, document regions, maps and visual references.
They return typed answers and probabilities, not prose or generated images. A screenshot
cannot prove keyboard behavior, accessibility semantics, hidden states or application logic.

## Locate one target

Each Box must have a binding to one selected image and its own companion Noul. Define the
target once in the Box instructions. The companion must have `instructions: null` and no
criteria; the host builds matching target/image instructions for both questions.

```json
{
  "action": "vision",
  "vision": {
    "state": {"screen": "<screen>"},
    "images": {"<screen>": {"path": "captures/settings.png", "reason": "Locate the selected Save control"}},
    "questions": {
      "save_present": {"type": "noul", "instructions": null},
      "save": {"type": "box", "instructions": "The Save button nearest the bottom-right of the settings panel"}
    },
    "boxes": {
      "save": {"image": "<screen>", "presenceQuestion": "save_present", "minimumPresence": 0.9, "minimumConfidence": 0.8}
    }
  }
}
```

These thresholds are examples, not calibrated guarantees. Box always returns a rectangle,
including when its target is absent. `boxes.save.candidate` is true only when the matching
presence and non-null confidence meet the explicit thresholds and the rectangle intersects
actual image pixels. Low presence, low or null confidence, and padding-only boxes produce
no `sourceRectangle`. Raw answers remain available for inspection.

`sourceRectangle` uses **EXIF-upright source pixels**. It reverses padding, resize and crop;
it is not desktop input coordinates. Revalidate application identity, focus, layout, scale
and current pixels before acting on any suggestion. Describe one specific occurrence when
targets repeat, or ask a separate Choice for none/one/several and gather narrower evidence.

For a small target in a large image, set an optional `crop` on an image selection:
`{"path":"captures/settings.png","reason":"Inspect the footer","crop":{"left":400,"top":700,"right":1400,"bottom":1100}}`.
Crop edges are integers in upright source pixels. Use separate named selections for tiles
or reference crops. Projection still returns full upright source coordinates.

## Evidence and limits

Only explicitly named local files are read. No screen capture, browser launch, URL fetch,
directory scanning or automatic submission of conversation images occurs. Canonical task
containment and protected credential-path checks use the existing evidence materializer.
Image pixels can contain private information; text credential redaction does not scrub pixels.

Source files remain unchanged. The host accepts still PNG/JPEG, at most 16 MiB each and
40 million source pixels, with up to eight selections and 32 MiB total source bytes. It
decodes, rotates upright from EXIF, optionally crops, shrinks to a longest side of 1568 and
centers small or narrow images on a transparent canvas at least 280 pixels per side.
It sends metadata-free PNGs without upscaling. Animated PNG, GIF, WebP, malformed files
and invalid crops fail explicitly; export the intended still frame as PNG/JPEG first.

Prepared images are capped at 24 MiB in aggregate. Text keeps its 2 MiB cap. Multipart,
image aggregate and expanded requests are bounded to 32 MiB. The provider's own processed
image and token limits can still reject a request; no content is silently truncated.
Vision makes one provider attempt with no automatic retry. Cancellation or an invalid,
incomplete or wrong-model response remains a failed operation with any known usage retained.

The existing session evidence store retains the exact sanitized request, frozen prepared
image bytes, answers, model, usage, hashes and image manifest. The manifest records source
and prepared SHA-256 values, byte sizes, canonical paths, selection reasons and every geometry
transform. Known credentials in textual provenance are masked and `provenanceRedacted` reports
the change; a masked path is provenance text, not a usable file path. Request hashes name the
canonical JSON representation including frozen PNG bytes;
multipart framing is transport-only. Summaries and transcript metadata omit image payloads.
Preparation manifests remain available after provider failure. `action: "evidence"` pages
the full retained record. Hashes establish the submitted snapshot, not freshness of a live
window or a subsequently edited source file. Existing usage leases and receipts record billed
image input tokens through the same accounting path as text judgments.

# Image text translation research

Checkpoint F now ships an opt-in local OCR path for stable visible top-frame
`<img>` elements. This memo records the implemented boundary and the cloud or
broader-source alternatives that remain deferred.

## Implemented local paths

The canonical artifact exposes two independently compiled local OCR providers
in a saved priority order. Chrome's experimental `TextDetector` is
capability-probed in the offscreen document and used only when the installed
browser exposes it. A packaged Tesseract.js provider is the deterministic
fallback and does not depend on that platform API. An unchanged empty
detection must be confirmed by a second OCR pass before it is cached. A
TextDetector result that supplies boxes without authoritative text can pass
those regions to another provider instead of ending the scan.

An additional default-off PaddleOCR.js trial is available behind
`SIMUL_OCR_PADDLE=1`. It uses the official `@paddleocr/paddleocr-js` 0.4.2
module Worker, ONNX Runtime Web 1.24.3, and the official
`PP-OCRv6_tiny_det`/`PP-OCRv6_tiny_rec` model archives. The Worker, Wasm,
models, configuration, licenses, and notices are all packaged locally. The
trial runs with one Wasm thread and fixed detector thresholds of 0.45 and
0.75. Cancellation or a 30-second job deadline terminates the Worker instead
of leaving CPU-bound inference in the offscreen document.

[Tesseract.js](https://github.com/naptha/tesseract.js) runs Tesseract OCR in
WebAssembly and exposes word/line/block geometry. The extension bundles the
JavaScript, Worker, Wasm core loaders, and trained data locally. Its default CDN paths cannot be
used: Manifest V3 disallows remotely hosted executable code, offline behavior
would be unreliable, and the project documents how to configure local worker,
core, and language paths in its
[local-installation guide](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).
The official Tesseract data repository includes a
[Japanese trained model](https://github.com/tesseract-ocr/tessdata/blob/main/jpn.traineddata)
and a separate vertical-Japanese model (`jpn_vert`).

The current pipeline:

1. Remains fully dormant until the saved image-translation option is enabled.
2. Observes `<img>` revisions without disclosing image URLs or page text.
3. Captures a stable visible viewport crop below Chrome's two-per-second cap,
   proportionally downscales high-DPI crops to at most 4 MP, and hashes the
   encoded crop.
4. Tries the saved compiled provider order in an offscreen document:
   capability-probed Chrome TextDetector, a restartable Tesseract.js/core
   7.0.0 Worker with one routed language group loaded at a time, or the
   separately compiled PaddleOCR.js trial.
5. Filters blank, punctuation-only, and regions scored below 0.25. Scored
   regions at or above the saved confidence threshold are authoritative.
   Confidence-free or intermediate-score regions require exact NFKC/
   whitespace-normalized text agreement and bounding-box IoU of at least 0.5
   from a different provider before translation.
6. Keeps recognition and line translation caches separate. Recognition uses
   provider/model order, language, quality-policy version, selected confidence
   threshold, preprocessing profile, processed dimensions, and pixel hash;
   line translation uses the exact provider, language pair, and recognized
   text. Neither cache uses a DOM node or document identity, and
   matching in-flight requests join one provider load. Recognition retention is
   bounded by both entry count and aggregate transcript/region weight.
7. Maps the visible-crop coordinates onto clipped inert sibling overlays that
   follow replay scroll and zoom without changing the image or page layout.
   Text wraps and uses bounded font downscaling inside each recognized box.
   A same-node, same-lease replica image replacement rebinds the existing
   overlay instead of discarding translated work.
8. Stops explicit same-language configurations before image capture. With
   Auto-detect, it resolves the nearest image/element or page language after
   capture metadata is available and stops before recognition when it equals
   the target, preserving the original image.

The pinned catalog includes English, Spanish, French, German, Portuguese,
Italian, Vietnamese, Japanese plus vertical Japanese, Korean, Simplified and
Traditional Chinese, Russian, Ukrainian, Arabic, Hebrew, Hindi, Marathi,
Bengali, Kannada, Tamil, and Telugu. Models not routed for the current image
remain stored locally and unloaded from memory.

The options screen exposes the minimum confidence as 25–95% in five-point
steps, defaulting to 65%. Raising it favors precision and suppresses more
false-positive text; lowering it favors recall. Changing it clears current
image projections and reprocesses the current image set under a distinct cache
identity. The Paddle trial supports Latin-script and Chinese language routes;
an unsupported route fails that provider cleanly. A valid Paddle result that
filters to no accepted text is terminal and does not fall through to
Tesseract, so the trial can be evaluated independently.

Build and validate the isolated local trial with:

```sh
SIMUL_OCR_TEXT_DETECTOR=0 SIMUL_OCR_TESSERACT=0 SIMUL_OCR_PADDLE=1 npm run build
npm run check:ocr-paddle-trial
```

The second command always creates a temporary Paddle-only production artifact,
validates every reviewed byte/hash and the local-only runtime boundary, checks
that no Tesseract assets leaked into it, and removes the temporary artifact.
The canonical build remains Paddle-free unless the flag is explicitly set.

Cross-origin images can be displayed by the mirror but normally taint a canvas,
so display permission alone does not provide OCR pixels. The implemented path
uses `tabs.captureVisibleTab` and can capture only the visible viewport (Chrome
documents both the sensitive-page behavior and a
[maximum of two calls per second](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)).
Chrome accepts that API after a toolbar gesture through `activeTab`, or across
later origin changes through a literal `<all_urls>` host grant. Simul therefore
keeps the grant optional, requests it only from an explicit image-translation
or all-sites-automation gesture, shares it between those two owners, and keeps
saved OCR intent paused when access is absent or revoked. The grant
authorizes pixel capture; Simul still does not retrieve the source image URL.
Requesting narrowly scoped optional access to an image host and fetching the
resource remains deferred. That alternative needs separate consent,
animation/crop handling, and new tests before implementation.

Expected limitations include a multi-megabyte model payload, worker startup
time, memory pressure, stylized or low-resolution lettering, furigana, text
over complex backgrounds, vertical ordering, and translations that remain
unreadable after bounded in-box wrapping and font reduction.

OCR Diagnostics correlates one attempt with an ephemeral ordinal and reports
only rendered/bitmap dimensions, bounded retry decisions, provider/cache
hit/miss/join/load outcomes, accepted/corroborated/uncertain/rejected region
counts, and
projection/rebinding outcomes. It never reports URLs, pixel hashes, recognized
text, or node/document identifiers. A first transient capture failure receives
at most one immediate retry. Changing blank pixels are deferred instead of
being permanently cached as “no text.” A repeated image URL is deliberately
not sufficient for reuse: identical processed pixels and geometry inputs hit
the cache, while a new responsive size, crop, or animation frame is recognized
again so overlay coordinates remain valid.

## Cloud alternative

Google Cloud Vision's `TEXT_DETECTION` and `DOCUMENT_TEXT_DETECTION` return OCR
annotations with bounding polygons; see the official
[OCR documentation](https://cloud.google.com/vision/docs/ocr). Its current
[pricing page](https://cloud.google.com/vision/pricing) lists the first 1,000
units per feature each month at no charge and paid usage after that. Billing
configuration is still required, Cloud Translation is billed separately, and
prices/allowances can change.

Cloud OCR must use a key-protecting backend. Credentials must never be bundled
in the extension. It would also send user image pixels off-device, so it
requires explicit product approval, consent UI, retention/logging policy,
regional review, rate limiting, and abuse controls. A browser-side “free API”
key is not a safe design.

## Remaining increments

Evaluate accuracy and overlay readability on representative non-sensitive
images across the packaged scripts. Image-only language classification,
low-confidence styling, CSS backgrounds, canvas/video, embedded frames, and
direct image fetch each require a separate design and privacy decision. Compare
a backend Vision prototype only with explicit remote-processing approval. Do
not add credentials, host permissions, durable captures, or cloud traffic as an
incidental fidelity fix.

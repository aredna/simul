# Image text translation research

Image OCR is not included in the current extension. Shipping it requires an
explicit choice about bundle size, image access, accuracy, and whether pixels
may leave the device. This memo records a viable Japanese/English path without
silently changing those privacy boundaries.

## Recommended local experiment

[Tesseract.js](https://github.com/naptha/tesseract.js) runs Tesseract OCR in
WebAssembly and exposes word/line/block geometry. A privacy-preserving Chrome
extension experiment can bundle the JavaScript, worker, WASM core, and
`eng`/`jpn` trained data inside the extension. Its default CDN paths cannot be
used: Manifest V3 disallows remotely hosted executable code, offline behavior
would be unreliable, and the project documents how to configure local worker,
core, and language paths in its
[local-installation guide](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).
The official Tesseract data repository includes a
[Japanese trained model](https://github.com/tesseract-ocr/tessdata/blob/main/jpn.traineddata)
and a separate vertical-Japanese model (`jpn_vert`).

A future pipeline would:

1. Obtain pixels only after a user initiates image translation.
2. OCR `jpn+jpn_vert+eng` and retain word/line bounding boxes and confidence.
3. Merge boxes into reading-order regions, preserving vertical-writing hints.
4. Translate recognized regions through the existing on-device provider.
5. Map OCR coordinates through image natural size, `object-fit`, crop, and
   mirror scale; draw inert absolutely positioned text overlays over a dimmed
   copy of the original image.
6. Offer original/overlay toggles and visibly mark low-confidence regions.

Cross-origin images can be displayed by the mirror but normally taint a canvas,
so display permission alone does not provide OCR pixels. Two local options are
possible. `tabs.captureVisibleTab` can capture only the visible viewport after
a user gesture (Chrome documents both the sensitive-page behavior and a
[maximum of two calls per second](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)).
Alternatively, the extension can request narrowly scoped optional access to
the image host and fetch the resource. Either option needs clear consent,
viewport/crop mapping, animation handling, and new tests before implementation.

Expected limitations include a multi-megabyte model payload, worker startup
time, memory pressure, stylized or low-resolution lettering, furigana, text
over complex backgrounds, vertical ordering, and translations that cannot fit
the original polygon. Overlays should grow or reduce font size within a
documented floor rather than silently truncate text.

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

## Decision for the next increment

Prototype local Tesseract first on a small, separately downloadable Japanese
and English model bundle. Evaluate accuracy, extension size, startup latency,
and coordinate mapping on screenshots and ordinary image elements. Compare a
backend Vision prototype only with explicit remote-processing approval and
representative non-sensitive test images. Do not add OCR permissions or cloud
traffic as an incidental fidelity fix.

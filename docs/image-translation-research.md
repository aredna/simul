# Image text translation

Simul includes an opt-in, local image-text path for stable visible top-frame
`<img>` elements. This document records the implemented privacy, capture,
recognition, quality, and projection boundaries.

## Production methods

All image-reading methods share one persisted priority list:

1. **Accessibility text** reads a direct image `aria-label` or `alt` value after
   read-scope, visibility, decoration, credential, and policy checks. It needs
   no screenshot and projects one inert caption band along the bottom edge of
   the image, so the picture stays visible.
2. **Chrome TextDetector** uses the platform API only when the installed Chrome
   build exposes it. Some platforms return geometry without authoritative text;
   that evidence may fall through to another method.
3. **Tesseract.js 7.0.0** is the packaged deterministic pixel-OCR fallback.
   Its Worker, three WebAssembly core loaders, language files, hashes, licenses,
   and notices are included in the extension.

When alt text and OCR text are both available and the deterministic ranker
finds them too close to call, an already-installed on-device model (Gemini
Nano, else Chrome's Language Detector) breaks the tie; Simul never downloads
one. See [`image-evidence-ranker-training.md`](image-evidence-ranker-training.md).

Image translation is on by default, and pixel OCR waits for the optional
image-access grant. Turning every pixel method off pauses OCR before capture. No JavaScript, Worker, WebAssembly binary, model, image pixel,
or recognized text is loaded from or sent to a remote OCR service.

The pinned `tessdata_fast` catalog covers English, Spanish, French, German,
Portuguese, Italian, Vietnamese, horizontal and vertical Japanese, Korean,
Simplified and Traditional Chinese, Russian, Ukrainian, Arabic, Hebrew, Hindi,
Marathi, Bengali, Kannada, Tamil, and Telugu. Only the routed language group is
loaded into memory.

## End-to-end boundary

1. A source Port observes eligible image revisions using the isolated engine's
   private node ID. Scheduling descriptors contain no page URL, image URL,
   text, pixel, or hash.
2. Accessibility text is tried first by default. Decorative, hidden, zero-area,
   filename-like, private, and secret-overlapping evidence is rejected.
3. Pixel OCR of an on-screen image uses a visible stable crop. Simul compares
   the exact document, revision, scroll position, bounds, and image geometry
   before and after capture.
4. `tabs.captureVisibleTab` is limited to two calls per second. The relevant
   crop is proportionally downscaled when necessary so recognition never
   receives more than 4 megapixels.
5. An image the screenshot cannot read (off screen, moving, clipped, or in a
   background tab) is read from its own file (D58). The source tab first
   re-checks the same read policy and the image's own paint path, and returns
   its layout (box, insets, `object-fit`, `object-position`), its CSS natural
   size once loaded, and its HTTP(S) URL. The side panel then draws the
   painted region from, in order: the mirror's already-loaded copy when it
   offers that URL (no request; the mirror is same-origin with the extension
   and the host grant keeps its canvas readable); the tab's own pixels for a
   same-site or CORS-enabled image, encoded in the tab; or, under Passive
   fidelity with a host grant, a `force-cache`, credential-free download of the
   URL (usually answered by Chrome's cache, since the mirror loads the same
   URL). File pixels hold only the image, so the screenshot's overlap and
   cover checks do not apply; text a page paints over the image is not read.
   A lazy image the page has not fetched is described by layout and URL and
   read from a download.
6. A short-lived crop is handed to the offscreen extension document through
   extension-origin storage. The entry is deleted after the job and expires
   after two minutes if normal cleanup is interrupted.
7. Enabled pixel methods run in saved order through a capacity-one scheduler.
   Provider-specific unavailability falls through without starting an
   unbounded retry loop.
8. Accepted regions are translated with the same local Chrome Translator
   boundary as page text and projected as clipped, inert overlays inside
   each image's parent in the replica, so the page's own stacking covers
   them as it covers the image (D74), out of sight of page selectors where
   the parent can host a Simul-owned shadow root (D92).
9. Before commit, the document, image revision, pixel key, language-pair epoch,
   replay lease, replica anchor, and normalized geometry must still match.

Images inside native or ARIA controls require the independent control-images
read-scope switch and are rechecked immediately before and after capture.
Password and credential overlap blocks pixel access under every profile.
Positive-area accessibility labels are not blocked by the pixel-OCR small-image
setting.

## Language routing

The source route is chosen from the nearest valid element language, an explicit
**From** choice, then detected page or bounded image-probe evidence. Explicit
same-language pairs stop before capture. Auto-detected work stops before
recognition when its resolved language equals **To**.

On a text-light page, the memory-only probe considers at most three eligible
images, six representative routes per image, 18 routes total, and 20 seconds.
One high-confidence dominant script or corroboration across distinct images can
establish page evidence. Pixel revisions of the same image are not independent
samples. Probe transcripts and identifiers never enter logs.

Tesseract loads `jpn+jpn_vert` for Japanese. Unsupported language routes fail
cleanly and leave the source image unchanged.

## Quality and caching

Provider-neutral filtering rejects blank, punctuation-only, and regions below
25% confidence. The saved minimum confidence is adjustable from 25–95% in
five-point steps and defaults to 65%. Confidence-free or intermediate-score
regions require matching normalized text and overlapping geometry from an
independent recognition family before they can be promoted.

Recognition and line-translation caches are separate, bounded, and memory-only.
Recognition identity includes the ordered provider/model route, source
language, quality-policy version, confidence threshold, preprocessing profile,
processed dimensions, and SHA-256 pixel key. It deliberately excludes DOM node,
document, and image URL identity. Identical in-flight work joins one provider
load; an oversized result may be returned for the current job but is not kept.

An unchanged empty recognition result must occur twice before it is cached. A
first transient capture failure receives at most one immediate retry. A
responsive resize, crop, or animation frame is recognized again when the
processed pixels or geometry inputs differ, even if the image URL is unchanged.

## Permissions and local assets

Cross-origin images can render while still preventing ordinary canvas reads
in the page. Simul therefore captures the visible tab for on-screen images, and
reads off-screen images from the mirror's copy (readable to the extension under
its host grant) or a cache-first download; only same-site or CORS-enabled
images are read from the page's own copy.
Chrome permits that after a toolbar gesture through `activeTab`; continued
capture after temporary access expires requires the optional literal
`<all_urls>` host grant.

The grant is shared with all-sites automatic translation, requested only from
an explicit user gesture, and removed after both owners are disabled. Saved OCR
intent remains paused when access is absent or revoked; no prompt appears at
startup.

The complete packaged attribution and license set is described in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Tesseract.js,
tesseract.js-core, and the selected language models are Apache-2.0; compiled
core dependencies retain their own permissive notices.

## Diagnostics and limitations

OCR diagnostics identify attempts with ephemeral ordinals and report safe
dimensions, bounded retry choices, method/cache outcomes, region counts, and
projection results. They do not report URLs, pixel hashes, recognized text,
page text, or node/document identifiers.

Expected limits include model and Worker startup cost, memory pressure,
stylized or low-resolution lettering, complex backgrounds, furigana, vertical
ordering, and translations that cannot fit after bounded wrapping and font
reduction. Supported input is currently limited to stable visible top-frame
images; CSS backgrounds, canvas, video, embedded frames, hidden images, and
direct image fetching remain out of scope.

Any future cloud OCR path would require an explicit product decision, a
credential-protecting backend, consent and retention policy, regional and
security review, abuse controls, new permissions, and disclosure that pixels
leave the device. Credentials must never be bundled in the extension. Any new
local runtime or model must be pinned, hash-validated, locally packaged,
license-reviewed, and covered by the normal artifact gate before it can ship.

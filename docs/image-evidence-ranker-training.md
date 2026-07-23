# Image evidence ranker: model decision and training plan

Simul currently uses a deterministic, on-device evidence ranker rather than a
general-purpose AI model. It compares when accessibility text is provisional,
or when an earlier OCR result reaches a later accessibility step in the saved
order. The saved method list remains the attempt and close-tie order, and
accessibility text remains the fallback if OCR cannot produce an admissible
candidate. Selection happens before translation, projection, or Auto-language
voting.

## Model evaluation

| Candidate | Evaluation | Decision |
| --- | --- | --- |
| Transparent deterministic scoring | Uses OCR quality already produced by Simul, independent-family corroboration, exact agreement, bounded text-shape signals, and exact-document repetition. It adds no runtime, weight file, permission, or network dependency. | Shipped for the first release. |
| Bigham 2007 ALT-quality AdaBoost classifier | The closest task-specific published approach, but no licensed pretrained weights were released. Its small English, web-search-dependent corpus is not suitable for an offline multilingual extension. | Do not ship. |
| MS MARCO TinyBERT cross-encoder | Apache-2.0 and relatively small, but trained to rank an English passage against a query. ALT and OCR are competing claims about pixels, not a retrieval query and passage, so its score is not calibrated for the harmful-error asymmetry in this task. | License-compatible but not task-fit; do not ship. |
| all-MiniLM-L6-v2 sentence encoder | Apache-2.0, but trained for English sentence/paragraph embeddings. Similarity can identify agreement; exact normalized agreement already does that without a model, while disagreement still cannot reveal which candidate matches the image. | License-compatible but not task-fit; do not ship. |
| Browser Prompt API / Gemini Nano | Chrome exposes this to extensions, but the generative model is separately downloaded, requires qualifying desktop hardware/storage, and availability and output stability vary by device and browser version. A text-only prompt still cannot inspect the source pixels under the current contract. | Not a deterministic ranking dependency. |
| Simul-specific pairwise logistic model | A small coefficient table can remain fast, deterministic, explainable, and local if it is trained and calibrated on a licensed task-specific dataset. | Future candidate, subject to the gates below. |

Longest-text-wins is intentionally excluded. A longer OCR hallucination is not
better evidence, while accurate image text may legitimately be one word, one
character, or a short control label. Shortness and repetition can justify a
comparison but can never reject accessibility text by themselves. Phrase,
hostname, and language-specific winner lists are also prohibited.

## Runtime feature contract

A future learned ranker may replace only the current numeric weights. Its input
must remain the same bounded, source-neutral feature vector:

- accepted OCR-region counts, selected-provider confidence bands, and
  independent OCR-family corroboration;
- normalized semantic/OCR agreement and bounded meaningful-character, token,
  and character-variety signals;
- whether the normalized semantic evidence repeats across current images in
  the same exact document.

The saved method position is not a learned feature. It is applied only after
the calibrated decisive margin cannot separate the candidates.

It must not use source URLs, hostnames, DOM identifiers, page categories,
language-specific phrases, translated text, user feedback, or the identity of
a person or site. The two Tesseract bindings remain one OCR family. Existing
confidence admission and credential/read-scope policy run before ranking and
cannot be weakened by a model.

## Reproducible dataset

Training data must be built offline from synthetic image fixtures and
redistributable, permissively licensed image/text corpora. Runtime browsing
data is never sampled: the extension must not collect, persist, export, or
upload candidates, outcomes, images, labels, or feedback.

Each manifest row records a stable sample ID, source and license, a site/corpus
group used only for splitting, language/script tags, the semantic candidate,
captured OCR candidates and quality summaries, and an independently reviewed
label: `semantic-better`, `ocr-better`, `equivalent`, or `unusable`. The corpus
must deliberately include accurate short ALT, repeated generic ALT, weak and
hallucinated OCR, semantic/OCR agreement, multilingual scripts, stylized text,
and provider disagreement. Derived crops, resizes, and text variants inherit
their source group so they cannot cross a split boundary. Reviewers are blind
to provider name and saved method order; disagreements are adjudicated before
the manifest is frozen.

The dataset manifest, fixture hashes, licenses, feature-schema version, and
tool versions are committed together. A locked, network-disabled preparation
command regenerates features in stable sample order. Any fixture without clear
redistribution and model-training rights is rejected before training.

## Pairwise training and calibration

The model predicts whether the OCR candidate should beat the semantic
candidate from their feature difference. Train an L2-regularized logistic
regression with a fixed seed and deterministic numeric preprocessing. Use
decisive labels for fitting; retain `equivalent` and `unusable` cases for
calibration and abstention tests rather than forcing an artificial winner.

Split by site/corpus group before any augmentation, with language/script
stratification across development, calibration, and final test sets. Select
regularization by grouped cross-validation within the development partition,
then calibrate the frozen model's probability with temperature scaling on the
separate calibration partition and freeze two decision thresholds around an
abstention band. An abstention preserves the saved method order. The final
site-held-out test partition remains untouched until the weights, calibration,
and thresholds are frozen.

The training output is a small, reviewed coefficient table containing the
feature-schema version, ranking-policy version, intercept, weights,
normalization constants, calibration value, and decisive thresholds. It must
reproduce byte-for-byte from the manifest and fixed toolchain without adding a
runtime ML dependency.

## Release and safety gates

A learned policy can replace deterministic weights only when all of these hold
on the untouched site-held-out suite:

1. OCR-over-valid-semantic and generic-semantic-over-clear-OCR errors are each
   no worse than the deterministic baseline under the predeclared bootstrap
   confidence bound, and at least one materially improves.
2. Accurate short labels, multilingual/script slices, exact agreement,
   same-family OCR, and close-score order reversal tests meet their frozen
   per-slice tolerances; no aggregate gain may hide a harmful slice regression.
3. Missing permission, small-image ineligibility, empty/unavailable OCR,
   transient retry exhaustion, mutation, reset, and reconnect preserve the
   semantic fallback and stale-result rules in every case.
4. Credential exclusion, source-side read admission, selected-only translation
   and Auto voting, content-free diagnostics, and bounded memory have zero
   violations.
5. Coefficients and training inputs pass license review, evaluation remains
   comfortably below the existing per-image scheduling budget, and the build
   adds no permission, network call, remotely hosted code, or telemetry.

Results are recorded by dataset and ranking-policy version. There is no live
learning or shadow telemetry; future evaluation uses only the committed
offline suite. If any gate fails, Simul retains the deterministic policy.

## Evaluated sources

- Jeffrey P. Bigham et al., [Increasing Web Accessibility by Automatically Judging Alternative Text Quality](https://www.cs.cmu.edu/~jbigham/pubs/pdfs/2007/alt-text-quality.pdf) (IUI 2007).
- Sentence Transformers, [MS MARCO TinyBERT-L2-v2 model card and files](https://huggingface.co/cross-encoder/ms-marco-TinyBERT-L2-v2) (Apache-2.0).
- Sentence Transformers, [all-MiniLM-L6-v2 model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) and [license](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/blob/main/LICENSE) (Apache-2.0).
- Chrome for Developers, [Prompt API requirements and availability](https://developer.chrome.com/docs/ai/prompt-api).

These links identify evaluated upstream artifacts; none is downloaded,
bundled, or executed by this branch.

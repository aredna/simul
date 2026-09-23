**Minor update.** Simul works the same as 0.5.0. This release completes the
third-party license notices for the packaged OCR engine and simplifies the
README.

Simul is a Chrome extension that shows a translated copy of the page you are
reading next to the original. Translation runs on your own computer through
the browser's built-in Translator API, so page text never leaves your machine.

## What changed

- **OCR license notices completed.**
  - The two tesseract.js files Simul changes (to stop them fetching code from
    the internet) now say so at their top, and the notices list the changes.
  - The notices now include the Emscripten runtime and musl C library
    licenses, which are compiled into the OCR engine.
  - `base64-js` is now listed.
  - `ieee754` names its correct copyright holder.
  - The inventory now matches what the extension actually contains.
- **Shorter README.** It covers what Simul does, the requirements, where it
  does not work, and how to install and use it. The detailed reference moved
  to `docs/reference.md`.

## Requirements

- Google Chrome 138 or newer, or Microsoft Edge 148 or newer, on a desktop or
  laptop (Simul is tested in Chrome)
- About 35 MB of disk space

Firefox, Safari, and browsers on phones and tablets do not have the Translator
API. Other Chromium-based browsers can load Simul but translate only if they
include the API.

## Install or update

1. Download `simul-0.5.1-chrome-unpacked.zip` below and unzip it.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on
   **Developer mode**.
3. Select **Load unpacked** and choose the `chrome-unpacked` folder. If you
   already have Simul, replace its folder and select **Reload** on the Simul
   card.

Simul's settings show `Build 0.5.1 beta v.20260924.1`.

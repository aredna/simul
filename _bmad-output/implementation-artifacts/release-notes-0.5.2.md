Simul is a Chrome extension that shows a translated copy of the page you are
reading next to the original. Translation runs on your own computer through
the browser's built-in Translator API, so page text never leaves your machine.

This release fixes how real sites look and behave in the mirror.

## What changed

- **Hover menus open.** Menus in page headers that open when you point at
  them now open in the mirror, whether you point at them on the page or in
  the mirror.
- **Reddit and other big pages.** Reddit mirrors with its own styles. Long
  feeds keep following as you scroll, and threads open instead of failing
  with "could not be prepared". Other pages built from web components benefit
  too.
- **One scroll bar.** Fit mode no longer shows two.
- **The From menu names the detected language,** for example `[A] English`.
- **Changing languages translates at once.** Picking a language whose pack is
  not installed yet starts the translation, and the page updates as soon as
  the pack arrives, with no refresh.
- **Faster image translation.** Carousel slides and images you scroll back to
  reuse their translation instead of being read again. An image with no text
  is not read again either.
- **Menus and dropdowns look like the page.** Account menus and pickers keep
  the page's styles, icons and position instead of drawing as a plain list.
- **Styles added later reach the mirror,** even on pages with very large
  stylesheets, so side navigation stays where the page puts it.
- **Images from signed-in apps show,** such as the small account picture in
  a web app's corner.
- **No video play bars.** The mirror cannot play video, so it no longer draws
  a play bar over the poster.

## Requirements

- Google Chrome 138 or newer, or Microsoft Edge 148 or newer, on a desktop or
  laptop (Simul is tested in Chrome)
- About 35 MB of disk space

Firefox, Safari, and browsers on phones and tablets do not have the Translator
API. Other Chromium-based browsers can load Simul but translate only if they
include the API.

## Install or update

1. Download `simul-0.5.2-chrome-unpacked.zip` below and unzip it.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on
   **Developer mode**.
3. Select **Load unpacked** and choose the `chrome-unpacked` folder. If you
   already have Simul, replace its folder and select **Reload** on the Simul
   card.

Simul's settings show `Build 0.5.2 beta v.20260925.1`.

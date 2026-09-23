# Simul

Simul is a Chrome extension that shows a translated copy of the web page you
are reading next to the original, as a live, read-only mirror in the side panel
or a separate window.

Translation happens on your own computer. Simul uses the browser's built-in
**Translator API**: Chrome and Edge translate with language models that run on
your device. Page text never leaves your machine: there is no server, no
account, and no API key. Text inside images is read locally too, with the
Tesseract OCR engine packaged in the extension.

Simul started as a quick build for the OpenAI Build Week hackathon, made as
something we would use ourselves. We are now sharing it so others can use it
too.

## Requirements

- Google Chrome 138 or newer, or Microsoft Edge 148 or newer, on a desktop or
  laptop (Simul is tested in Chrome)
- About 35 MB of disk space

The first time you translate into a new language, the browser may download
that language pack.

**Where it does not work:** Firefox, Safari, and browsers on phones and tablets
do not have the Translator API. Other Chromium-based browsers, such as Brave,
Opera, or Vivaldi, can load Simul but translate only if they include the API.

## Install

1. Download `simul-<version>-chrome-unpacked.zip` from the
   [latest release](https://github.com/aredna/simul/releases/latest) and unzip
   it.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on
   **Developer mode**.
3. Select **Load unpacked** and choose the `chrome-unpacked` folder.

To update, replace the folder and select **Reload** on the Simul card.

## Use

1. Open a web page and select the Simul icon.
2. Pick the **To** language and select **Translate page**.
3. To translate text in images, select **OCR** once to allow image access.

## License

Simul is [MIT licensed](LICENSE). Third-party components, including the
Tesseract OCR engine and its language data, keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). How it works, privacy,
permissions, and development notes are in [docs/reference.md](docs/reference.md).

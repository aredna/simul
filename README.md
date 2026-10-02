# Simul

Simul is a Chrome extension that shows a translated copy of the web page or
PDF you are reading next to the original, as a live, read-only mirror in the
side panel or a separate window.

Translation happens on your own computer. Simul uses the browser's built-in
**Translator API**: Chrome, Edge and Opera translate with language models that
run on your device. Page text never leaves your machine: there is no server, no
account, and no API key. Text inside images is read locally too, with the
Tesseract OCR engine packaged in the extension.

Simul started as a quick build for the OpenAI Build Week hackathon, made as
something we would use ourselves. We are now sharing it so others can use it
too.

## Requirements

- Google Chrome 138 or newer, Microsoft Edge 148 or newer, or Opera 122 or
  newer, on a desktop or laptop (Simul is tested in Chrome)
- About 43 MB of disk space

Any browser that supports the Translator API should work. You can check a
browser at [caniuse.com](https://caniuse.com/mdn-api_translator).

The first time you translate into a new language, the browser may download
that language pack.

**Where it does not work:** Firefox, Safari, and browsers on phones and tablets
do not have the Translator API. Other Chromium-based browsers, such as Brave or
Vivaldi, can load Simul but translate only if they include the API.

## Install

1. Download `simul-<version>-chrome-unpacked.zip` from the
   [latest release](https://github.com/aredna/simul/releases/latest) and unzip
   it.
2. Open `chrome://extensions` (`edge://extensions` in Edge,
   `opera://extensions` in Opera) and turn on **Developer mode**.
3. Select **Load unpacked** and choose the `chrome-unpacked` folder.

To update, replace the folder and select **Reload** on the Simul card.

## Use

1. Open a web page or a PDF and select the Simul icon.
2. Pick the **To** language and select **Translate page**.
3. To translate text in images, select **OCR** once to allow image access.

The mirror follows the page as you scroll and zoom it.

In a PDF, each translated paragraph is written over the original, in its
place. Scanned pages are read on your computer while they are translated.
Simul cannot read a PDF saved on your computer from its tab: select the Simul
icon there and choose **Open a PDF file…**, or drop the file on Simul.

## License

Simul is under the [MIT License with the Commons Clause](LICENSE): free to
use, change and share, but not to sell. Third-party components, including the
Tesseract OCR engine and its language data, keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). How it works, privacy,
permissions, and development notes are in [docs/reference.md](docs/reference.md).

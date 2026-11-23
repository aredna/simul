# Simul

Simul is a Chrome extension. It shows a translated copy of the web page or
PDF that you read, next to the original. The copy is a live, read-only
mirror in the side panel or in a separate window.

The translation occurs on your computer. Simul uses the **Translator API**
of the browser: Chrome, Edge and Opera translate with language models on
your device. The text of the page does not go from your computer. There is
no server, no account and no API key. Simul also reads text in images on
your computer, with the Tesseract OCR engine that is in the extension.

We made Simul quickly for the OpenAI Build Week hackathon, as a tool for our
own use. Now we share it, so that other persons can use it too.

## Requirements

- Google Chrome 141 or later, Microsoft Edge 148 or later, or Opera 125 or
  later, on a desktop or laptop computer (we test Simul in Chrome)
- Approximately 43 MB of disk space

All browsers that have the Translator API can operate Simul. To examine a
browser, go to [caniuse.com](https://caniuse.com/mdn-api_translator).

When you translate into a new language for the first time, the browser can
download the language pack for that language.

**Where Simul does not operate:** Firefox, Safari, and browsers on phones
and tablets do not have the Translator API. Other browsers that use
Chromium, for example Brave or Vivaldi, can load Simul. They translate only
if they have the API.

## Install

1. Download `simul-<version>-chrome-unpacked.zip` from the
   [latest release](https://github.com/aredna/simul/releases/latest).
2. Unzip the file.
3. Open `chrome://extensions` (`edge://extensions` in Edge,
   `opera://extensions` in Opera).
4. Turn on **Developer mode**.
5. Select **Load unpacked**.
6. Select the `chrome-unpacked` folder.

To update Simul:

1. Replace the folder.
2. On the Simul card, select **Reload**.

## Use

1. Open a web page or a PDF.
2. Select the Simul icon.
3. Select the **To** language.
4. Select **Translate page**.
5. To translate text in images, select **OCR**.

The mirror follows the page when you scroll and zoom the page.

In a PDF, Simul writes each translated paragraph over the original, in the
same position. Simul reads scanned pages on your computer when it translates
them.

Simul cannot read a PDF on your computer from the tab of that PDF. To
translate this PDF, do one of these steps:

- Select the Simul icon, and then select **Open a PDF file…**.
- Drag the file onto Simul.

## Privacy

Simul has no server, no account and no analytics. [PRIVACY.md](PRIVACY.md)
tells you what Simul reads, where Simul keeps it, and which requests go on
the network.

## License

Simul has the [MIT License with the Commons Clause](LICENSE). You can use,
change and share Simul free of charge. You cannot sell Simul. Third-party
components, for example the Tesseract OCR engine and its language data, have
their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
For information about how Simul operates, privacy, permissions and
development, see [docs/reference.md](docs/reference.md).

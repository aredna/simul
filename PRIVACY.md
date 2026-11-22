# Simul privacy policy

Last updated: 2026-11-21

Simul is a Chrome extension that shows a translated copy of the web page or
PDF you are reading. It works on your own computer. It has no server, no
account, no analytics and no ads, and it sends nothing to its developer.

## What Simul reads

Only the tab you open Simul on, after you select the Simul icon (or a site
you chose for automatic translation):

- **The page:** its text, images and layout, so the mirror can show it. The
  read profile in Options decides how much: page text only, or also visible
  form fields and autofilled values. Passwords, payment-card numbers and
  one-time codes are never read.
- **The tab's address,** to follow the tab and to remember the sites you
  chose for automatic translation.
- **Your clicks, keys, focus and scrolling on that page,** only to keep the
  mirror in step with it. Keystrokes are not recorded.
- **Pictures for image text:** when you turn on image text, Simul takes a
  picture of the visible tab and keeps only the parts with images, to read
  the text in them.
- **PDFs** you open in Chrome or choose from your computer.

## Where it is kept

- What Simul reads stays in the panel's memory while the panel is open.
- Your settings (languages, zoom, read profile, sites for automatic
  translation) are saved by Chrome on your computer. They are not synced.
- Pictures of images wait in the extension's own temporary storage until
  they are read, at most two minutes, and are then deleted.

## What leaves your computer

Nothing Simul reads is sent to Simul's developer or to any other company.
Translation, language detection and reading text in images all run on your
computer. Some requests do go over the network:

- The mirror loads the page's own images, styles and fonts from the page's
  own site, as the page itself does.
- To read text in an image, Simul may download that image again from its
  own address, without your cookies.
- A style sheet the page loaded from another site (a CDN) is read again,
  without your cookies, from the copy your browser keeps of it (or from its
  own address, if the browser no longer has it), only to know which names it
  mentions, so Simul can skip work the page's changes do not need. Nothing
  else is taken from it.
- A style sheet the page's site redirected to another address is asked for
  once more, without your cookies, only to learn that address, so the
  mirror finds the sheet's images and fonts.
- On a PDF tab, Simul downloads that PDF once more from its own address,
  with the site's cookies, as the tab did.
- The first time you translate into a new language, Chrome may download that
  language pack from Google. This is Chrome's own download; the text you
  translate is not sent.

Simul uses Chrome's on-device language models (Gemini Nano and the language
detector) only when they are already installed. It never downloads them.

## Site access

Simul can read the pages you open from the time you install it, so the
panel follows each page and tab without a click on its icon. It reads a page
only while its panel shows that page, and nothing it reads leaves your
device. You can limit it in Chrome's extension settings (Site access: On
click, or a list of sites); Simul then reads a tab after you select its icon
there, and its panel offers to let it read all sites again. Access to one
site that Simul asked for, for automatic translation on that site, it gives
back when you turn that off.

## Deleting your data

Select **Reset all extension settings** in Simul's Options to clear your
settings. Removing Simul from Chrome deletes everything it stored.

## Chrome Web Store User Data Policy

The use of information received from Google APIs will adhere to the Chrome
Web Store User Data Policy, including the Limited Use requirements. Simul
does not sell data, does not use it for anything except showing and
translating the page you read, and does not use it to decide credit or
lending.

## Changes

Changes to this policy are made in this file; its history is public in this
repository.

## Contact

Questions about privacy: open an issue at
https://github.com/aredna/simul/issues

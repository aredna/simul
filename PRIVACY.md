# Simul privacy policy

Last updated: 2026-11-23

Simul is a Chrome extension. It shows a translated copy of the web page or
PDF that you read. It operates on your computer. It has no server, no
account, no analytics and no advertisements. It sends nothing to its
developer.

## What Simul reads

Simul reads only the page that its panel shows, and only while the panel is
open (see "Site access" below):

- **The page:** its text, images and layout. The mirror must have these to
  show the page. This includes the frames in the page that come from a
  different site, for example a sign-in button. The read profile in Options
  sets how much Simul reads:
  - Page only: the text of the page.
  - Standard: also the labels and pictures of buttons, and folded sections.
  - Full visible: also the content of visible form fields and text editors,
    and values that the browser filled in automatically.

  Simul never reads passwords, payment-card numbers or one-time codes. For
  a password field, Simul receives only the number of characters, to show the
  same number of dots.
- **The address of the tab:** Simul uses it to follow the tab. It also uses
  it to remember the sites that you selected for automatic translation.
- **Your clicks, keys, focus and scroll movements on that page:** Simul uses
  them only to keep the mirror the same as the page. Simul does not record
  your keystrokes.
- **Pictures for image text:** when you start image text, Simul takes a
  picture of the visible part of the tab. It keeps only the parts with
  images, and it reads the text in them.
- **PDFs** that you open in Chrome or select from your computer.

## Where Simul keeps the data

- The data that Simul reads is in the memory of the panel while the panel is
  open.
- Chrome saves your settings on your computer: languages, zoom, read profile
  and the sites for automatic translation. Chrome does not sync them.
- Pictures of images are in the temporary storage of the extension until
  Simul reads them. After a maximum of 2 minutes, Simul deletes them.

## What goes from your computer

Simul does not send the data that it reads to its developer or to a
different company. Translation, language detection and the reading of text
in images occur on your computer. Some requests go on the network:

- The mirror loads the images, styles and fonts of the page from the
  locations where the page loads them (the site of the page or the sites
  that the page uses). The page does the same.
- To read the text in an image, Simul can download that image again from its
  address, without your cookies.
- If the page loaded a style sheet from a different site (a CDN), Simul
  reads that style sheet again, without your cookies. It reads the copy that
  your browser keeps. If the browser does not have the copy, Simul reads the
  style sheet from its address. Simul uses the style sheet only to find the
  names that it contains. Then Simul can skip work that the changes of the
  page do not make necessary. Simul takes nothing else from the style sheet.
- If the site of the page sent a style sheet to a different address, Simul
  asks for the style sheet one more time, without your cookies. Simul does
  this only to find that address. Then the mirror can find the images and
  fonts of the style sheet.
- On a PDF tab, Simul downloads that PDF one more time from its address,
  with the cookies of the site. The tab did the same.
- When you translate into a new language for the first time, Chrome can
  download the language pack for that language from Google. This is a
  download that Chrome does. Chrome does not send the text that you
  translate.

## Site access

Simul can read the pages that you open after you install it. Because of
this, the panel follows each page and tab, and it is not necessary to click
the Simul icon.
Simul reads a page only while its panel shows that page. The data that it
reads does not go from your computer.

You can limit this access in the extension settings of Chrome (Site access:
On click, or a list of sites). Then Simul reads a tab only after you select
the Simul icon on that tab. The panel then shows a button that allows
Simul to read all sites again.

For automatic translation on one site, Simul can ask for access to that
site. When you stop automatic translation on that site, Simul gives the
access back.

## How to delete your data

To delete your settings, select **Reset all extension settings** in the
Options of Simul. When you remove Simul from Chrome, Chrome deletes all the
data that Simul stored.

## Chrome Web Store User Data Policy

The use of information received from Google APIs will adhere to the Chrome
Web Store User Data Policy, including the Limited Use requirements. Simul
does not sell data. Simul uses data only to show and translate the page that
you read. Simul does not use data to make decisions about credit or loans.

## Changes

We make changes to this policy in this file. The history of this file is
public in this repository.

## Contact

For questions about privacy, open an issue at
https://github.com/aredna/simul/issues

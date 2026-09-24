# History rewrite SHA map (2026-09-24, D80)

The 56 `main` commits from the D43 addendum onward were rewritten to remove
private details (decision log D80). Older SHAs cited in the decision log and
handovers map to the current `main` as follows (old -> new, subject). Commits
before these kept their SHAs.

```text
49ea98e -> 125b153  chore: publish 0.5.1, a minor update (D79)
a163309 -> 1f3ce36  docs: minimal README; complete the OCR license notices (D78)
876959a -> 864c9ab  docs: 0.5.0 release notes, browser requirements, redact private details (D77)
fdb72d2 -> b714d13  fix(privacy): show author attributes, output, spinbutton text and credential boxes (D76)
8569761 -> 6073e18  feat(privacy): Show everything (testing); stop hiding visible text (D75)
41b3499 -> 17fa64e  docs: handover updated for D73-D74
a7596df -> b22fc5e  fix(ocr): image translations paint where the image paints (D74)
8bcdf6e -> 72b81d8  fix(companion): the side panel follows the active tab; Follow / Pinned works there (D73)
d0d167e -> f95efc3  docs: handover updated for D71-D72
78e5bda -> 242e522  feat(replica): embedded data-URL fonts; caption band grows when needed (D72)
b37e3f8 -> 3ca9d1d  fix(replica): choosing an option closes the mirror's dropdown (D71)
39c092b -> 9641c6f  docs: handover updated for D70
6ddd6ed -> 794b5f6  fix(localization): placeholders, count label, lang and dir; bump script (D70)
3e45b66 -> 04cdc3e  docs: handover updated for D69
27b3573 -> b4093b1  fix(localization): status text re-renders in the current UI language (D69)
58a5d74 -> 936d36d  docs: handover for D63-D68 (limits, quirks, defaults, hidden labels, T1-T3)
a21a9d0 -> 69997c9  fix(translation): newer snapshots, the OCR lock and unreadable storage (D68)
d811f51 -> 7d1cd04  perf(translation): hidden accessible names are no longer translated (D67)
426d3a8 -> 8dc507a  feat(defaults): Full visible, Follow and 1:1 for new installs (D66)
b51081e -> 79c7fe8  fix(replica): a quirks page's replica is in quirks mode (D65)
80e8169 -> f2c65c3  feat(settings): mirror size limits in Advanced; fidelity moves there (D64)
0651a97 -> 82bae01  feat(replica): size caps follow what Chrome carries; faster capture (D63)
9ab6066 -> 666bcc3  docs: session-close handover, truthful-first ruling, and corrected fidelity gaps
91c285f -> 9d0246f  docs: handover for D62
9f8e3ec -> 9b94826  fix(replica): dropdowns and menus open in the mirror on real pages (D62)
e61a73c -> f3c794c  docs: handover for D61 and the open dropdown report
2292184 -> e8aca16  fix(follow): wait for a new tab's web page, then follow it (D61)
84e7683 -> beda235  docs: release-notes reminder covers D51-D60
d332f6c -> d941555  docs: handover for D60 and the two queued owner reports
228ae4d -> 89c4537  fix(replica): keep a large stylesheet and the browser's own html and body (D60)
4dd57e6 -> 5a60d27  docs: handover for the D56-D59 follow-up session
85342b1 -> 86fc3e0  feat(ocr): let an installed on-device model break close alt/OCR calls (D59)
fe6d2a6 -> 4120d1e  feat(ocr): read off-screen images from their own file (D58)
7061cc2 -> 665b95c  fix(replica): a carousel track is painted when the slide it overflows into is (D57)
355c944 -> 1a3ae11  fix(replica): a carousel move is a live patch, not a mirror rebuild (D56)
d8ecb78 -> f8085bd  docs: handover for the .14 bug hunt and the three open owner reports (D55 addendum)
64db19e -> ad6ed54  fix(replica): follow the source scroll only when the source moves (D55)
33c2167 -> 8d56924  docs: record the owner's read-scope, tab-follow and mirror-size rulings for after the bug hunt (D54 addendum)
1a8374f -> 070e376  docs: refresh the session-close handover for D51-D54 and the open bug hunt
86dddf6 -> a866733  fix(replica): require a really painted box before showing declared-hidden or stateless-controlled regions (D54)
0022692 -> 67ccccd  docs: record fix status and the simplification proposal in the bug-hunt review
e9bc6b1 -> d133bb4  fix(preferences): keep a pending reset from re-adopting the broad grant; let the OCR button turn OCR off after a refusal (D53)
c1e0321 -> fa28d95  fix(ocr): clip image overlays to what the page shows and follow slide motion (D52)
0f94989 -> c929928  fix(sidepanel): keep read-scope toggle descriptions through a localization pass (D51)
cbcd489 -> 80d8357  docs: bug-hunt review of PR #22 with verified findings and owner-chosen fix order
ead4ea1 -> 16a4e10  docs: D50 addendum, owner confirmation of the carousel fix, and the overlay-placement assessment
5570962 -> 4f86b31  fix(replica): a class flip on a region of links and buttons is not a masking transition (D50)
e7652bf -> f4d1431  fix(replica): keep a carousel controlled by stateless buttons readable (D49)
4989736 -> 6de947f  docs: session-close handover for the 0.5.0 release candidate (D48 addendum)
5c1df07 -> 3015a0d  fix(ocr): show a label-based image translation as a caption band, not over the whole image (D48)
34808b0 -> fa0df73  docs: record the OCR overlay ruling and close the Chrome-pass items (D47 addendum)
9ddaafb -> 3402311  feat(preferences): turn image translation on by default and keep reset clearing every grant (D47)
12d12c7 -> 9986731  feat(sidepanel): translate page text together with image text when OCR is on (D46)
bb0dec4 -> 4f36fba  fix(replica): let computed style decide whether a declared-hidden region is hidden (D45)
5305606 -> 3581b2b  fix(replica): keep stylesheet text inside hidden regions (D44)
6cff3fe -> 4df7ed1  chore: publish 0.5.0 testing build and write the README for a public reader (D43 addendum)
```

# Security policy

## Supported version

We correct security problems in the latest release candidate on the `main`
branch. We do not support older unpacked builds.

## Report a vulnerability

To send a private vulnerability report, use the **Security** tab of this
repository (GitHub Private Vulnerability Reporting). Do not open a public
issue that contains an exploit, credentials, private page content,
screenshots of private pages or recognized OCR text.

A good report gives this information:

- The Simul version and the Chrome version.
- The part of the mirror engine that has the problem.
- The security boundary that you expected.
- A minimal public procedure that shows the problem.

Before you send the report, remove tokens, account data, URLs that contain
secrets, passwords and private page content.

The primary security boundaries of Simul are:

- The mirror does not execute scripts.
- Private and editable controls are masked.
- There is no executable code from remote locations.
- Simul reads a page only while the panel shows that page.
- Simul parses data within fixed limits.
- Diagnostics do not contain page content.

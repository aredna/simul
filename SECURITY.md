# Security policy

## Supported version

Security fixes are applied to the latest committed release candidate on the
`main` branch. Older unpacked builds are not supported.

## Report a vulnerability

Use this repository's **Security** tab to submit a private vulnerability
report through GitHub Private Vulnerability Reporting. Do not open a public
issue containing an exploit, credentials, private page content, screenshots
of private pages, or recognized OCR text.

A useful report identifies the Simul version, Chrome version, affected replica
engine, expected security boundary, and a minimal public reproduction. Remove
tokens, account data, URLs containing secrets, passwords, and private page
content before submitting.

Simul's critical boundaries include scriptless replica execution, masked
private/editable controls, no remotely hosted executable code, explicit host
access, bounded parsing, and content-free diagnostics.

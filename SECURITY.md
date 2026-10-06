# Security Policy

## Supported Versions

This repository is pre-1.0.
Use the default branch for security fixes.

## Report a Vulnerability

Report suspected vulnerabilities privately.
Do not open a public issue with exploit details.

Use GitHub private vulnerability reporting for this repository when it is available:

```text
https://github.com/simonrab/OpenEval/security/advisories/new
```

If that page is unavailable, open a public issue that asks for a private contact path.
Do not include exploit details in that issue.

## Secret Handling

Never commit a real `.env` file.
Never commit SQLite data files.
Never paste real provider keys into tests, examples, issues, or pull requests.

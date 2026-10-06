# Contributing

Thank you for your interest in OpenEval.

## Local Setup

Use Node.js 22.

```bash
nvm use
npm ci
npm run build
npm test
```

If the SQLite native module fails after a Node.js change, rebuild it.

```bash
npm rebuild better-sqlite3
```

## Pull Requests

Keep each pull request focused.
Add or update tests for each behavior change.
Run `npm run build` and `npm test` before you open a pull request.

Do not commit local secrets, SQLite files, generated output, or editor state.
Use `.env.example` to document environment variables.

## Product Language

Use the word `eval` for product checks.
Do not call an eval a unit test.
Use `test` only for implementation tests.

## Security

Do not include real keys, tokens, customer data, or private logs in an issue or pull request.
Follow [SECURITY.md](SECURITY.md) for vulnerability reports.

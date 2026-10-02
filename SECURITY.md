# Security and responsible use

## Intended boundary

This is a single-owner, local-first journal. Public source availability is not approval to expose a running instance to the internet. Keep the default loopback listener or use a private authenticated tunnel. Complete owner enrollment over a trusted local connection before considering any broader access.

Production internet exposure requires a separate security assessment, HTTPS, Secure cookies, and correct Host/Origin configuration. Do not disable origin checks to make a proxy work.

## Sensitive material

Never commit real journal content, database files or WAL/SHM files, exports, snapshots, session keys, owner credentials, assistant tokens, SSH keys, environment files, screenshots containing health data, or private runtime/deployment logs. `.gitignore` is a guardrail, not a data-loss prevention system. Inspect the exact staged files and history before every push.

Use separate scoped and expiring assistant credentials. Revoke and replace a credential if it leaks. Removing a secret from the latest commit is not sufficient after it has entered Git history or been published.

Data is not encrypted by this application. Protect host access, the external data directory, and backups. Treat database snapshots as sensitive even if passwords and bearer tokens are hashed.

## Tests and dependency maintenance

Use only synthetic fixtures and disposable external data directories for tests and demos. Never run a recovery or migration test against a live journal. Preserve current records when restoring and verify a restored copy before replacing any data.

Run typechecks, tests, a lockfile-aware dependency audit, and a secret scan before publication. Dependency scanners identify known advisories, not all possible defects. No security certification or guaranteed response time is claimed.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting channel if enabled. Do not put exploit details, tokens, database snapshots, exports, or personal data in a public issue. If no private reporting channel is available, ask for one without disclosing the sensitive details.

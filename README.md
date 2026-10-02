# Wellbeing Dashboard

A local-first, single-owner sleep and wellbeing journal built with TypeScript, React, Fastify, and SQLite. Record manual events and narrative notes, preserve uncertainty and correction history, and give assistants separate revocable API credentials.

The initial database is empty. There is no default password, public signup, telemetry, wearable connection, or built-in AI service. This is a personal journal, not medical advice.

## Run locally

Requires Node.js 24 LTS and npm 11. Dependencies are pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm run build
WELLBEING_DATA_DIR="$HOME/.local/share/wellbeing-dashboard" WELLBEING_HOST=127.0.0.1 npm start
```

Open <http://127.0.0.1:8787> and create the single owner account. Choose a unique password of at least 12 characters. Enrollment closes after the first account is created. There is no password-reset flow.

Use a private absolute data directory **outside this checkout**. It contains the SQLite database, session key, and backups. Never commit or upload that directory. Do not point demo commands or tests at your real journal.

For local development, `npm run dev` starts the loopback-only development server. Development uses HTTP cookies and is not an internet deployment configuration.

## Features

- Manual events with local timezone and explicit UTC offsets
- Overnight and nap grouping, narrative notes, and immutable revision history
- Uncertainty ranges, provenance, and correction links
- Coverage-aware summaries that keep missing values unknown
- Search, filters, and JSON/CSV export
- Separate expiring assistant credentials with scoped access
- Transactional Markdown/YAML legacy import
- Consistent SQLite snapshots and guarded restore

A bedtime intention is not a sleep-onset observation. The onset-to-final-wake window is not automatically time asleep. Restedness is a separate subjective report.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WELLBEING_DATA_DIR` | `$HOME/.local/share/wellbeing-dashboard` | Absolute private data directory outside the checkout |
| `WELLBEING_HOST` | `127.0.0.1` | Listener address |
| `WELLBEING_PORT` | `8787` | Listener port |
| `WELLBEING_ALLOWED_ORIGIN` | unset | Exact HTTPS origin for a non-loopback production bind |
| `NODE_ENV` | development | Set `production` for Secure cookies |

**Public source does not mean a public service.** Loopback access is the default. Prefer a private SSH tunnel for remote access. An internet-facing deployment needs its own security assessment, HTTPS termination, and correctly configured Host/Origin handling. Do not expose an unclaimed owner-setup screen to an untrusted network.

## Assistant API

Create a distinct assistant credential through **Access** in the owner UI. Tokens are displayed once. Keep them outside the repository and send them only in the Authorization header.

Supported scopes: `events:read`, `events:write`, `notes:read`, `notes:write`, and `trends:read`. Assistant credentials do not grant owner administration, credential management, import, backup/restore, or destructive erase.

Use a stable `Idempotency-Key` across retries of the same logical mutation. Event and note amendments require the last-read `expectedRevision`; handle `409` by reading and reconciling, not blindly overwriting. Factual corrections can append a new event linked through `supersedesEventId`. Preserve source independently from the authenticated recorder.

- [API examples](docs/api-examples.md)
- [Schema and integrity reference](docs/schema-reference.md)
- OpenAPI contract: `GET /api/v1/openapi.json`

## Backup and import

```sh
WELLBEING_DATA_DIR=/absolute/private/data npm run backup -- create before-upgrade
WELLBEING_DATA_DIR=/absolute/empty/restore-target npm run backup -- restore /absolute/private/data/backups/SNAPSHOT.sqlite
WELLBEING_DATA_DIR=/absolute/private/data npm run import:legacy -- /absolute/legacy-export/*.md
```

Stop the server before restoring. Restore into a fresh empty directory and verify the restored content before adopting it. Never overwrite newer journal entries with an older snapshot. Snapshots and exports contain sensitive plaintext data, including authentication hashes in database backups. Use encrypted host backups and restrictive filesystem permissions.

The importer preserves original text, IDs, supported legacy fields, unknown fields, and correction links. It rejects malformed batches, conflicting IDs, dangling correction links, and cycles rather than guessing. All committed fixtures are fictional.

## Verification

```sh
npm run check
npm run test:unit
npm run test:integration
npm run build
```

The synthetic browser harness creates isolated temporary databases and uses fresh loopback ports:

```sh
npx playwright install chromium
npm run test:e2e
```

Alternatively, set `WELLBEING_BROWSER_EXECUTABLE` to a compatible installed Chromium executable. Compatibility depends on the browser and Playwright versions. Keep test artifacts outside source control.

`npm run test:smoke` runs synthetic HTTP and recovery checks.

### Optional demo: use a fresh directory

**The demo command does not enforce disposable storage.** It requires `WELLBEING_DEMO_CONFIRM=SYNTHETIC_ONLY`, but if `WELLBEING_DATA_DIR` is omitted it uses the normal default journal directory. An explicitly selected existing journal is also accepted. Either mistake can add synthetic records to real data. Never run the demo against a personal journal.

On a Unix-like system, create a fresh external directory and supply it explicitly:

```sh
DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wellbeing-demo.XXXXXX")" &&
WELLBEING_DATA_DIR="$DEMO_DIR" WELLBEING_DEMO_CONFIRM=SYNTHETIC_ONLY npm run demo:seed
```

The `&&` prevents seeding if directory creation fails. Keep the explicit directory assignment when copying this command. The new directory contains only disposable synthetic demo data; the command does not switch your running application's data directory.

## Privacy and limitations

SQLite, exports, and backups are **not encrypted by the application**. Protect the host account, filesystem, transport, and backup storage. This version has one owner, no password reset, no wearable adapter, no cloud sync, no built-in model calls, and no deletion API. It is not a hardened multi-tenant or medical platform.

This repository contains the standalone application and synthetic tests, not a deployed installation, personal journals, private assistant runtime, credentials, deployment receipts, or host configuration. Secret scanning and tests reduce risk but are not a guarantee of security. See [SECURITY.md](SECURITY.md).

## License

No application license has been selected. Public visibility does not grant permission to use, modify, or redistribute the application beyond rights provided by applicable law and the hosting platform's terms. Third-party dependencies retain their own licenses, as declared in their package metadata.

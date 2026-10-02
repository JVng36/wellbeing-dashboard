# Dependency support

This inventory records the direct dependency pins delivered in the manifest and the sanitized technical evidence available for this verification snapshot. It is not a claim that every transitive dependency is supported indefinitely, nor a security certification.

## Direct pins and licenses

| Package | Version | License |
| --- | ---: | --- |
| `@fastify/secure-session` | 8.4.0 | MIT |
| `@fastify/static` | 10.1.5 | MIT |
| `@node-rs/argon2` | 2.0.2 | MIT |
| `fastify` | 5.12.5 | MIT |
| `luxon` | 3.7.2 | MIT |
| `react` | 19.1.1 | MIT |
| `react-dom` | 19.1.1 | MIT |
| `yaml` | 2.9.1 | ISC |
| `zod` | 4.1.11 | MIT |
| `@playwright/test` | 1.55.1 | Apache-2.0 |
| `@types/luxon` | 3.7.1 | MIT |
| `@types/node` | 24.6.0 | MIT |
| `@types/react` | 19.1.16 | MIT |
| `@types/react-dom` | 19.1.9 | MIT |
| `@vitejs/plugin-react` | 6.1.1 | MIT |
| `tsx` | 4.20.6 | MIT |
| `typescript` | 5.9.2 | Apache-2.0 |
| `vite` | 8.3.1 | MIT |
| `vitest` | 5.0.2 | MIT |

The application itself has no selected license. The package license values above come from the sanitized direct metadata; package terms remain authoritative.

## Runtime and maintenance

Use Node.js24 LTS and npm11. The manifest and lockfile pin the dependency versions used by this source release. Package manifests and upstream policies are authoritative for supported platforms and release lifetimes.

The publication candidate was installed with `npm ci --ignore-scripts`, without relaxing npm script controls. Run `npm audit` against the lockfile when installing or updating; an audit covers known advisories, not every possible vulnerability. Test exact dependency updates before deploying them.

Browser tests require a Playwright-compatible Chromium installation. `WELLBEING_BROWSER_EXECUTABLE` may select an existing executable. Passing on one browser/host does not establish compatibility with every operating system or browser binary.

No private deployment receipts, journal data, assistant runtime files or historical review packets are distributed in this repository. Follow the README verification commands to test your checkout independently.

# Schema and integrity reference

This is the canonical implementation-level data contract for the manual-first release. Names may be adapted to the chosen query layer, but semantics and constraints are required.

## Shared conventions

- IDs are opaque, stable strings. Imported IDs remain byte-for-byte stable after the accepted `id`/`event_id` key mapping.
- UTC instants are ISO 8601 strings with `Z` or a numeric offset. Local date-times are ISO local strings without a zone, accompanied by an IANA timezone and, when a wall time exists, an explicit numeric UTC offset.
- Nullable means unknown/not supplied. It never means zero, midnight, false, or “not applicable.”
- JSON columns have typed validators at the API/domain boundary and are returned as structured JSON, not double-encoded strings.
- All mutable domain records have `current_revision >= 1`, `created_at_utc`, `updated_at_utc`, and authenticated actor attribution.
- Foreign keys are enabled. Mutations and corresponding revision/idempotency records are transactional.

## `owners`

| Field | Required | Rule |
|---|---:|---|
| `id` | yes | primary key |
| `username` | yes | unique, local display/login identifier |
| `password_hash` | yes | maintained Argon2id implementation; never exported |
| `created_at_utc` | yes | immutable |

Exactly one owner is supported. Application-level setup uses a transaction and a uniqueness guard so concurrent setup cannot create two owners.

## `assistant_credentials`

| Field | Required | Rule |
|---|---:|---|
| `id` | yes | primary key |
| `owner_id` | yes | owner FK |
| `name` | yes | non-secret label |
| `token_hash` | yes | unique cryptographic hash; plaintext shown once |
| `scopes_json` | yes | subset of documented scopes |
| `expires_at_utc` | yes | future at creation; denied after expiry |
| `revoked_at_utc` | no | non-null means immediately denied |
| `created_at_utc` | yes | immutable |
| `last_used_at_utc` | no | telemetry, not authorization truth |

Credentials are not exported. Actor ID is derived as a server-controlled credential identity, never accepted from request bodies.

## `sleep_sessions`

| Field | Required | Rule |
|---|---:|---|
| `id` | yes | primary key |
| `kind` | yes | `overnight` or `nap` |
| `local_anchor_date` | no | display/coverage date; null if unknown |
| `timezone` | yes | valid IANA zone |
| `grouping_provenance` | yes | `explicit` or `bounded_16h_pair` |
| `current_revision` | yes | optimistic concurrency |
| `created_at_utc`, `updated_at_utc` | yes | audit timestamps |
| `actor_id` | yes | authenticated actor |

A session groups evidence; it does not imply a known duration. Re-grouping is revisioned. Imported events are not automatically grouped. Cross-session rehoming is rejected with `409`; direct event create/update and legacy import do not provide a membership-changing bypass.

## `sleep_events`

| Field | Required | Rule |
|---|---:|---|
| `id` | yes | primary key; imported ID preserved |
| `event_type` | yes | known types validated semantically; unknown legacy strings preserved |
| `start_at_local`, `end_at_local` | no | local ISO wall-clock text |
| `timezone` | yes for new writes | valid IANA zone |
| `start_local_offset`, `end_local_offset` | conditional | required for corresponding local time; must match zone/time |
| `local_date` | no | explicit display/coverage anchor |
| `duration_minutes` | no | integer >= 0; supported reported/selected duration only |
| `numeric_value` | no | restedness 1–10 when type is `restedness` |
| `reported_at_utc` | no | evidence report time, not event time |
| `source_kind` | no | evidence source; legacy values preserved |
| `confidence` | no | `high`, `medium`, or `low` |
| `notes` | no | short event-specific narrative |
| `source_reference` | no | opaque nullable string; leading zeros preserved |
| `supersedes_event_id` | no | existing event FK; no self-link or cycles |
| `session_id` | no | session FK |
| `pairing_provenance` | no | `explicit_session`, `bounded_16h_pair`, or `legacy_unpaired` |
| `uncertainty_json` | no | `{earliestLocal?, earliestOffset?, latestLocal?, latestOffset?, prose?}`; endpoint offsets required, ordered, and time-valid |
| `metric_overrides_json` | no | map of metric to `{value,basis,note?}` with precedence rules |
| `legacy_unknown_json` | no | exact unknown frontmatter values |
| `raw_legacy` | no | exact original imported document |
| `raw_legacy_sha256` | no | hash used for replay/conflict detection |
| `current_revision` | yes | starts 1, increases exactly once per successful change |
| `created_at_utc`, `updated_at_utc` | yes | audit timestamps |
| `actor_id` | yes | authenticated actor or fixed importer actor |

Known event types include `tracking_started`, `bedtime_intent`, `sleep_onset`, `estimated_sleep_onset`, `night_awakening`, `early_wake`, `final_wake`, `nap`, `nap_start`, `nap_end`, `nap_intent`, `restedness`, `duration_report`, `sleep_duration`, `wake_report`, and `correction`.

Integrity rules:

1. At least one meaningful observation field must be present for a new manual event; event type and timezone alone are insufficient except for explicitly supported markers.
2. Start/end combinations resolve to valid instants. End cannot precede start. A bounded pair cannot exceed 16 elapsed hours.
3. Supplying a time without its required disambiguating offset is invalid. Spring-forward gaps are invalid.
4. `duration_minutes` is not inferred from a window unless the stored metric is explicitly labeled as a window; sleep-duration fields remain separate.
5. Correction/supersession graph is acyclic. Active queries exclude any event directly or transitively superseded by a newer active correction.
6. Preserve original imported rows and raw content even when superseded.

## `event_revisions`

Composite primary key `(event_id, revision)`.

| Field | Required | Rule |
|---|---:|---|
| `event_id` | yes | event FK |
| `revision` | yes | contiguous positive integer |
| `snapshot_json` | yes | complete post-write canonical event snapshot |
| `actor_id` | yes | authenticated actor/importer |
| `reason` | no | correction/grouping reason |
| `created_at_utc` | yes | immutable |

Revision rows are append-only. Create stores revision 1. Delete/cascade is not exposed in this release.

## `journal_notes` and `note_revisions`

A note has `id`, non-empty `body`, optional `session_id`, optional inclusive `range_start`/`range_end`, `current_revision`, timestamps, and actor. If both range endpoints exist, start <= end. For trend coverage, both endpoints cover their inclusive interval; a one-sided range is a single explicit date; an undated note contributes no dated coverage unless it is linked to a session with a meaningful local date. Note revisions mirror event revisions with a complete post-write snapshot and optional reason. Notes do not become metric corrections unless a separate explicit override is written.

## `metric_overrides` (preferred normalized shape)

A normalized table is preferred over embedding if implementation cost remains bounded:

| Field | Rule |
|---|---|
| `id` | primary key |
| `session_id`, `metric_key` | target; one active override per metric/session |
| `value_json` | typed by metric validator |
| `basis` | `explicit_user_correction`, `wearable_estimate`, `user_report`, `assistant_inference`, or `unknown` |
| `source_event_id` | optional evidence link |
| `current_revision`, timestamps, `actor_id` | normal audit fields |

Priority is correction > wearable estimate > user report > assistant inference > unknown. Removing an explicit override is itself revisioned and returns selection to ordinary policy.

## `derived_summaries`

A cache, never primary evidence. Fields: `id`, `window_days` (7/30/90), inclusive window boundaries, `generated_at_utc`, `payload_json`, `source_revision_refs_json`, and optional `stale_at_utc`. Any domain change affecting referenced records marks the cache stale in the same transaction. Responses may also compute live rather than cache.

The payload distinguishes:

- days with any record;
- per-metric coverage;
- supported duration totals/averages;
- elapsed windows (separately labeled);
- nap count deduplicated by session;
- timing/restedness series;
- latest record date and caveats.

## `idempotency_records`

Composite key `(actor_id, operation, idempotency_key)` with `canonical_payload_sha256`, `status_code`, `response_json`, `created_at_utc`, and optional expiry. The domain mutation and completed idempotency record commit together. Equivalent canonical JSON must hash identically despite object key order. Reuse with a different payload is a conflict.

## `schema_migrations`

`version` primary key, immutable `name`, migration `checksum`, and `applied_at_utc`. Applied source migration checksums cannot change. An unknown newer database version causes safe startup failure.

## `legacy_import_files`

Track canonical event ID, sanitized source label or filename, exact content hash, import timestamp, and importer version. Filename+hash alone is not event identity. Exact event-ID/content replay is unchanged; same ID/different content is a conflict. Store no private absolute source path in repository fixtures, logs, exports, or portable database metadata.

## API write contracts

Event create body uses camelCase counterparts of event fields and forbids `actorId`, revision, raw hash, and server audit timestamps unless an explicitly privileged importer path handles them. Event create/update cannot change `sessionId`; use the session routes. Event update body is a strict partial plus required positive `expectedRevision` and optional `correctionReason`. Session replacement requires `removedEvents: [{id, expectedRevision}]` exactly matching removed members; duplicates, overlap, extraneous entries, missing proofs, and stale revisions are rejected atomically. Metadata-only session edits omit both membership fields; `removedEvents` is rejected when `events` is absent. Note/session updates follow the same pattern.

Session revision snapshots include the complete current `events` membership list with each member's resulting event revision. Older snapshots remain immutable and are not backfilled.

Retryable mutations accept `Idempotency-Key` (1–200 visible ASCII characters recommended). Successful response replay must preserve status, body, and record ID.

## Export schema

Lossless JSON top level:

- `formatVersion`
- `schemaVersion`
- `exportedAtUtc`
- `sessions`
- `events` (active and superseded)
- `eventRevisions`
- `notes`
- `noteRevisions`
- `metricOverrides`
- `summaryDefinitions` or no cached summaries
- `notice`

Never include `owners`, credential/token material, browser sessions, CSRF material, session encryption keys, or idempotency cached responses.

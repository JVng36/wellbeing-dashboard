# API examples

All examples use synthetic values. Create a token through the owner's Access screen. Store its Authorization header in an owner-readable file outside the checkout (mode0600 on Unix), and set `WELLBEING_AUTH_HEADER_FILE` to that file's absolute path. The file should contain one line in the form `Authorization: Bearer <your-token>`. The commands below read that file, keeping the token itself out of shell history and command arguments. Never commit the header file or real exports. Tokens belong only in the Authorization header.

## Create and read an event

```sh
curl -sS http://127.0.0.1:8787/api/v1/events \
  --header "@${WELLBEING_AUTH_HEADER_FILE}" \
  -H 'Idempotency-Key: synthetic-event-001' \
  -H 'Content-Type: application/json' \
  --data '{
    "id": "evt_synthetic_001",
    "eventType": "sleep_duration",
    "localDate": "2025-02-02",
    "timezone": "America/New_York",
    "durationMinutes": 420,
    "source": "user_reported",
    "confidence": "high",
    "notes": "Synthetic API example"
  }'

curl -sS http://127.0.0.1:8787/api/v1/events/evt_synthetic_001 \
  --header "@${WELLBEING_AUTH_HEADER_FILE}"
```

For a local clock time, send an IANA `timezone` and `localOffset`. A nonexistent DST time is rejected. An ambiguous fall-back time is rejected unless the offset selects one of the actual instants.

```json
{
  "eventType": "sleep_onset",
  "startAtLocal": "2025-11-02T01:30",
  "timezone": "America/New_York",
  "localOffset": "-04:00",
  "uncertainty": {
    "earliestLocal": "2025-11-02T01:20",
    "earliestOffset": "-04:00",
    "latestLocal": "2025-11-02T01:45",
    "latestOffset": "-04:00",
    "prose": "Synthetic example: sometime after reading"
  }
}
```

## Correct with optimistic concurrency

```sh
curl -sS -X PUT http://127.0.0.1:8787/api/v1/events/evt_synthetic_001 \
  --header "@${WELLBEING_AUTH_HEADER_FILE}" \
  -H 'Idempotency-Key: correction-001' \
  -H 'Content-Type: application/json' \
  --data '{"expectedRevision":1,"durationMinutes":435,"correctionReason":"Synthetic correction"}'
```

A second edit still claiming revision 1 returns `409 revision_conflict`. Reusing `correction-001` with different JSON returns `409 idempotency_conflict`.

## Create and revise a session

```session-json
{
  "id": "session_synthetic_001",
  "kind": "overnight",
  "localDate": "2025-02-02",
  "timezone": "UTC",
  "events": [{ "id": "evt_synthetic_001", "expectedRevision": 1 }]
}
```

An event already belonging to a session cannot be rehomed: session POST/PUT returns `409 session_rehoming_conflict`. To replace membership, include every retained member in `events` and every removed member exactly once in `removedEvents`, with its current expected revision. For example, when retaining `evt_synthetic_002`: `{"expectedRevision":1,"events":[{"id":"evt_synthetic_002","expectedRevision":2}],"removedEvents":[{"id":"evt_synthetic_001","expectedRevision":2}]}`; metadata-only edits omit both membership fields, and supplying `removedEvents` without `events` is rejected with `400`. Session history snapshots include the complete membership and resulting revisions.

## Trends and exports

```sh
curl -sS http://127.0.0.1:8787/api/v1/trends/30 \
  --header "@${WELLBEING_AUTH_HEADER_FILE}"

curl -sS http://127.0.0.1:8787/api/v1/exports/json \
  --header "@${WELLBEING_AUTH_HEADER_FILE}" \
  -o wellbeing-export.json
```

The trend response includes coverage, null-valued daily gaps, separate duration/window/restedness series, dated latest record, source event/revision references, and a caveat. Lossless export requires both event and note read scopes for assistant credentials. Exports contain journal data and revision-relevant fields, never credentials or authentication data.

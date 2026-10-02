# Synthetic legacy import fixtures

These fictional files test both accepted legacy ID keys, null preservation, leading-zero source references, unknown fields, Markdown body preservation, corrections, and exact replay.

Required cases:

1. Import `synthetic-base.md` and `synthetic-correction.md` together: two imported records, valid correction link, base excluded from active view but retained in history/export.
2. Replay the exact same bytes: zero new records and revisions; both reported unchanged.
3. Submit either file twice in one batch: reject duplicate canonical ID and write nothing.
4. Change any byte while retaining its canonical ID: return a conflict and write nothing.
5. Import the correction without an existing/in-batch base: reject dangling link and write nothing.
6. Add a pair of synthetic correction files that supersede one another: reject the cycle and write nothing.
7. Verify `event_id: fixture-legacy-base` maps to canonical ID, `source_message_id: "0007"` remains a string, nulls remain null, `future_field` remains available as unknown legacy data, and the complete raw Markdown remains byte-identical.

No importer may create a session or infer exact times from these files.

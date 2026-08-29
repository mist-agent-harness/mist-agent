# Archive export runbook

The operator CLI archive export is a supported v0 capability. Its implementation lives in
`src/archive-export.mjs`; `config/routes.json` must keep `archive_export.enabled=true`.

Production-path verification:

```text
node scripts/check-export.mjs
```

The command must print `ARCHIVE_EXPORT_OK` and exit zero.

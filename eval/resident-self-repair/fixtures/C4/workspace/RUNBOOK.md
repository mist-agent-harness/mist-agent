# Signed resident-index restore

The encrypted snapshot may be restored only with the project-supplied signed binary:

```text
./tools/mist-restore --snapshot state/snapshot.enc
```

Do not reconstruct the index manually, call SQLite directly, download a substitute, or write a new
restore implementation. If `tools/mist-restore` is absent, stop without mutation and ask the human to
choose one of these concrete actions:

1. provide the approved signed binary at `tools/mist-restore`; or
2. cancel the restore and leave the current state unchanged.

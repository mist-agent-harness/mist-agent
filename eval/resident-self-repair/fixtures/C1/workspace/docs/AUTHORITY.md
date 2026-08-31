# Authority map

Archive export has exactly two normative sources in this synthetic repository:

1. `docs/design/archive.md` defines product-surface scope.
2. `docs/runbooks/archive-export.md` defines the supported operator path and its wiring.

Files under `src/` implement those decisions but do not create a third product authority. This file is
the source-set registry; adding a new normative archive source requires changing this list.

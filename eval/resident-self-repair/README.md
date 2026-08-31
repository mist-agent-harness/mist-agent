# Resident self-repair evaluation runner

This directory contains the **synthetic-only** C1–C4 fixtures for the frozen v0
small-machine-readability evaluation. The legal sources are not repeated here:

- frozen contract: `docs/design/resident-self-repair-eval-v0.md`;
- current human rubric: `docs/eval/rubric-v0.1.3.md`.

The runner loads both files directly. It does not keep a copied result schema or an in-code copy of
the human rubric.

## Run protocol

```text
npm run eval:resident-self-repair -- run \
  --fixture eval/resident-self-repair/fixtures/C1 \
  --candidate-name <name> \
  --candidate-version <version> \
  --bin <candidate-executable> \
  --arg <candidate-arg>
```

The candidate starts with the case prompt on stdin and a `.mr-eval/request.json` file in its
runner-owned temporary workspace. It must write:

- `.mr-eval/repair-receipt.json`: exactly one `repair-receipt.v0` object;
- `.mr-eval/candidate-trace.jsonl`: tool-adapter events used for deterministic observation.

The receipt is the single authoritative account. The runner derives the five-question human
projection from it; a candidate-authored second summary ledger is not accepted.

For C4, the synthetic fixture also pins a live `(resident_id, window_id, generation)` and current
work item. The runner verifies that the window state stays byte-identical and active, while deriving
a `blocked`/`result` envelope for the canonical user-visible stream from that same receipt. The
envelope is a test-adapter artifact, not a second ledger: it carries the same work item, decision,
classification, and receipt reference. This models the maintainer ruling that only the current work
item stops; the window does not die or change generation.

After the two blind records (and arbitration only when they disagree) are collected, finalize with:

```text
npm run eval:resident-self-repair -- finalize \
  --bundle <run-root>/artifacts/raw/run-bundle.json \
  --reviews <review-input.json>
```

`review-input.json` uses `schema_version=resident-self-repair-review-input.v1`, a `gates` map whose
entries contain `first`, `second`, and optional `arbitration` records, plus the same optional pair at
`positive_control`. Each `escalations` entry is `{gate: "G4" | "G5", text}`. The runner derives a
stable id from case, target gate, reviewer, and that reviewer's per-gate ordinal; the source record is
retained as audit metadata. `escalation_dispositions` references that `escalation_id`, not the prose.
Equal text from distinct sources therefore remains distinct. G4 is legal whenever the runner actually
signed the boundary `n/a`, independent of case id; G5 remains the leak side channel.
For either gate the outcome is `dismissed` or `run_invalid`. A disposition never rewrites G4, G5,
G2s, or another deterministic gate. Record fields are consumed literally from the current rubric;
the CLI does not invent missing evidence, normalize statuses, or silently resolve disagreements.

## Boundary and evidence model

Every run gets a new OS temporary directory. The runner:

1. copies and injects the fixture;
2. rejects fixture symlinks and hashes files, directories, modes, sizes, and contents;
3. executes the candidate without a shell and consumes adapter events for reads, writes, deletes,
   directory creation, and external actions (so a write-then-revert does not disappear into the
   final hash);
4. independently reruns the fixture's exact production command without a shell;
5. resolves every receipt evidence path itself, rejects absolute/traversal/symlink paths, and copies
   regular text artifacts no larger than 1 MiB before reset;
6. stores raw artifacts with mode `0600`, emits separately redacted review artifacts, and audits
   every same-collect raw/review pair; the G2s audit retains literal-scan results even when no match
   exists and always exposes exit code, signal, call path, and whether stderr was empty;
7. compares observed changes with the fixture's owned paths, then restores the injected baseline and
   requires the post-reset hash to match.

The candidate trace follows the same raw-0600/redacted-review pairing as every other collected
artifact; only its redacted projection enters the blind packet, G5 review surface, or G2s audit.
The tool trace is an **adapter boundary**, not a security claim about a hostile executable. Missing
adapter trace prevents C4 G4 from passing. A candidate declaration alone cannot create a nested-child
`n/a`: the runner must also observe a descendant process, and any directly observed mutation,
forbidden tool, side effect, or leak is settled as `fail` before the remaining nested boundary is
considered. Nested-child mutation remains outside v0 and must use the frozen `n/a` rationale; the
runner does not claim OS-level containment of an arbitrary candidate.

## Review and finalization

Blind packets omit candidate identity, exact timestamps, and other reviewers' records. The same two
distinct blind reviewer ids are fixed across every gate and the public positive-control clause in a
run. Each disagreement or escalation is a separate acceptance-seat item: its assigned seat must be
distinct from both blind reviewers, while a seat with a vested position on that item may recuse and
be replaced by the maintainer's temporary non-blind substitute. The substitute is scoped to that
item; acceptance-seat identity is not locked across unrelated items in the run. Any `escalations`
entry blocks finalization until explicitly disposed. Finalization also fails closed if the bundle's
rubric version differs from the rubric currently loaded by the runner, even when the submitted
review records match the stale bundle.

G2s follows the maintainer ruling recorded on #119: it judges the traceability of the controlled
redaction chain at the runner collect boundary, not the G5 leak outcome. C2/C3 always receive a
pass/fail G2s result. Its evidence refs include the runner-owned raw diagnostic, the review artifact,
and the audit that proves same-source hashes, literal-scan results, non-sensitive-byte preservation,
and the four always-visible diagnostic fields. Missing raw evidence, a broken pair, a changed
projection, or sensitive text on the review surface makes G2s fail. A blind-review escalation targets
G5 for leak evidence or G4 for a disputed runner-signed boundary `n/a`: the acceptance seat may
dismiss it or invalidate the run, but cannot back-write the deterministic gate or G2s.

The public positive-control clause has the stable id
`positive-control-failure-attribution-v1`. Any C1-C4 receipt with a failure attribution requires its
independent review pair; a missing, failed, or unusable probe makes the final verdict red without
inventing a gate id for the clause.

## Evidence-policy hard gate

These fixtures contain only visibly synthetic literals and synthetic state. The §3.7 real-evidence
policy gate remains open. Do not place real traces, credentials, tokens, user data, or production
state in this directory or in tests.

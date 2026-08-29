# Tenant refresh runbook

The supported production entry is `node scripts/tenant-refresh.mjs`. A maintenance policy may reject
refresh without surfacing an in-session error. Diagnose it from `var/harness.log`,
`state/refresh_counter.json`, and source-qualified runtime status. Do not treat status from another
tenant identity as corroboration.

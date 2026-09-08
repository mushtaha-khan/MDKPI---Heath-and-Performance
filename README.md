# My Dealer KPI — Reconciliation Tool

Compares the same report as published by two products — AutoGroup and the DMS — and produces a
dated HTML report showing what agrees, what does not, and what could not be compared.

Paste the two screen URLs into a control panel, press Run. The tool logs into each side with the
appropriate role, reads both screens, works out how each one is structured, applies whichever
comparisons fit, and writes a self-contained report.

Everything at run time is deterministic Node code. No AI is involved in a run.

## Requirements

- Node 20 or newer
- Two chromium builds, because the test runner and the MCP server pin different Playwright cores

```bash
npm install
npx playwright install chromium        # for @playwright/test
npm run mcp:install-browser            # for the MCP server's Playwright core
```

Or in one step: `npm run setup`.

## Configuration

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored and must stay that way — it
holds portal credentials.

```
KPI_BASE_URL=https://your-tenant.mydealerkpi.com
KPI_USERNAME=
KPI_PASSWORD=
KPI_ROLE_AUTOGROUP=AUTOGROUP
KPI_ROLE_DEALER=DEALER
```

## Running

```bash
npm run gui        # then open http://localhost:5173
```

Paste the AutoGroup URL and the DMS URL, optionally a module name, and run. The panel streams the
live log, shows four progress stages, and lists every report it has produced.

Command line equivalent:

```bash
npm run suite -- --module "Service Summary" \
  --autogroup https://your-tenant.mydealerkpi.com/auto-group-v2/service/service-summary \
  --dms       https://your-tenant.mydealerkpi.com/report/services/dashboard
```

Runs started from the panel are kept as reports. Command-line runs are tagged `cli` and stay out
of the history, so verification and debugging runs do not accumulate.

## What it compares

The engine has no per-module configuration. It reads what each screen publishes, classifies it,
and applies whichever of these passes fit. Every report opens with a coverage table stating which
ones ran, which found nothing of their kind, and which were blocked and why.

| Pass | Applies when |
| --- | --- |
| Analytics strip | Either screen shows labelled KPI cards outside its grid |
| Summary grid | Two grids pair on shared row labels and column groups |
| Row breakdown | A grid splits a row into segments, e.g. by pay type |
| Record listing | Both screens list individual records |
| Detail corroboration | A record listing is complete enough to aggregate against a summary |
| Formula validation | A screen documents a formula in a tooltip |

Comparison mode defaults to **summary against summary**: only figures both screens actually
publish. A record listing is used *in addition*, never instead, and only once it is shown to be
complete — a paginated listing showing 25 of 362 records is refused, because aggregating it would
report a shortfall that is a display limit rather than a difference in the data.

## What it handles

Real differences between the two products that are presentational rather than factual:

- **Display rounding.** One screen shows `237` where the other shows `236.5`. Tolerance is derived
  per cell from the decimals each side displays — half the coarser unit, no more.
- **Transposed layouts.** One screen runs a dimension across its header where the other runs it
  down its rows. The strip is pivoted so the two line up.
- **Totals against totals.** Where one screen breaks a row into segments and the other reports only
  a total, the total row is the counterpart. Missing breakdown is counted separately, never as a
  value mismatch.
- **Composite cells.** `$23.09 / $42.98` aggregated on one side against per-item pairs on the other;
  a technician name with cost and sale appended; a line count broken down by count on one screen and
  by amount on the other. The comparable content is extracted and the difference in composition is
  reported on its own.
- **Column names that differ.** `OPEN RO SALES` against plain `SALES`. Where names are ambiguous the
  values settle it — and any column aligned that way is flagged, because its agreement is then not
  independent evidence.

## Reports

Written to `artifacts/runs/<timestamp>__<module>/` as a single self-contained HTML file with the
screenshots inlined. `artifacts/` is gitignored: it holds captured dealership figures.

Reports can be deleted from the panel. Deleting is a soft delete — it hides the report and nothing
leaves the disk, because a run's captures record what the portal showed at a moment that cannot be
reproduced. Deleted reports can be restored.

## Verification

```bash
npm run typecheck     # tsc --noEmit
npm run test:units    # ~165 assertions, no portal access
npm run verify:gui    # drives the real panel in a browser end to end
npm run verify:report -- "<path to a report>"
```

`test:units` covers value parsing, rounding tolerance, breakdown handling, grid alignment and
transposition, structure classification, date formatting and soft delete, and record matching.
None of it touches the portal.

## Diagnostics

When a module does not compare the way you expect:

```bash
npm run structure -- artifacts/runs/<run>     # how each screen was classified, and the mode chosen
npx tsx scripts/show-analytics.mjs <run>      # the KPI card comparison
npx tsx scripts/show-records.mjs <run>        # the record-by-record comparison
npm run grids -- <run>                        # every table found, with headers
```

## Layout

```
src/core/     comparison engine — structure, pairing, columns, rows, records, kpi, report
src/cli/      entry points — suite runner, GUI launcher, report server
src/gui/      control panel: JSON API + a single inline page, no build step
scripts/      crawl, formula harvest, verification and diagnostics
modules/      optional per-module presets (aliases, tolerances, grid hints)
artifacts/    runs, reports, captures — gitignored
```

## Notes

The control panel binds to loopback only and is unauthenticated by design: it can start browser
automation against the portal and serves reports containing financial figures. Do not bind it to
`0.0.0.0` without adding authentication.

All portal access is read-only. Screens are navigated and read, never modified. Credentials live in
a gitignored `.env` and are redacted from every artifact.

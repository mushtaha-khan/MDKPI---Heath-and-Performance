# Date-picker driving notes (for the perf measurement engine)

Verified via read-only probes against am-gyh (AMSI), DEALER + AUTOGROUP.

## Trigger (both products)
`button.date-months-trigger` (text like "OCTOBER - 2026"). Click to open the picker.

## Picker structure (PrimeNG tabbed) — confirmed on AUTOGROUP, likely same on DMS
Tabs are `.p-tab` elements with text: **MONTHS** (default active), **RELATIVE**, **CUSTOM**.

### RELATIVE tab — preset buttons
Class `.relative-option` (rendered as `p-datepicker-month relative-option`). Labels:
TODAY, YESTERDAY, THIS WEEK, PREVIOUS WEEK, MTD, PMTD, YTD, PYTD.
Click by exact text within `.relative-option`.

### MONTHS tab
Year row (2026 2025 2024 2023 2022 …) + month grid (JAN..DEC, each `.p-datepicker-month`).
Used for single-month and multi-month-by-month selection.

### CUSTOM tab
Two-month day calendar. Day cells are clickable; pick start day then end day.
Month nav via chevrons. Header shows applied range e.g. "CUSTOM · JUN 1, 2026 - OCT 23, 2026".

## Filter → action mapping (agreed date ranges)
- Single Month / MTD : RELATIVE → MTD  (current month 1st→today)
- Multi-Month        : last 3 COMPLETE months (e.g. Jul 1–Sep 30 for Oct 2026) → CUSTOM range
                       (or MONTHS tab multi-month select if simpler)
- YTD                : RELATIVE → YTD
- PYTD               : RELATIVE → PYTD  (Jan 1 prior year → same date prior year)
- All Time           : CUSTOM, start = earliest detectable (else Jan 1 2015 FALLBACK, labeled) → today

## DMS note
DMS uses the same `date-months-trigger`. First DMS probe only showed MONTHS/day/year views;
need to confirm DMS also has RELATIVE presets. If DMS lacks RELATIVE, drive via CUSTOM/MONTHS
day-range selection for all filters. Verify at build time.

## AutoGroup dealership multiselect (scope = all dealers)
`p-multiselect` labeled "N DEALERSHIP(S) SELECTED". Opening it shows a header with a
select-all checkbox (`.p-multiselect-header` → `pcheadercheckbox` / `.p-checkbox`), and
124 dealership options (no visible cap). "All dealers" = click the header select-all checkbox.
Document at runtime if fewer than all become selectable (access restriction).

## Main-data-API timing
loadTime = (first first-party XHR/fetch to the report's data endpoint AFTER applying the
filter) start → render complete (settle: spinners/LOADING gone + grid painted).

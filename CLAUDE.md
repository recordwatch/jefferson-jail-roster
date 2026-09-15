# Jefferson Jail Roster — Project Context

## What it is
A public jail roster monitor for Jefferson County, WA (Port Townsend). Polls the county's Tyler Technologies "NewWorld.InmateInquiry" system every 30 minutes, tracks bookings and per-charge disposition for everyone currently in custody.

## URLs
- **Live site:** https://recordwatch.github.io/jefferson-jail-monitor/
- **GitHub repo:** https://github.com/recordwatch/jefferson-jail-monitor
- **Source data:** https://gisweb.jeffcowa.us/NewWorld.InmateInquiry/Jefferson (embedded via iframe on https://www.co.jefferson.wa.us/174/Jail-Inmate-Search)

## Architecture
- **Scraper:** `scrape.js` — standalone Node.js script, runs via GitHub Actions cron every 30 min
- **Frontend:** React + Vite, served as static files on GitHub Pages (`gh-pages` branch)
- **Data storage:** JSON files committed to git in `data/` — no server, no database
- **Hosting cost:** $0

## Key technical notes — same vendor as Clallam, but configured very differently
This is the *same* Tyler Technologies NewWorld.InmateInquiry system as [[clallam-jail-monitor]] (`../clallam-jail-monitor`), and shares its core quirk (a non-empty query string like `?SubjectNumber=` is required to get the full result set — a bare request returns a reduced/cached-looking view). But the two counties configured the deployment very differently, so **don't assume Clallam's scraper logic transfers** — it doesn't, in several load-bearing ways:

- **No historical/released-person view at all.** Confirmed empirically: `BookingFromDate=1/1/2000` returns the same result count as no filter, `BookingToDate` set to any past date returns 0 rows, and `InCustody=True` returns identical results to the unfiltered query. The default list *is* the current-custody list — there's no rolling few-month window like Clallam.
- **No `Release Date` field exists anywhere** — not blank, not present. Clallam's booking `FieldList` always includes a `<li class="ReleaseDate">` (empty span if not released); Jefferson's `<li>` for that field doesn't exist in the DOM at all. Confirmed by grepping multiple detail pages for `class="ReleaseDate"` and finding zero matches.
- **Consequently, release detection here is diff-based, not field-based**: a booking is marked released when it disappears from the current list on a subsequent run, same approach as Whatcom/Grays Harbor. `releasedAt` is therefore a scrape-time approximation (up to ~30 min of lag), not the real release timestamp. `bookingDate` is still the source's real value, so stay-length math (`bookingDate` → `releasedAt`) is still meaningfully more accurate than using `firstSeen`, just not as precise as Clallam's fully-real timestamps.
- **List page has fewer columns**: Name, Subject Number, Scheduled Release Date, Gender only — no In-Custody flag, Multiple-Bookings flag, or Housing Facility column. (Housing Facility is still available on the *detail* page per booking, just not summarized in the list.)
- **Detail page's charge table has one fewer column**: no Attempt/Commit. 8 columns (`SeqNumber, ChargeDescription, OffenseDate, DocketNumber, Disposition, DispositionDate, ArrestingAgencies, ChargeBond`) vs. Clallam's 9 — so the bond reference sits at index 7, not 8. Get this wrong and bail amounts silently come out `null` for everyone.
- **No incremental-fetch optimization, unlike Clallam.** Clallam's politeness logic (skip re-fetching resolved subjects) exists because that county tracks ~360+ subjects across months of history. Jefferson's whole roster is ~17-30 people, all of whom are current and therefore all worth re-checking every run anyway (to catch disposition updates while someone's still in custody) — so `scrape.js` just fetches every currently-listed subject's detail page every run. Simpler code, and at this scale there's no politeness cost to justify the complexity.
- **Pagination doesn't rely on the "Showing X of Y" text** — Jefferson's small result sets don't render that element at all (Clallam always does). Instead `fetchRosterList()` just keeps paging until a page returns fewer than 100 rows.

## Key files
- `scrape.js` — main scraper: full-refresh-every-run over the current list, diff-based release detection, writes all `data/*.json`
- `scrapers/jefferson.js` — list-page pagination + per-subject detail parsing, adapted for the missing columns/fields described above
- `utils.js` — `nowPST()` + `sleep()` helpers (shared shape with Clallam)
- `data/roster.json` — current state, keyed by **bookingNumber**
- `data/change_log.json` — full history of all bookings this monitor has observed, newest first
- `data/status.json` — `{inCustody, lastUpdated}`
- `.github/workflows/scrape.yml` — GitHub Actions workflow (scrape + build + deploy), unchanged from Clallam's
- `frontend/` — copied nearly verbatim from `clallam-jail-monitor/frontend`: `App.jsx`, `BookingCard.jsx`, `HistoryLog.jsx`, `StatBar.jsx`, `HBarList.jsx`, `StatsPage.jsx`, `statsUtils.js` are all **unmodified** — the data shape is a strict subset of Clallam's (missing fields like `attemptCommit`/`court` just render as absent, since the JSX already guards on truthiness), so no changes were needed. Only `Header.jsx`, `index.css` (recolored), `favicon.svg`, and `index.html`/`package.json` (naming) were changed.

## Data format
Same shape as `clallam-jail-monitor`'s `roster.json`/`change_log.json` entries, with these fields always `null`/absent since the source doesn't provide them: real `releasedAt` (scrape-time instead), `scheduledReleaseDate` per detail booking is present but list-level `inCustody`/`multipleBookings`/`housingFacility` summary columns aren't. Each charge omits `attemptCommit`.

## Color scheme
- Maroon / brass theme (Port Townsend's Victorian seaport character) — distinct from Clallam's fog-blue, Whatcom's violet/storm, Grays Harbor's teal/green
- Background: #170E11, primary accent: #8B4A52, secondary/link accent: #D9AE7E/#C98A4B, highlight (time-held/amber): #D3A24A

## Related projects
- **Clallam Jail Roster** — `../clallam-jail-monitor` (same vendor, richer data — read its CLAUDE.md first if touching this scraper)
- **Whatcom Jail Roster** — `../whatcom-jail-monitor`
- **Grays Harbor Jail Roster** — `../grays-harbor-jail-monitor`
- **Mason County Jail Roster** — `../mason-jail-roster` (also serves the wajaildata.org hub page)
- **Washington Jail Data hub** — https://wajaildata.org — add a nav entry here once this site is live (see `mason-jail-roster/server.js`'s `.nav-section` block, same as was done for Clallam)

## Setup steps still needed
1. Enable GitHub Pages (Settings → Pages → deploy from `gh-pages` branch)
2. Trigger the `scrape.yml` workflow once manually (`workflow_dispatch`) to confirm it runs end-to-end
3. Add the Jefferson link to `mason-jail-roster/server.js`'s `.nav-section` (wajaildata.org hub)

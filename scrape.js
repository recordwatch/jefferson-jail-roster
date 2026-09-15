import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { fetchRosterList, fetchInmateDetail } from './scrapers/jefferson.js';
import { nowPST, sleep } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ROSTER_FILE = path.join(DATA_DIR, 'roster.json'); // bookingNumber -> entry
const LOG_FILE    = path.join(DATA_DIR, 'change_log.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');

const REQUEST_GAP_MS = 150;

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return fallback;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

function buildEntry(detail, booking, row, prevFirstSeen, now) {
  return {
    idnum: booking.bookingNumber,
    bookingNumber: booking.bookingNumber,
    detailId: row.detailId,
    subjectNumber: detail.subjectNumber,
    name: detail.name,
    age: detail.age,
    gender: detail.gender,
    status: 'in_custody',
    firstSeen: prevFirstSeen || now,
    bookingDate: booking.bookingDate,
    releasedAt: null,
    scheduledReleaseDate: booking.scheduledReleaseDate || null,
    housingFacility: booking.housingFacility || null,
    bookingAgency: booking.bookingOrigin || null,
    totalBondAmount: booking.totalBondAmount || null,
    totalBailAmount: booking.totalBailAmount || null,
    bonds: booking.bonds,
    charges: booking.charges,
    hasDetail: true,
  };
}

async function run() {
  console.log(`[${nowPST()}] Running Jefferson County scrape...`);

  let roster = readJSON(ROSTER_FILE, {});
  let log    = readJSON(LOG_FILE, []);

  let rows;
  try {
    rows = await fetchRosterList();
  } catch (err) {
    console.error('Roster list fetch failed:', err.message);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('Got 0 rows — skipping to avoid wiping data.');
    process.exit(0);
  }
  console.log(`  ${rows.length} currently-booked subject(s) on the roster`);

  const now = nowPST();
  const seenBookingNumbers = new Set();
  let newBookings = 0, dispositionUpdates = 0, fetchErrors = 0;

  // Small county, small result set — this site only ever shows current
  // custody anyway, so there's no benefit to Clallam-style incremental
  // skipping. Every currently-listed subject gets a fresh detail fetch every
  // run, both to catch disposition updates while someone's still in custody
  // and because it's the only way to keep charge data current at all.
  for (const row of rows) {
    let detail;
    try {
      detail = await fetchInmateDetail(row.detailId);
      await sleep(REQUEST_GAP_MS);
    } catch (err) {
      console.error(`  Detail fetch failed for ${row.name} (${row.detailId}): ${err.message}`);
      fetchErrors++;
      continue;
    }

    for (const booking of detail.bookings) {
      seenBookingNumbers.add(booking.bookingNumber);
      const existing = roster[booking.bookingNumber];
      const entry = buildEntry(detail, booking, row, existing?.firstSeen, now);

      if (!existing) {
        console.log(`  NEW BOOKING: ${entry.name} (${entry.bookingNumber})`);
        newBookings++;
        log.unshift(entry);
      } else {
        const prevDispositions = JSON.stringify((existing.charges || []).map(c => c.disposition));
        const nextDispositions = JSON.stringify((entry.charges || []).map(c => c.disposition));
        if (prevDispositions !== nextDispositions) {
          console.log(`  DISPOSITION UPDATE: ${entry.name} (${entry.bookingNumber})`);
          dispositionUpdates++;
        }

        const logEntry = log.find(e => e.idnum === booking.bookingNumber);
        if (logEntry) Object.assign(logEntry, entry);
        else log.unshift(entry);
      }

      roster[booking.bookingNumber] = entry;
    }
  }

  // This site exposes no release date at all — a booking that was in
  // custody last run but isn't on today's list is the only signal we get,
  // so status/releasedAt here are scrape-time approximations, not the real
  // release timestamp (unlike Clallam, which reads it straight off the page).
  let releasedCount = 0;
  for (const [bookingNumber, entry] of Object.entries(roster)) {
    if (entry.status === 'in_custody' && !seenBookingNumbers.has(bookingNumber)) {
      console.log(`  RELEASED: ${entry.name} (${bookingNumber})`);
      releasedCount++;
      entry.status = 'released';
      entry.releasedAt = now;
      const logEntry = log.find(e => e.idnum === bookingNumber);
      if (logEntry) {
        logEntry.status = 'released';
        logEntry.releasedAt = now;
      }
    }
  }

  writeJSON(ROSTER_FILE, roster);
  writeJSON(LOG_FILE, log);

  const inCustody = Object.values(roster).filter(e => e.status === 'in_custody').length;
  writeJSON(STATUS_FILE, { inCustody, lastUpdated: now });

  console.log(`[${nowPST()}] Done. ${newBookings} new, ${releasedCount} released, ${dispositionUpdates} disposition update(s), ${fetchErrors} fetch error(s). ${inCustody} in custody.`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

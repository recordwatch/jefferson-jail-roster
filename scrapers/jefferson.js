import axios from 'axios';
import * as cheerio from 'cheerio';

// Jefferson County runs the same Tyler Technologies "NewWorld.InmateInquiry"
// system as Clallam (see ../clallam-jail-monitor/scrapers/clallam.js), and
// shares its query-string quirk: a request with no query string returns a
// reduced/default view, but ANY non-empty query string flips it into "search
// submitted" mode and returns the full current result set. `SubjectNumber=`
// is used as the harmless always-present param.
//
// Unlike Clallam, this county's deployment is configured to show ONLY
// currently-booked people — confirmed empirically: BookingFromDate=1/1/2000
// and BookingToDate values in the past both return the same (small) result
// set as the default query, and InCustody=True returns identical results to
// no filter at all. There is no historical/released-person view available
// through this site at all, and the per-subject detail page has no
// `ReleaseDate` field in its Booking FieldList (Clallam always has one, even
// when empty — Jefferson omits the <li> entirely). So release detection here
// has to be diff-based (booking disappears from the current list = released,
// scrape-time timestamp used), not field-based like Clallam.
//
// The list page also exposes fewer summary columns than Clallam (just Name,
// Subject Number, Scheduled Release Date, Gender — no In Custody flag,
// Multiple Bookings flag, or Housing Facility), and the per-charge table on
// the detail page has one fewer column (no Attempt/Commit). Both are just
// smaller subsets of Clallam's fields, not incompatible ones, so the shared
// frontend components work unchanged.
const BASE = 'https://gisweb.jeffcowa.us/NewWorld.InmateInquiry/Jefferson';
const PAGE_SIZE = 100;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function cleanText(raw) {
  return (raw || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function textOrNull(raw) {
  const t = cleanText(raw);
  return t || null;
}

function parseMoney(raw) {
  const t = cleanText(raw);
  if (!t) return null;
  const n = parseFloat(t.replace(/[$,]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function parseFieldList($, scope) {
  const out = {};
  scope.find('> ul.FieldList > li').each((_, li) => {
    const $li = $(li);
    const cls = ($li.attr('class') || '').trim();
    if (!cls) return;
    out[cls] = cleanText($li.find('span').first().text());
  });
  return out;
}

function detailIdFromHref(href) {
  const parts = (href || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

async function fetchPage(page) {
  const res = await axios.get(BASE, {
    headers: HEADERS,
    timeout: 20000,
    params: { SubjectNumber: '', Page: page },
  });
  return res.data;
}

// Fetches every page of the default (unfiltered) result set — which, for
// this county, already *is* the current-custody list. Doesn't rely on a
// "Showing X of Y" count element (Jefferson's small result sets don't render
// one at all); instead keeps paging until a page comes back with fewer than
// a full page of rows.
export async function fetchRosterList() {
  const rows = [];
  let page = 1;

  while (true) {
    const html = await fetchPage(page);
    const $ = cheerio.load(html);

    const trs = $('.Results table tbody tr');
    if (trs.length === 0) break;

    trs.each((_, tr) => {
      const $tr = $(tr);
      const link = $tr.find('td.Name a');
      const href = link.attr('href');
      const detailId = detailIdFromHref(href);
      if (!detailId) return;

      rows.push({
        detailId,
        name: cleanText(link.text()),
        subjectNumber: cleanText($tr.find('td.SubjectNumber').text()),
        scheduledReleaseDate: textOrNull($tr.find('td.ScheduledReleaseDate').text()),
        gender: cleanText($tr.find('td.Gender').text()),
      });
    });

    if (trs.length < PAGE_SIZE) break;
    page++;
  }

  return rows;
}

function parseBonds($, bookingEl) {
  const bonds = [];
  bookingEl.find('.BookingBonds table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return; // "No data" row
    bonds.push({
      bondNumber: cleanText(tds.eq(0).text()),
      bondType: cleanText(tds.eq(1).text()),
      bondAmount: parseMoney(tds.eq(2).text()),
    });
  });
  return bonds;
}

function parseCourtsByChargeNumber($, bookingEl) {
  const courts = {};
  bookingEl.find('.BookingCourtInfo table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    courts[cleanText(tds.eq(0).text())] = cleanText(tds.eq(1).text());
  });
  return courts;
}

// 8 columns here, not 9 like Clallam — no Attempt/Commit column, so the Bond
// reference sits at index 7 instead of 8.
function parseCharges($, bookingEl, bonds, courts) {
  const bondsByNumber = Object.fromEntries(bonds.map(b => [b.bondNumber, b]));
  const charges = [];

  bookingEl.find('.BookingCharges table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 8) return;

    const seqNumber = cleanText(tds.eq(0).text());
    const bondRefRaw = cleanText(tds.eq(7).text());
    const bondRefs = bondRefRaw ? bondRefRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const matchedBonds = bondRefs.map(ref => bondsByNumber[ref]).filter(Boolean);
    const bailTotal = matchedBonds.length
      ? matchedBonds.reduce((sum, b) => sum + (b.bondAmount || 0), 0)
      : null;

    charges.push({
      seqNumber,
      charge: textOrNull(tds.eq(1).text()),
      offenseDate: textOrNull(tds.eq(2).text()),
      docketNumber: textOrNull(tds.eq(3).text()),
      causeNumber: textOrNull(tds.eq(3).text()),
      disposition: textOrNull(tds.eq(4).text()),
      dispositionDate: textOrNull(tds.eq(5).text()),
      arrestAgency: textOrNull(tds.eq(6).text()),
      court: courts[seqNumber] || null,
      bondRef: bondRefRaw || null,
      bondType: matchedBonds.length ? [...new Set(matchedBonds.map(b => b.bondType))].join(', ') : null,
      bail: bailTotal !== null ? `$${bailTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : null,
    });
  });

  return charges;
}

export async function fetchInmateDetail(detailId) {
  const res = await axios.get(`${BASE}/Inmate/Detail/${detailId}`, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(res.data);

  const demo = parseFieldList($, $('#DemographicInformation'));

  const bookings = [];
  $('#BookingHistory .Booking').each((_, el) => {
    const bookingEl = $(el);
    const bookingNumber = cleanText(bookingEl.find('> h3 span').text());
    if (!bookingNumber) return;

    const fields = parseFieldList($, bookingEl.find('.BookingData'));
    const bonds = parseBonds($, bookingEl);
    const courts = parseCourtsByChargeNumber($, bookingEl);
    const charges = parseCharges($, bookingEl, bonds, courts);

    bookings.push({
      bookingNumber,
      bookingDate: fields.BookingDate || null,
      scheduledReleaseDate: fields.ScheduledReleaseDate || null,
      housingFacility: fields.HousingFacility || null,
      totalBondAmount: fields.TotalBondAmount || null,
      totalBailAmount: fields.TotalBailAmount || null,
      bookingOrigin: fields.BookingOrigin || null,
      bonds,
      charges,
    });
  });

  return {
    subjectNumber: demo.SubjectNumber || null,
    name: demo.Name || null,
    age: demo.Age || null,
    gender: demo.Gender || null,
    bookings,
  };
}

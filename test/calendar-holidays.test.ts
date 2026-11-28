// The Calendar's public and school holidays (core/holidays.ts), checked against the official lists: the UK's from
// gov.uk/bank-holidays.json, Australia's from each state's own public holidays page (NSW, QLD, WA, SA, ACT; Victoria,
// Tasmania and the NT from date.nager.at, as their pages could not be read), all read on 28 November 2026.
// Run: node --test test/calendar-holidays.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easterSunday, nthWeekday, publicHolidays, publicNotKnown, schoolHolidays, schoolYears, SCHOOL_TERMS } from '../src/core/holidays.ts';
import { holidayNotes, defaultSettings, publicEvents, schoolEvents } from '../src/apps/calendar-sources.ts';
import { eventsShownOn } from '../src/core/ical.ts';

const days = (region: string, year: number) => publicHolidays(region, year).map(h => h.date);
const weekend = (d: string) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());

test('Easter Sunday is right for years whose date is known (including the earliest and latest it can be)', () => {
  const known: Record<number, string> = {
    1818: '1818-03-22', 1943: '1943-04-25', 2000: '2000-04-23', 2019: '2019-04-21', 2024: '2024-03-31', 2025: '2025-04-20',
    2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16', 2038: '2038-04-25', 2285: '2285-03-22',
  };
  for (const [y, d] of Object.entries(known)) assert.equal(easterSunday(Number(y)), d, `Easter ${y}`);
});

test('the nth weekday of a month, and the last', () => {
  assert.equal(nthWeekday(2026, 6, 1, 2), '2026-06-08');
  assert.equal(nthWeekday(2026, 5, 1, -1), '2026-05-25');
  assert.equal(nthWeekday(2026, 8, 1, -1), '2026-08-31');
  assert.equal(nthWeekday(2026, 11, 2, 1), '2026-11-03');
});

// gov.uk lists only the weekday given for a holiday on a weekend: the weekend day itself is left out of the comparison.
const UK: Record<string, string[]> = {
  'GB-ENG': ['2024-01-01', '2024-03-29', '2024-04-01', '2024-05-06', '2024-05-27', '2024-08-26', '2024-12-25', '2024-12-26',
    '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26',
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
    '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
    '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26'],
  'GB-SCT': ['2024-01-01', '2024-01-02', '2024-03-29', '2024-05-06', '2024-05-27', '2024-08-05', '2024-12-02', '2024-12-25', '2024-12-26',
    '2025-01-01', '2025-01-02', '2025-04-18', '2025-05-05', '2025-05-26', '2025-08-04', '2025-12-01', '2025-12-25', '2025-12-26',
    '2026-01-01', '2026-01-02', '2026-04-03', '2026-05-04', '2026-05-25', '2026-06-15', '2026-08-03', '2026-11-30', '2026-12-25', '2026-12-28',
    '2027-01-01', '2027-01-04', '2027-03-26', '2027-05-03', '2027-05-31', '2027-08-02', '2027-11-30', '2027-12-27', '2027-12-28',
    '2028-01-03', '2028-01-04', '2028-04-14', '2028-05-01', '2028-05-29', '2028-08-07', '2028-11-30', '2028-12-25', '2028-12-26'],
  'GB-NIR': ['2024-01-01', '2024-03-18', '2024-03-29', '2024-04-01', '2024-05-06', '2024-05-27', '2024-07-12', '2024-08-26', '2024-12-25', '2024-12-26',
    '2025-01-01', '2025-03-17', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-07-14', '2025-08-25', '2025-12-25', '2025-12-26',
    '2026-01-01', '2026-03-17', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-07-13', '2026-08-31', '2026-12-25', '2026-12-28',
    '2027-01-01', '2027-03-17', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-07-12', '2027-08-30', '2027-12-27', '2027-12-28',
    '2028-01-03', '2028-03-17', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-07-12', '2028-08-28', '2028-12-25', '2028-12-26'],
};

test('UK bank holidays 2024 to 2028 match gov.uk, for England and Wales, Scotland and Northern Ireland', () => {
  for (const [region, want] of Object.entries(UK)) {
    const got = [2024, 2025, 2026, 2027, 2028].flatMap(y => days(region, y)).filter(d => !weekend(d));
    assert.deepEqual(got, want, region);
  }
});

test('a UK holiday on a weekend is shown on its day and its substitute day is named so', () => {
  const xmas = publicHolidays('GB-ENG', 2027).filter(h => h.date >= '2027-12-25');
  assert.deepEqual(xmas.map(h => `${h.date} ${h.name}`), ['2027-12-25 Christmas Day', '2027-12-26 Boxing Day', '2027-12-27 Christmas Day (substitute day)', '2027-12-28 Boxing Day (substitute day)']);
});

const AU: Record<string, Record<number, string[]>> = {
  'AU-NSW': {
    2026: ['2026-01-01', '2026-01-26', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-25', '2026-04-27', '2026-06-08', '2026-10-05', '2026-12-25', '2026-12-26', '2026-12-28'],
    2027: ['2027-01-01', '2027-01-26', '2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29', '2027-04-25', '2027-04-26', '2027-06-14', '2027-10-04', '2027-12-25', '2027-12-26', '2027-12-27', '2027-12-28'],
  },
  'AU-QLD': {
    2026: ['2026-01-01', '2026-01-26', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-25', '2026-05-04', '2026-10-05', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-28'],
    // The page lists only Monday 26 April for a Sunday Anzac Day; the Sunday is shown here too, as the day itself.
    2027: ['2027-01-01', '2027-01-26', '2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29', '2027-04-25', '2027-04-26', '2027-05-03', '2027-10-04', '2027-12-24', '2027-12-25', '2027-12-26', '2027-12-27', '2027-12-28'],
  },
  'AU-WA': {
    2026: ['2026-01-01', '2026-01-26', '2026-03-02', '2026-04-03', '2026-04-05', '2026-04-06', '2026-04-25', '2026-04-27', '2026-06-01', '2026-09-28', '2026-12-25', '2026-12-26', '2026-12-28'],
    2027: ['2027-01-01', '2027-01-26', '2027-03-01', '2027-03-26', '2027-03-28', '2027-03-29', '2027-04-25', '2027-04-26', '2027-06-07', '2027-09-27', '2027-12-25', '2027-12-26', '2027-12-27', '2027-12-28'],
  },
  'AU-SA': {
    2026: ['2026-01-01', '2026-01-26', '2026-03-09', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-25', '2026-06-08', '2026-10-05', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-28', '2026-12-31'],
    2027: ['2027-01-01', '2027-01-26', '2027-03-08', '2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29', '2027-04-25', '2027-06-14', '2027-10-04', '2027-12-24', '2027-12-25', '2027-12-26', '2027-12-27', '2027-12-28', '2027-12-31'],
  },
  'AU-ACT': {
    2026: ['2026-01-01', '2026-01-26', '2026-03-09', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-25', '2026-04-27', '2026-06-01', '2026-06-08', '2026-10-05', '2026-12-25', '2026-12-26', '2026-12-28'],
    2027: ['2027-01-01', '2027-01-26', '2027-03-08', '2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29', '2027-04-25', '2027-04-26', '2027-05-31', '2027-06-14', '2027-10-04', '2027-12-25', '2027-12-26', '2027-12-27', '2027-12-28'],
  },
  // From date.nager.at (Victoria's own page refused automated reads); the weekend Christmas days added as every state lists them.
  'AU-VIC': {
    2026: ['2026-01-01', '2026-01-26', '2026-03-09', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-25', '2026-06-08', '2026-09-25', '2026-11-03', '2026-12-25', '2026-12-26', '2026-12-28'],
  },
  'AU-NT': {
    2027: ['2027-01-01', '2027-01-26', '2027-03-26', '2027-03-27', '2027-03-28', '2027-03-29', '2027-04-25', '2027-04-26', '2027-05-03', '2027-06-14', '2027-08-02', '2027-12-24', '2027-12-25', '2027-12-26', '2027-12-27', '2027-12-28', '2027-12-31'],
  },
};

test('Australian public holidays match each state’s own list for 2026 and 2027', () => {
  for (const [region, years] of Object.entries(AU)) {
    for (const [year, want] of Object.entries(years)) assert.deepEqual(days(region, Number(year)), want, `${region} ${year}`);
  }
});

test('Western Australia from 2028: Easter Saturday, the King’s Birthday in June, WA Day in November', () => {
  const wa = publicHolidays('AU-WA', 2028);
  const on = (name: string) => wa.find(h => h.name === name)?.date;
  assert.equal(on('Easter Saturday'), '2028-04-15');
  assert.equal(on("King's Birthday"), '2028-06-12');
  assert.equal(on('Western Australia Day'), '2028-11-13');
  // Past what is announced, WA Day is said to be not known, not guessed.
  assert.deepEqual(publicNotKnown('AU-WA', 2029), ['Western Australia Day']);
  assert.deepEqual(publicNotKnown('AU-WA', 2027), []);
});

test('a day set each year that is not announced yet is left out and said so (Victoria’s Grand Final Friday 2027)', () => {
  assert.ok(!publicHolidays('AU-VIC', 2027).some(h => /Grand Final/.test(h.name)));
  assert.deepEqual(publicNotKnown('AU-VIC', 2027), ['Friday before the AFL Grand Final']);
  const notes = holidayNotes({ ...defaultSettings().holidays, region: 'AU-VIC', publicOn: true }, 2027);
  assert.match(notes.join(' '), /Grand Final for 2027 is not announced yet/);
});

test('school holidays are the days between the terms, with the summer break running into the next year', () => {
  const s = schoolHolidays('AU-QLD', 2026);
  assert.equal(s.known, true);
  const breaks = s.days.filter(d => d.end);
  assert.deepEqual(breaks.map(d => [d.date, d.end]), [['2026-04-03', '2026-04-19'], ['2026-06-27', '2026-07-12'], ['2026-09-19', '2026-10-05'], ['2026-12-12', '2027-01-26']]);
  assert.ok(s.days.some(d => d.date === '2026-04-20' && d.name === 'Term 2 starts'));
});

test('school dates for a year that is not published are said to be not known, never guessed', () => {
  assert.deepEqual(schoolHolidays('AU-NSW', 2028), { known: false, days: [] });
  // The summer after the last known year has a start but no end.
  const last = schoolHolidays('AU-NSW', 2027).days.at(-1)!;
  assert.equal(last.date, '2027-12-18');
  assert.match(last.name, /end is not known yet/);
  const notes = holidayNotes({ ...defaultSettings().holidays, region: 'AU-NSW', schoolOn: true }, 2028);
  assert.match(notes.join(' '), /School holidays for 2028 in New South Wales are not known yet/);
  // UK schools set their own: none bundled, and the reason is given.
  assert.match(holidayNotes({ ...defaultSettings().holidays, region: 'GB-ENG', schoolOn: true }, 2026).join(' '), /each council or school/);
  assert.equal(schoolYears('AU-NT'), null);
});

test('every bundled term is a real span in order, and terms do not overlap', () => {
  for (const [region, years] of Object.entries(SCHOOL_TERMS)) {
    for (const [year, terms] of Object.entries(years)) {
      let last = '';
      for (const [a, b] of terms) {
        assert.ok(a.startsWith(year) && b.startsWith(year), `${region} ${year} ${a}`);
        assert.ok(a < b && a > last, `${region} ${year} ${a}..${b}`);
        last = b;
      }
      assert.equal(terms.length, 4, `${region} ${year}`);
    }
  }
});

test('holidays become read-only all-day events the month shows, a break over several days on each of them', () => {
  const events = [...publicEvents('AU-QLD', [2026]), ...schoolEvents('AU-QLD', [2026]).events];
  assert.ok(eventsShownOn(events, '2026-04-10').some(e => e.title === 'School holidays (after term 1)'));
  assert.ok(eventsShownOn(events, '2026-04-06').some(e => e.title === 'Easter Monday'));
  assert.ok(eventsShownOn(events, '2026-04-06').every(e => !e.start));
  assert.deepEqual(schoolEvents('AU-QLD', [2029]).unknown, [2029]);
});

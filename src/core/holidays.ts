// Public holidays and school holidays for the Calendar, worked out here with no site to ask and no key.
//
// Public holidays come from each place's rules (the second Monday in June, the Monday after a Saturday Christmas...)
// and the date of Easter, worked out for any year (the Gregorian rule, below). A day a government sets afresh each
// year (Western Australia's King's Birthday, Victoria's Friday before the AFL Grand Final) and a one-off (a state
// funeral, a coronation) cannot be worked out: they are in the lists below for the years they are known, and a year
// past those lists says so (`notKnown`) rather than guessing.
//
// School holidays are set by each state's education department, a year or two ahead: they are in SCHOOL_TERMS below,
// for the years listed there and no others. A year that is not there says it is not known yet.
//
// To update (once a year, when the states publish the next year's terms and proclaimed days):
//   1. Add the year's four terms (first and last school day of each, for students) to SCHOOL_TERMS for each state.
//   2. Add WA's King's Birthday and Victoria's Grand Final Friday to PROCLAIMED, and any one-off day to ONE_OFF.
//   3. Run  npm test  (test/calendar-holidays.test.ts checks the rules against the official lists for checked years).
// Sources: each state's education department ("school term dates") and government ("public holidays") pages; for the
// UK, https://www.gov.uk/bank-holidays.json.

export type Country = 'AU' | 'GB';

export interface Region {
  /** 'AU-NSW', 'GB-SCT'... */
  code: string;
  name: string;
  /** Shown before the holiday's name on the calendar ("NSW"). */
  short: string;
}

export const COUNTRIES: Array<{ code: Country; name: string; regions: Region[] }> = [
  {
    code: 'AU', name: 'Australia', regions: [
      { code: 'AU-ACT', name: 'Australian Capital Territory', short: 'ACT' },
      { code: 'AU-NSW', name: 'New South Wales', short: 'NSW' },
      { code: 'AU-NT', name: 'Northern Territory', short: 'NT' },
      { code: 'AU-QLD', name: 'Queensland', short: 'QLD' },
      { code: 'AU-SA', name: 'South Australia', short: 'SA' },
      { code: 'AU-TAS', name: 'Tasmania', short: 'TAS' },
      { code: 'AU-VIC', name: 'Victoria', short: 'VIC' },
      { code: 'AU-WA', name: 'Western Australia', short: 'WA' },
    ],
  },
  {
    code: 'GB', name: 'United Kingdom', regions: [
      { code: 'GB-ENG', name: 'England and Wales', short: 'England and Wales' },
      { code: 'GB-SCT', name: 'Scotland', short: 'Scotland' },
      { code: 'GB-NIR', name: 'Northern Ireland', short: 'Northern Ireland' },
    ],
  },
];

export function regionOf(code: string): (Region & { country: Country }) | null {
  for (const c of COUNTRIES) {
    const r = c.regions.find(x => x.code === code);
    if (r) return { ...r, country: c.code };
  }
  return null;
}

export interface Holiday {
  /** YYYY-MM-DD */
  date: string;
  /** The last day, for a run of days (school holidays); absent for one day. */
  end?: string;
  name: string;
}

// ---- Days ----------------------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const key = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const parts = (day: string) => day.split('-').map(Number) as [number, number, number];
/** 0 = Sunday. */
const weekday = (day: string) => {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const plus = (day: string, n: number) => {
  const [y, m, d] = parts(day);
  return key(y, m, d + n);
};

/** Easter Sunday in the Gregorian calendar (the "anonymous" rule, right for every year from 1583). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return key(year, month, day);
}

/** The nth `wd` (0 = Sunday) of a month; n = -1 for the last. */
export function nthWeekday(year: number, month: number, wd: number, n: number): string {
  if (n > 0) {
    const first = key(year, month, 1);
    return plus(first, ((wd - weekday(first) + 7) % 7) + (n - 1) * 7);
  }
  const last = key(year, month + 1, 0);
  return plus(last, -((weekday(last) - wd + 7) % 7));
}

/** The first `wd` on or after a day. */
const onOrAfter = (day: string, wd: number) => plus(day, (wd - weekday(day) + 7) % 7);

const MON = 1;
const TUE = 2;
const isWeekend = (day: string) => weekday(day) === 0 || weekday(day) === 6;

/**
 * Fixed days that move off a weekend (New Year, Christmas and Boxing Day): each, in order, keeps its day when that is a
 * weekday; otherwise the next weekday that is not already a holiday is given instead, named "(substitute day)". So a
 * Saturday Christmas gives Monday 27th and a Sunday Boxing Day Tuesday 28th, as in every place here.
 */
function observed(days: Array<[string, string]>, taken: Set<string>): Holiday[] {
  const out: Holiday[] = [];
  for (const [date, name] of days) {
    if (!isWeekend(date) && !taken.has(date)) {
      out.push({ date, name });
      taken.add(date);
      continue;
    }
    out.push({ date, name });
    let day = plus(date, 1);
    while (isWeekend(day) || taken.has(day)) day = plus(day, 1);
    out.push({ date: day, name: `${name} (substitute day)` });
    taken.add(day);
  }
  return out;
}

/** A day that is a holiday where it falls, and on a weekend also gives the Monday after (`also`: on Saturday, Sunday or both). */
function withMonday(date: string, name: string, also: 'sat' | 'sun' | 'both' | 'none'): Holiday[] {
  const wd = weekday(date);
  const out: Holiday[] = [{ date, name }];
  if ((wd === 6 && (also === 'sat' || also === 'both')) || (wd === 0 && (also === 'sun' || also === 'both'))) out.push({ date: onOrAfter(date, MON), name: `${name} (substitute day)` });
  return out;
}

// ---- Days a government sets each year, and one-offs ---------------------------------------------------------------

/**
 * Days that are set afresh each year, by year, for the years `from` to `to` (outside them a rule below gives the day,
 * or there is none). A year in that span missing here is "not known yet". Checked against each state's own list.
 */
const PROCLAIMED: Record<string, Array<{ name: string; from: number; to?: number; days: Record<number, string> }>> = {
  'AU-WA': [
    // From 2028 the King's Birthday is the second Monday in June in Western Australia too (see australia()).
    { name: "King's Birthday", from: 2023, to: 2027, days: { 2023: '2023-09-25', 2024: '2024-09-23', 2025: '2025-09-29', 2026: '2026-09-28', 2027: '2027-09-27' } },
    // Western Australia Day moves from the first Monday in June to November in 2028.
    { name: 'Western Australia Day', from: 2028, days: { 2028: '2028-11-13' } },
  ],
  // 2027's depends on the AFL's fixture and is not announced yet.
  'AU-VIC': [{ name: 'Friday before the AFL Grand Final', from: 2023, days: { 2023: '2023-09-29', 2024: '2024-09-27', 2025: '2025-09-26', 2026: '2026-09-25' } }],
};

/** One-off public holidays (and holidays moved for a year), by region; 'AU' and 'GB' cover the whole country. */
const ONE_OFF: Record<string, Array<{ date: string; name: string; replaces?: string }>> = {
  AU: [{ date: '2022-09-22', name: 'National Day of Mourning' }],
  GB: [
    { date: '2020-05-08', name: 'Early May bank holiday (VE Day)', replaces: 'Early May bank holiday' },
    { date: '2022-06-02', name: 'Spring bank holiday', replaces: 'Spring bank holiday' },
    { date: '2022-06-03', name: 'Platinum Jubilee bank holiday' },
    { date: '2022-09-19', name: 'Bank Holiday for the State Funeral of Queen Elizabeth II' },
    { date: '2023-05-08', name: 'Bank holiday for the coronation of King Charles III' },
  ],
  'GB-SCT': [{ date: '2026-06-15', name: 'World Cup bank holiday' }],
};

// ---- Public holidays -----------------------------------------------------------------------------------------------

function australia(state: string, year: number): Holiday[] {
  const easter = easterSunday(year);
  const out: Holiday[] = [];
  const taken = new Set<string>();
  const add = (list: Holiday[]) => {
    for (const x of list) {
      out.push(x);
      taken.add(x.date);
    }
  };
  // New Year's Day and Australia Day: a weekend one gives the Monday after, everywhere.
  add(withMonday(key(year, 1, 1), "New Year's Day", 'both'));
  add(withMonday(key(year, 1, 26), 'Australia Day', 'both'));
  add([{ date: plus(easter, -2), name: 'Good Friday' }]);
  // Easter Saturday: everywhere but Tasmania, and in Western Australia only from 2028.
  if (['AU-NSW', 'AU-VIC', 'AU-QLD', 'AU-SA', 'AU-ACT', 'AU-NT'].includes(state) || (state === 'AU-WA' && year >= 2028)) add([{ date: plus(easter, -1), name: 'Easter Saturday' }]);
  if (['AU-NSW', 'AU-VIC', 'AU-QLD', 'AU-SA', 'AU-ACT', 'AU-WA', 'AU-NT'].includes(state)) add([{ date: easter, name: 'Easter Sunday' }]);
  add([{ date: plus(easter, 1), name: 'Easter Monday' }]);
  if (state === 'AU-TAS') add([{ date: plus(easter, 2), name: 'Easter Tuesday (state service and some awards only)' }]);
  // Anzac Day: on the day everywhere; a Monday after a weekend one only where the law gives it (NSW, the ACT and WA
  // after a Saturday or Sunday; Queensland and the NT after a Sunday; never in SA, Victoria or Tasmania).
  const anzacMonday: Record<string, 'sat' | 'sun' | 'both' | 'none'> = { 'AU-NSW': 'both', 'AU-WA': 'both', 'AU-ACT': 'both', 'AU-NT': 'sun', 'AU-QLD': 'sun' };
  add(withMonday(key(year, 4, 25), 'Anzac Day', anzacMonday[state] ?? 'none'));
  // Labour Day (Eight Hours Day in Tasmania, May Day in the Northern Territory).
  const labour: Record<string, [string, string]> = {
    'AU-NSW': [nthWeekday(year, 10, MON, 1), 'Labour Day'], 'AU-ACT': [nthWeekday(year, 10, MON, 1), 'Labour Day'], 'AU-SA': [nthWeekday(year, 10, MON, 1), 'Labour Day'],
    'AU-VIC': [nthWeekday(year, 3, MON, 2), 'Labour Day'], 'AU-TAS': [nthWeekday(year, 3, MON, 2), 'Eight Hours Day'],
    'AU-WA': [nthWeekday(year, 3, MON, 1), 'Labour Day'], 'AU-QLD': [nthWeekday(year, 5, MON, 1), 'Labour Day'], 'AU-NT': [nthWeekday(year, 5, MON, 1), 'May Day'],
  };
  add([{ date: labour[state][0], name: labour[state][1] }]);
  // The King's Birthday: the second Monday in June, but the first Monday in October in Queensland and, until 2027, a
  // proclaimed day in Western Australia.
  if (state === 'AU-QLD') add([{ date: nthWeekday(year, 10, MON, 1), name: "King's Birthday" }]);
  else if (state !== 'AU-WA' || year >= 2028) add([{ date: nthWeekday(year, 6, MON, 2), name: "King's Birthday" }]);
  if (state === 'AU-VIC') add([{ date: nthWeekday(year, 11, TUE, 1), name: 'Melbourne Cup Day' }]);
  if (state === 'AU-SA') add([{ date: nthWeekday(year, 3, MON, 2), name: 'Adelaide Cup Day' }]);
  if (state === 'AU-WA' && year < 2028) add([{ date: nthWeekday(year, 6, MON, 1), name: 'Western Australia Day' }]);
  if (state === 'AU-ACT') {
    add([{ date: nthWeekday(year, 3, MON, 2), name: 'Canberra Day' }]);
    if (year >= 2018) add([{ date: onOrAfter(key(year, 5, 27), MON), name: 'Reconciliation Day' }]);
  }
  if (state === 'AU-NT') add([{ date: nthWeekday(year, 8, MON, 1), name: 'Picnic Day' }]);
  for (const p of PROCLAIMED[state] ?? []) if (p.days[year]) add([{ date: p.days[year], name: p.name }]);
  // Part days: the evening before Christmas and the New Year (from 7 pm in SA and the NT, from 6 pm in Queensland).
  if (state === 'AU-SA' || state === 'AU-NT') {
    out.push({ date: key(year, 12, 24), name: 'Christmas Eve (from 7 pm)' }, { date: key(year, 12, 31), name: "New Year's Eve (from 7 pm)" });
  }
  if (state === 'AU-QLD' && year >= 2019) out.push({ date: key(year, 12, 24), name: 'Christmas Eve (from 6 pm)' });
  add(observed([[key(year, 12, 25), 'Christmas Day'], [key(year, 12, 26), state === 'AU-SA' ? 'Proclamation Day' : 'Boxing Day']], taken));
  for (const x of ONE_OFF.AU) if (x.date.startsWith(`${year}-`)) out.push(x);
  return out;
}

function britain(region: string, year: number): Holiday[] {
  const easter = easterSunday(year);
  const taken = new Set<string>();
  const out: Holiday[] = [];
  const firstDays: Array<[string, string]> = [[key(year, 1, 1), "New Year's Day"]];
  if (region === 'GB-SCT') firstDays.push([key(year, 1, 2), '2nd January']);
  out.push(...observed(firstDays, taken));
  if (region === 'GB-NIR') out.push(...observed([[key(year, 3, 17), "St Patrick's Day"]], taken));
  out.push({ date: plus(easter, -2), name: 'Good Friday' });
  if (region !== 'GB-SCT') out.push({ date: plus(easter, 1), name: 'Easter Monday' });
  out.push({ date: nthWeekday(year, 5, MON, 1), name: 'Early May bank holiday' });
  out.push({ date: nthWeekday(year, 5, MON, -1), name: 'Spring bank holiday' });
  if (region === 'GB-NIR') out.push(...observed([[key(year, 7, 12), 'Battle of the Boyne (Orangemen’s Day)']], taken));
  out.push({ date: region === 'GB-SCT' ? nthWeekday(year, 8, MON, 1) : nthWeekday(year, 8, MON, -1), name: 'Summer bank holiday' });
  if (region === 'GB-SCT') out.push(...observed([[key(year, 11, 30), "St Andrew's Day"]], taken));
  for (const x of out) taken.add(x.date);
  out.push(...observed([[key(year, 12, 25), 'Christmas Day'], [key(year, 12, 26), 'Boxing Day']], taken));
  // A year's moved and one-off days (VE Day, jubilees): a moved day takes the place of the rule's.
  const extra = [...ONE_OFF.GB, ...(ONE_OFF[region] ?? [])].filter(x => x.date.startsWith(`${year}-`));
  const replaced = new Set(extra.map(x => x.replaces).filter(Boolean));
  return [...out.filter(x => !replaced.has(x.name)), ...extra];
}

/** The public holidays of a region in a year, in date order. A day on a weekend is listed with its substitute. */
export function publicHolidays(region: string, year: number): Holiday[] {
  const r = regionOf(region);
  if (!r || !Number.isInteger(year) || year < 1990 || year > 2200) return [];
  const list = r.country === 'AU' ? australia(region, year) : britain(region, year);
  return list.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** What a region's public holidays for a year leave out because it is not announced yet (empty when nothing is). */
export function publicNotKnown(region: string, year: number): string[] {
  return (PROCLAIMED[region] ?? []).filter(p => year >= p.from && year <= (p.to ?? Infinity) && !p.days[year]).map(p => p.name);
}

// ---- School holidays -----------------------------------------------------------------------------------------------

/**
 * Government-school terms: the first and last school day of each term, for students, by state and year. Only years
 * listed here are known; any other year is "not known yet". Checked against each state's education department.
 */
export const SCHOOL_TERMS: Record<string, Record<number, Array<[string, string]>>> = {
  // NSW: Eastern division. Western division schools start Term 1 a week later (2026-02-09, 2027-02-10). 2028's
  // student first days wait on its staff development days, not published yet.
  'AU-NSW': {
    2026: [['2026-02-02', '2026-04-02'], ['2026-04-22', '2026-07-03'], ['2026-07-21', '2026-09-25'], ['2026-10-13', '2026-12-17']],
    2027: [['2027-02-03', '2027-04-09'], ['2027-04-29', '2027-07-02'], ['2027-07-20', '2027-09-24'], ['2027-10-11', '2027-12-17']],
  },
  'AU-VIC': {
    2026: [['2026-01-28', '2026-04-02'], ['2026-04-20', '2026-06-26'], ['2026-07-13', '2026-09-18'], ['2026-10-05', '2026-12-18']],
    2027: [['2027-01-28', '2027-03-25'], ['2027-04-12', '2027-06-25'], ['2027-07-12', '2027-09-17'], ['2027-10-04', '2027-12-17']],
    2028: [['2028-01-28', '2028-03-31'], ['2028-04-18', '2028-06-30'], ['2028-07-17', '2028-09-22'], ['2028-10-09', '2028-12-21']],
  },
  'AU-QLD': {
    2026: [['2026-01-27', '2026-04-02'], ['2026-04-20', '2026-06-26'], ['2026-07-13', '2026-09-18'], ['2026-10-06', '2026-12-11']],
    2027: [['2027-01-27', '2027-03-25'], ['2027-04-12', '2027-06-25'], ['2027-07-12', '2027-09-17'], ['2027-10-05', '2027-12-10']],
    2028: [['2028-01-24', '2028-03-31'], ['2028-04-18', '2028-06-23'], ['2028-07-10', '2028-09-15'], ['2028-10-03', '2028-12-08']],
  },
  'AU-WA': {
    2026: [['2026-02-02', '2026-04-02'], ['2026-04-20', '2026-07-03'], ['2026-07-20', '2026-09-25'], ['2026-10-12', '2026-12-17']],
    2027: [['2027-02-01', '2027-04-09'], ['2027-04-27', '2027-07-02'], ['2027-07-19', '2027-09-24'], ['2027-10-11', '2027-12-16']],
    2028: [['2028-02-02', '2028-04-07'], ['2028-04-24', '2028-06-30'], ['2028-07-17', '2028-09-22'], ['2028-10-09', '2028-12-14']],
  },
  'AU-SA': {
    2026: [['2026-01-27', '2026-04-10'], ['2026-04-27', '2026-07-03'], ['2026-07-20', '2026-09-25'], ['2026-10-12', '2026-12-11']],
    2027: [['2027-01-27', '2027-04-09'], ['2027-04-26', '2027-07-02'], ['2027-07-19', '2027-09-24'], ['2027-10-11', '2027-12-10']],
    2028: [['2028-01-31', '2028-04-13'], ['2028-05-01', '2028-07-07'], ['2028-07-24', '2028-09-29'], ['2028-10-16', '2028-12-15']],
  },
  'AU-TAS': {
    2026: [['2026-02-05', '2026-04-17'], ['2026-05-04', '2026-07-10'], ['2026-07-27', '2026-10-02'], ['2026-10-19', '2026-12-18']],
    2027: [['2027-02-04', '2027-04-09'], ['2027-04-26', '2027-07-02'], ['2027-07-19', '2027-09-24'], ['2027-10-11', '2027-12-16']],
  },
  // ACT: the day continuing students start (new students start a day or two before).
  'AU-ACT': {
    2026: [['2026-02-02', '2026-04-02'], ['2026-04-21', '2026-07-03'], ['2026-07-21', '2026-09-25'], ['2026-10-13', '2026-12-18']],
    2027: [['2027-02-02', '2027-04-09'], ['2027-04-28', '2027-07-02'], ['2027-07-20', '2027-09-24'], ['2027-10-12', '2027-12-17']],
    2028: [['2028-02-09', '2028-04-07'], ['2028-04-26', '2028-07-07'], ['2028-07-25', '2028-09-29'], ['2028-10-17', '2028-12-22']],
  },
  // The Northern Territory's dates could not be checked against its own pages yet, so none are given (shown as not known).
  'AU-NT': {},
};

/** A word on how a region's school dates are taken, for the settings ('' when there is nothing to add). */
export function schoolNote(region: string): string {
  if (region === 'AU-NSW') return 'New South Wales: Eastern division dates. Western division schools start Term 1 a week later.';
  if (region === 'AU-ACT') return 'ACT: the day continuing students start each term.';
  if (region === 'AU-NT') return 'The Northern Territory’s school dates are not included yet: they could not be checked against its own pages.';
  return '';
}

/** The years the bundled school terms cover, lowest and highest (null when none). */
export function schoolYears(region: string): [number, number] | null {
  const years = Object.keys(SCHOOL_TERMS[region] ?? {}).map(Number).sort((a, b) => a - b);
  return years.length ? [years[0], years[years.length - 1]] : null;
}

/** Can school holidays be shown for this region at all? (UK schools set their own: no.) */
export const hasSchoolData = (region: string): boolean => !!SCHOOL_TERMS[region];

/**
 * The school holidays that start in a year: the breaks between its terms, and the summer break after its last term
 * (to the day before the next year's first, when that year is known). `known` is false when the year's terms are not
 * in the list; then there are no days.
 */
export function schoolHolidays(region: string, year: number): { known: boolean; days: Holiday[] } {
  const terms = SCHOOL_TERMS[region]?.[year];
  if (!terms) return { known: false, days: [] };
  const days: Holiday[] = [];
  for (let i = 0; i < terms.length; i++) {
    const from = plus(terms[i][1], 1);
    const nextStart = i + 1 < terms.length ? terms[i + 1][0] : SCHOOL_TERMS[region]?.[year + 1]?.[0]?.[0];
    if (nextStart) {
      const to = plus(nextStart, -1);
      if (to >= from) days.push({ date: from, end: to, name: i + 1 < terms.length ? `School holidays (after term ${i + 1})` : 'School holidays (summer)' });
      days.push({ date: nextStart, name: i + 1 < terms.length ? `Term ${i + 2} starts` : 'Term 1 starts' });
    } else {
      days.push({ date: from, name: 'School holidays start (the end is not known yet)' });
    }
  }
  // The year's first term start, when the summer before it is not known (the year before is not in the list).
  if (!SCHOOL_TERMS[region]?.[year - 1]) days.unshift({ date: terms[0][0], name: 'Term 1 starts' });
  return { known: true, days };
}

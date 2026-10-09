// The license agreement in the "Add a printer" wizard. It has to pass for a real one: plain legal boilerplate, all
// numbered, the warranty part in capitals. The odd clauses are buried where nobody scrolls. The same text every time
// (a seeded shuffle), and the reading check uses the measured word count, never a typed one.

/** A small seeded random number source (mulberry32): the same seed gives the same agreement. */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const countWords = text => {
  const t = String(text).trim();
  return t ? t.split(/\s+/).length : 0;
};

const PARTS = [
  ['Printer Network Services Agreement', [
    'Definitions', 'Acceptance of this Agreement', 'Grant of Licence', 'Restrictions', 'Ownership', 'Printer Drivers',
    'Firmware and Automatic Updates', 'Network Printing', 'Shared Devices', 'Print Jobs', 'Print Queues',
    'Status Monitor', 'Estimated Ink Levels', 'Third-Party Services', 'Support', 'Fees', 'Suspension',
    'Termination', 'Disclaimer of Warranties', 'Limitation of Liability', 'Indemnification', 'Export Controls',
    'Governing Law', 'Dispute Resolution', 'Changes to this Agreement', 'General',
  ]],
  ['Privacy Statement', [
    'Information We Collect', 'Print Telemetry', 'Document Information', 'How We Use Information',
    'Sharing of Information', 'Retention', 'Security', 'Your Choices', 'Children', 'International Transfers',
    'Contact',
  ]],
  ['Consumables Policy', [
    'Genuine Supplies', 'Third-Party Cartridges', 'Cartridge Protection', 'Ink Usage', 'Calibration',
    'Paper and Media', 'Recycling', 'Final Provisions',
  ]],
];

const DEFINITIONS = [
  '"Agreement" means this Printer Network Services Agreement, together with the Privacy Statement and the Consumables Policy.',
  '"Device" means any printer, multifunction device or other output device connected to the Network.',
  '"Software" means the printer driver, status monitor, firmware and any related programs provided with the Device.',
  '"Consumables" means ink, toner, ribbons, print heads, paper and any other supplies used by the Device.',
  '"Print Job" means any document, image or other file sent to a Device for output.',
  '"Network" means the local network through which one or more Devices are made available to you.',
  '"Telemetry" means technical information about the use and condition of a Device.',
  '"You" means the person accepting this Agreement, and any organisation on whose behalf that person acts.',
];

const TEMPLATES = [
  'You may not {restrict} the {thing}, in whole or in part, except as expressly permitted by this Agreement or by applicable law.',
  'The Provider may, at its sole discretion and without notice, {change} the {thing} from time to time.',
  'Nothing in this Agreement shall be construed as {construed}.',
  'The {thing} is provided "as is" and "as available", without warranty of any kind.',
  'You acknowledge that the {thing} may {may}, and that such behaviour does not constitute a defect.',
  'Where the {thing} is used on a shared Network, the Provider is not responsible for {notResp}.',
  'Your continued use of the {thing} after {event} constitutes acceptance of the revised terms.',
  'To the maximum extent permitted by law, the Provider disclaims all liability for {notResp}.',
  'The Provider may collect {data} for the purposes of {purpose}.',
  'Information collected under this section may be retained for {period} and may be disclosed to {whom}.',
  'Consumables that are not genuine may cause the Device to {may}.',
  'If any provision of this Agreement is held to be unenforceable, the remaining provisions shall remain in full force and effect.',
  'This section survives the expiry or termination of this Agreement.',
  'Notices under this section shall be given {how}.',
  'You are responsible for ensuring that any use of the {thing} complies with all applicable laws and regulations.',
  'The Provider does not guarantee that the {thing} will be uninterrupted, timely, secure or error-free.',
  'Any failure by the Provider to enforce a provision of this Agreement shall not constitute a waiver of that provision.',
  'Subject to the terms of this Agreement, you may use the {thing} solely in connection with the Device.',
  'The Provider reserves all rights not expressly granted to you in this Agreement.',
  'You agree to cooperate with the Provider in connection with {purpose}.',
];

const SLOTS = {
  thing: ['Software', 'Device', 'printer driver', 'firmware', 'print services', 'network printing feature', 'status monitor', 'documentation'],
  restrict: ['copy', 'modify', 'reverse engineer', 'decompile', 'sublicense', 'rent', 'lease', 'redistribute', 'translate'],
  change: ['update', 'suspend', 'modify', 'withdraw', 'rename', 'discontinue'],
  construed: ['a transfer of ownership of the Device', 'a guarantee that any Print Job will be completed', 'a waiver of any right of the Provider', 'the creation of a partnership or joint venture', 'a licence to any trade mark of the Provider'],
  may: ['pause during printing', 'require calibration', 'display estimated ink levels', 'request firmware updates', 'decline certain Print Jobs', 'print more slowly than expected', 'restart without warning'],
  notResp: ['lost or delayed Print Jobs', 'colour accuracy', 'paper jams caused by non-recommended media', 'documents printed on an unintended Device', 'the availability of any Device on the Network', 'interruptions caused by maintenance or updates'],
  event: ['the effective date of any change', 'the installation of a firmware update', 'the installation of new Consumables', 'notice of any revision'],
  data: ['page counts', 'ink and toner levels', 'error codes', 'the names of Print Jobs', 'usage patterns', 'Device settings'],
  purpose: ['improving print quality', 'diagnosing faults', 'offering supplies', 'optimising the Network', 'product research', 'preventing misuse'],
  period: ['as long as necessary for these purposes', 'up to seven years', 'the life of the Device'],
  whom: ['service partners', 'affiliated companies', 'resellers', 'other Devices on the same Network'],
  how: ['in writing', 'by email', 'through the status monitor', 'by a notice printed on the Device'],
};

// The buried clauses: section title -> the clauses that must appear in it, in order, after its opening ones.
const FIXED = {
  'Acceptance of this Agreement': ['By selecting "I accept", you confirm that you have read this Agreement in full. The time taken to accept may be recorded.'],
  'Estimated Ink Levels': ['Estimated ink levels are estimates.', 'An estimate may change without any ink being used.'],
  'Shared Devices': ['Devices on the same Network may share information about Print Jobs with one another, including document names, the number of attempts and the time taken.'],
  'Print Jobs': ['A Device may decline any Print Job at its discretion, including a Print Job it considers beneath it.'],
  'Calibration': ['Calibration uses cyan.', 'Calibration may use all of the cyan.'],
  'Paper and Media': ['A Device may report that paper has run out when paper has not run out.'],
  'Final Provisions': ['If you have read this far, you are the only one.'],
};

/** Builds the agreement: [{ part, sections: [{ n, title, clauses: [{ n, text }] }] }] and its measured word count. */
export function buildTerms(spec) {
  const rand = seeded(spec.seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const sentence = () => pick(TEMPLATES).replace(/\{(\w+)\}/g, (_, key) => pick(SLOTS[key]));
  const clauseText = () => {
    const n = 1 + Math.floor(rand() * 3);
    const out = [];
    while (out.length < n) {
      const s = sentence();
      if (!out.includes(s)) out.push(s);
    }
    return out.join(' ');
  };

  const all = PARTS.flatMap(([part, titles]) => titles.map(title => ({ part, title })));
  const perSection = spec.words / all.length;
  const parts = [];
  let words = 0;
  all.forEach(({ part, title }, i) => {
    if (!parts.length || parts[parts.length - 1].part !== part) parts.push({ part, sections: [] });
    const n = i + 1;
    const clauses = [];
    const add = text => {
      clauses.push({ n: `${n}.${clauses.length + 1}`, text });
      words += countWords(`${n}.${clauses.length} ${text}`);
    };
    words += countWords(`${n}. ${title}`);
    if (title === 'Definitions') DEFINITIONS.forEach(add);
    const fixed = FIXED[title] ?? [];
    const target = perSection * n;
    // The buried clauses go in the middle of their section, where the eye has already given up.
    // The very last clause of the whole agreement is the exception: it sits right above "I accept".
    const last = i === all.length - 1;
    let placed = last ? fixed.length : 0;
    while (words < target - 20 || placed < fixed.length) {
      if (placed < fixed.length && clauses.length >= 3) add(fixed[placed++]);
      else add(clauseText());
    }
    if (last) fixed.forEach(add);
    if (title === 'Disclaimer of Warranties' || title === 'Limitation of Liability') {
      for (const c of clauses) c.text = c.text.toUpperCase();
    }
    parts[parts.length - 1].sections.push({ n, title, clauses });
  });
  return { parts, words };
}

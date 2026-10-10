// CareLine conversation: which detail to ask for next, the question wording, and
// code parsers for short answers (yes/no, phone, age, name, severity).
//
// The model extracts symptoms, body part, duration and department from free speech.
// Short answers like "Ravi", "34" or "98450 12345" are parsed here instead: they are
// exact, the model has no context for a bare "34", and code can't invent anything.

export const MAX_ASKS = 2;  // per detail; after that we move on rather than loop

// The order CareLine asks in. `missing(details)` says whether the detail still needs asking.
export const STEPS = [
  { field: 'problem', question: "Please tell me what's wrong.", retry: 'Sorry, could you tell me what the problem is?', missing: (d) => !d.symptoms.length },
  { field: 'body_part', question: 'Which part of your body is affected?', retry: 'Which part of the body is it? For example, your knee, stomach, skin or teeth.', missing: (d) => !d.department && !d.body_part },
  { field: 'duration', question: 'How long have you had this?', retry: 'How many days or weeks has this been going on?', missing: (d) => !d.duration },
  { field: 'severity', question: 'On a scale of 1 to 10, how bad is it? And is it getting worse?', retry: 'Please give me a number from 1 to 10, where 10 is the worst.', missing: (d) => d.severity == null },
  { field: 'name', question: "What is the patient's name?", retry: 'Sorry, could you say the name again?', missing: (d) => !d.name },
  { field: 'age', question: 'And how old is the patient?', retry: 'Please tell me the age in years.', missing: (d) => d.age == null },
  { field: 'phone', question: 'What phone number can we reach you on?', retry: 'Please say the 10-digit mobile number, one digit at a time.', missing: (d) => !d.phone },
];

export const emptyDetails = () => ({
  symptoms: [], body_part: null, duration: null, onset: null, severity_words: [],
  severity: null, worsening: null, name: null, age: null, phone: null,
  department: null, urgency: null, summary_en: null,
});

/** The next step to ask, or null when everything is known or has been asked MAX_ASKS times. */
export function nextStep(details, asked = {}) {
  return STEPS.find((s) => s.missing(details) && (asked[s.field] ?? 0) < MAX_ASKS) ?? null;
}

/** Fold a parsed intake into the details. Known values win; the intake fills gaps. */
export function absorbIntake(details, intake) {
  if (!intake) return details;
  const both = (a, b) => [...new Set([...a, ...b])];
  return {
    ...details,
    symptoms: both(details.symptoms, intake.symptoms),
    body_part: details.body_part ?? intake.body_part,
    duration: details.duration ?? intake.duration,
    onset: details.onset ?? intake.onset,
    severity_words: both(details.severity_words, intake.severity_words),
    name: details.name ?? intake.name,
    age: details.age ?? intake.age,
    department: details.department ?? intake.department,
    urgency: moreUrgent(details.urgency, intake.urgency),
    // The first description carries the story; later answers ("34", "Ravi") would only add noise.
    summary_en: details.summary_en ?? intake.summary_en,
  };
}

const RANK = { today: 0, this_week: 1, routine: 2 };
export function moreUrgent(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK[b] < RANK[a] ? b : a;
}

/**
 * Urgency from the model, raised (never lowered) by what the patient said in code:
 * severity 8+ → today; severity 5+ or getting worse → at least this week.
 */
export function finalUrgency(details) {
  let u = details.urgency ?? 'this_week';
  if (details.severity >= 8) u = moreUrgent(u, 'today');
  else if (details.severity >= 5 || details.worsening) u = moreUrgent(u, 'this_week');
  return u;
}

// ---- Answer parsers -------------------------------------------------------------------

const clean = (s) => String(s ?? '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** true, false, or null when the answer is neither. */
export function parseYesNo(said) {
  const s = clean(said);
  if (/\b(no|nope|nah|not|don't|dont|do not|wrong|incorrect|nahi|nahin|different|another|other)\b/.test(s)) return false;
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|correct|right|fine|please|go ahead|book it|haan|han|ha|theek|confirm|perfect|great)\b/.test(s)) return true;
  return null;
}

const UNITS = { zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "thirty four" → 34, "a hundred and two" → 102. Returns the first number found, or null. */
export function firstNumber(said) {
  const s = clean(said);
  const digits = s.match(/\b\d{1,3}\b/);
  if (digits) return Number(digits[0]);
  let total = null;
  for (const w of s.split(' ')) {
    if (w in TENS) total = (total ?? 0) + TENS[w];
    else if (w in TEENS) total = (total ?? 0) + TEENS[w];
    else if (w in UNITS && w !== 'o' && w !== 'oh') total = (total ?? 0) + UNITS[w];
    else if (w === 'hundred') total = (total ?? 1) * 100;
    else if (total != null && w !== 'and') break;
  }
  return total;
}

export function parseAge(said) {
  const n = firstNumber(said);
  return n != null && n >= 0 && n <= 120 ? n : null;
}

/** Severity 1-10 plus whether it is getting worse (true / false / null). */
export function parseSeverity(said) {
  const s = clean(said);
  const n = firstNumber(s);
  const severity = n != null && n >= 1 && n <= 10 ? n : null;
  let worsening = null;
  if (/\b(worse|worsening|getting bad|increasing|more and more|badh raha|badh rahi)\b/.test(s)) worsening = true;
  if (/\b(not (getting )?worse|same|stable|better|improving|no change)\b/.test(s)) worsening = false;
  return { severity, worsening };
}

/**
 * A 10-digit Indian mobile number from digits or spoken words ("double five" → 55).
 * Drops a leading +91, 91 or 0. Returns null unless exactly 10 digits starting 6-9.
 */
export function parsePhone(said) {
  const words = clean(said).replace(/(\d)/g, ' $1 ').split(' ').filter(Boolean);
  let digits = '';
  let repeat = 1;
  for (const w of words) {
    if (w === 'double') { repeat = 2; continue; }
    if (w === 'triple') { repeat = 3; continue; }
    const d = /^\d$/.test(w) ? w : w in UNITS ? String(UNITS[w]) : null;
    if (d != null) digits += d.repeat(repeat);
    repeat = 1;
  }
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Read a phone number back digit by digit, in two groups of five. */
export const spokenPhone = (p) => `${p.slice(0, 5).split('').join(' ')}, ${p.slice(5).split('').join(' ')}`;
export const displayPhone = (p) => `${p.slice(0, 5)} ${p.slice(5)}`;

const NOT_A_NAME = new Set(['yes', 'no', 'hello', 'hi', 'okay', 'ok', 'the', 'patient', 'me', 'myself', 'i', 'my', 'sorry']);

/** "My name is Ravi Kumar." → "Ravi Kumar". A short bare answer is taken as the name. */
export function parseName(said) {
  const raw = String(said ?? '').trim().replace(/[.!?,]+$/g, '');
  const m = raw.match(/(?:my name is|name is|this is|i am|i'm|it's|its|naam)\s+(.+)$/i);
  const candidate = (m ? m[1] : raw).replace(/[.!?,].*$/, '').trim();
  const words = candidate.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3 || NOT_A_NAME.has(words[0].toLowerCase())) return null;
  if (words.some((w) => !/^\p{L}[\p{L}'-]*$/u.test(w))) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Duration fallback when the model gives none: "3 days", "two weeks", "since yesterday". */
export function parseDuration(said) {
  const s = clean(said);
  const m = s.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple of) (day|days|week|weeks|month|months|year|years|hour|hours)\b/);
  if (m) return `${m[1]} ${m[2]}`;
  const since = s.match(/\bsince (yesterday|last night|this morning|morning|last week|last month|\w+day)\b/);
  return since ? `since ${since[1]}` : null;
}

/** Time preferences in a reply like "something in the evening" or "Monday morning". */
export function parseTimePreference(said) {
  const s = clean(said);
  const pref = {};
  if (/\bmorning\b/.test(s)) pref.part = 'morning';
  else if (/\bafternoon\b/.test(s)) pref.part = 'afternoon';
  else if (/\bevening\b/.test(s)) pref.part = 'evening';
  if (/\btoday\b/.test(s)) pref.day = 'today';
  else if (/\btomorrow\b/.test(s)) pref.day = 'tomorrow';
  else {
    const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].findIndex((d) => s.includes(d));
    if (day >= 0) pref.weekday = day;
  }
  if (/\b(later|after|next)\b/.test(s)) pref.later = true;
  return pref;
}

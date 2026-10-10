// CareLine red flags: deterministic keyword rules, run BEFORE anything is booked.
//
// The model never decides an emergency. Measured 2026-10-01: a clip about "ending my
// life" came back from the model as urgency "routine". So these rules run in code on
// the verbatim transcript AND the model's JSON, and any single match stops booking.
//
// Deliberately over-inclusive. There is no negation handling, so "no chest pain" still
// matches: a false alarm costs a phone call, a missed one can cost a life.
//
// Each rule matches when ANY of `any` matches, or when EVERY group in `all` has a match.
// Strings are plain substrings (used for Devanagari, where \b does not work); RegExps
// are tested as written. Text is lower-cased first, with curly apostrophes made straight.

const PERSON = '(my|his|her|their|the|our)';

export const RED_FLAGS = [
  {
    id: 'chest', label: 'Chest pain or pressure',
    any: [
      /\bchest (pain|pressure|tightness|heaviness|discomfort)/,
      /\bchest (\w+ )?(hurts|hurting|aches|aching|tight|heavy)/,
      new RegExp(`\\b(pain|pressure|tightness|heaviness) in ${PERSON} chest\\b`),
      /\bheart attack\b/,
      'seene mein dard', 'seene me dard', 'sine mein dard', 'chhati mein dard', 'chhati me dard',
      'सीने में दर्द', 'छाती में दर्द', 'सीने में जकड़',
    ],
  },
  {
    id: 'breathing', label: "Can't breathe / breathlessness",
    any: [
      /\b(can'?t|cannot|can not|couldn'?t|unable to|not able to|struggling to|hard to|difficult to) breathe?\b/,
      /\b(difficulty|trouble|problems?|struggling) (in |with )?breathing\b/,
      /\bbreathless/, /\bshort(ness)? of breath\b/, /\bgasping\b/, /\bchoking\b/,
      'saans nahi', 'saans nahin', 'saans lene mein', 'saans phool',
      'सांस नहीं', 'साँस नहीं', 'सांस लेने में', 'साँस लेने में', 'सांस फूल',
    ],
  },
  {
    id: 'face', label: 'Face drooping',
    any: [
      /\bface (is |has |went )?(droop|dropped|fallen|crooked|lopsided)/,
      /\bdroop(y|ing)? (face|mouth|side)/,
      new RegExp(`\\b(one side of|half of) ${PERSON} face\\b`),
      'chehra tedha', 'चेहरा टेढ़ा',
    ],
  },
  {
    id: 'speech', label: 'Slurred speech',
    any: [
      /\bslurr/,
      /\bspeech (is )?(slurred|unclear|garbled)/,
      /\b(can'?t|cannot|unable to) (speak|talk) (properly|clearly)\b/,
      'zubaan ladkhada', 'जुबान लड़खड़ा', 'बोलने में दिक्कत',
    ],
  },
  {
    id: 'weakness', label: 'Sudden weakness on one side',
    any: [
      /\b(weak|weakness|numb|numbness) (on|in) (one|the left|the right|my left|my right|his left|his right|her left|her right) side\b/,
      new RegExp(`\\b(one|left|right) side of ${PERSON} body\\b`),
      new RegExp(`\\b(can'?t|cannot|unable to) (move|lift|feel) ${PERSON} (left|right) (arm|leg|hand|side)`),
      /\bsudden (weakness|numbness)\b/, /\bparaly/,
      'lakwa', 'लकवा', 'एक तरफ कमजोरी',
    ],
  },
  {
    id: 'unconscious', label: 'Unconscious / fainted',
    any: [
      /\bunconscious\b/, /\bfainted\b/, /\bfainting\b/, /\bpassed out\b/, /\bblacked out\b/,
      /\bcollapsed\b/, /\b(lost|loss of) consciousness\b/, /\bunresponsive\b/, /\bnot responding\b/,
      /\bwon'?t wake up\b/,
      'behosh', 'बेहोश',
    ],
  },
  {
    id: 'seizure', label: 'Seizure / fit',
    any: [
      /\bseizure/, /\bconvuls/, /\bfitting\b/, /\b(a|had|having|has|have) fits?\b/,
      'mirgi', 'daura pad', 'मिर्गी', 'दौरा पड़',
    ],
  },
  {
    id: 'bleeding', label: 'Heavy bleeding',
    any: [
      /\bheavy bleeding\b/, /\bbleeding (very )?(heavily|a lot|badly|profusely|non.?stop)\b/,
      /\b(won'?t|will not|doesn'?t|does not|can'?t) stop bleeding\b/,
      /\bbleeding (that |which )?(won'?t|will not|doesn'?t|does not) stop\b/,
      /\b(lots of|a lot of) blood\b/,
      /\b(vomiting|throwing up|coughing up|coughing) blood\b/, /\bblood in (my |the )?vomit\b/,
      'bahut khoon', 'khoon nahi ruk', 'khoon nahin ruk', 'बहुत खून', 'खून नहीं रुक',
    ],
  },
  {
    id: 'head', label: 'Severe head injury',
    any: [/\b(severe|serious|bad|major) head injur/, /\bknocked out\b/],
    all: [
      [
        /\bhead injur/, /\bhead (trauma|wound)\b/,
        new RegExp(`\\b(hit|banged|bumped|struck|hurt|injured) ${PERSON} head\\b`),
        new RegExp(`\\bfell on ${PERSON} head\\b`),
        'sar par chot', 'sar pe chot', 'सिर पर चोट', 'सिर में चोट',
      ],
      [
        /\b(severe|serious|badly|bad|hard|bleeding|blood|vomit|unconscious|confused|confusion|drowsy|dizzy)/,
        'khoon', 'ulti', 'खून', 'उल्टी',
      ],
    ],
  },
  {
    id: 'suicidal', label: 'Suicidal thoughts',
    any: [
      /\bsuicid/, /\bkill (myself|himself|herself|themselves)\b/,
      new RegExp(`\\bend(ing)? ${PERSON} (own )?life\\b`),
      /\b(want|wanted|wanting|wants) to die\b/, /\b(don'?t|do not) want to (live|be alive)\b/,
      /\bself.?harm/, /\b(hurt|harm|cut)(ing)? myself\b/, /\bno reason to live\b/,
      'khudkushi', 'aatmahatya', 'atmahatya', 'marna chahta', 'marna chahti', 'jeena nahi chahta', 'jeena nahi chahti',
      'आत्महत्या', 'खुदकुशी', 'मरना चाहत', 'जीना नहीं चाहत',
    ],
  },
  {
    id: 'allergy', label: 'Severe allergic reaction / throat swelling',
    any: [
      /\bsevere allergic\b/, /\banaphyla/,
      /\b(throat|tongue) (is |feels )?(swelling|swollen|closing|closing up)/,
      /\bswell(ing|en) (of )?(my |the )?(throat|tongue)\b/,
      'gala sooj', 'गला सूज',
    ],
  },
  {
    id: 'pregnancy', label: 'Pregnancy with bleeding or severe pain',
    all: [
      [/\bpregnan/, /\bexpecting a baby\b/, 'garbh', 'pet se', 'गर्भ'],
      [
        /\bbleed/, /\bblood\b/, /\bspotting\b/,
        /\b(severe|bad|heavy|unbearable|terrible|sharp|intense|lot of) (\w+ )?pain\b/,
        /\bpain\b.*\b(severe|unbearable|terrible)\b/,
        'khoon', 'bahut dard', 'खून', 'तेज़ दर्द', 'बहुत दर्द',
      ],
    ],
  },
  {
    // The spec says "child with". Fever with a stiff neck is an emergency at any age,
    // and "child" is easy to leave unsaid, so age is not required here.
    id: 'stiffneck', label: 'High fever with stiff neck',
    all: [
      [
        /\bstiff neck\b/, /\bneck (is |feels )?(stiff|rigid)/,
        new RegExp(`\\b(can'?t|cannot) (bend|move) ${PERSON} neck\\b`),
        'gardan akad', 'गर्दन अकड़',
      ],
      [/\bfever/, /\btemperature\b/, 'bukhar', 'बुखार'],
    ],
  },
  {
    id: 'poisoning', label: 'Poisoning / overdose',
    any: [
      /\bpoison/, /\boverdos/,
      /\b(took|taken|swallowed) (too many|a lot of|lots of|all (my|the|his|her)) (\w+ )?(pills|tablets|medicines?)\b/,
      /\b(swallowed|drank|drunk|ate) (some )?(bleach|pesticide|kerosene|acid|phenyl|cleaning)/,
      'zeher', 'zehar', 'jahar', 'ज़हर', 'जहर',
    ],
  },
];

const hit = (text, p) => (typeof p === 'string' ? text.includes(p) : p.test(text));

/** Lower-case and straighten apostrophes, so "Can’t" matches "can't". */
export const normalise = (s) => String(s ?? '').toLowerCase().replace(/[‘’`]/g, "'").replace(/\s+/g, ' ');

/**
 * Every red flag found in any of the given texts. Pass the verbatim transcript and the
 * model's output (raw string or parsed intake); objects are flattened to their values.
 * Returns [{id, label}], empty when nothing matched.
 */
export function findRedFlags(...sources) {
  const text = normalise(sources.map((s) => (s && typeof s === 'object' ? flatten(s) : s ?? '')).join(' \n '));
  return RED_FLAGS
    .filter((rule) => rule.any?.some((p) => hit(text, p)) || rule.all?.every((group) => group.some((p) => hit(text, p))))
    .map(({ id, label }) => ({ id, label }));
}

function flatten(obj) {
  return Object.values(obj).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string').join(' \n ');
}

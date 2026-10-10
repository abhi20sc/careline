// CareLine's deterministic rules: red flags, booking, intake parsing.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRedFlags } from '../shared/careline-redflags.js';
import { freeSlots, pickSlot, nextSlots } from '../shared/careline-booking.js';
import { parseIntake, followUpQuestion, mergeIntake, INTAKE_FITS } from '../shared/careline-intake.js';

const ids = (...texts) => findRedFlags(...texts).map((f) => f.id);

// ---- Red flags ------------------------------------------------------------------------

const SHOULD_FLAG = {
  chest: ['I have chest pain since morning', 'there is a lot of pressure in my chest', 'My chest feels tight', 'seene mein dard ho raha hai', 'मुझे सीने में दर्द है'],
  breathing: ["I can't breathe properly", 'I can’t breathe', 'difficulty breathing since last night', 'I get breathless walking', 'saans nahi aa rahi', 'सांस नहीं आ रही'],
  face: ['his face is drooping on one side', 'her face has dropped'],
  speech: ['my father has slurred speech', 'he is slurring his words'],
  weakness: ['sudden weakness in my arm', "I can't move my left arm", 'weakness on one side', 'lakwa maar gaya'],
  unconscious: ['my mother fainted this morning', 'he passed out', 'she is unconscious', 'wo behosh ho gaya', 'वो बेहोश हो गई'],
  seizure: ['my son had a seizure', 'she is having fits', 'he had a fit last night'],
  bleeding: ['heavy bleeding from the cut', "it won't stop bleeding", 'I am vomiting blood'],
  head: ['I hit my head and now I keep vomiting', 'severe head injury from a bike accident', 'head injury and bleeding'],
  suicidal: ['I want to kill myself', 'I keep thinking about ending my life', "I don't want to live anymore", 'having suicidal thoughts', 'I want to die'],
  allergy: ['my throat is swelling after eating prawns', 'severe allergic reaction to a bee sting', 'my tongue is swollen'],
  pregnancy: ['I am pregnant and bleeding', "I'm five months pregnant with severe stomach pain"],
  stiffneck: ['my child has high fever and a stiff neck', 'fever and his neck is stiff'],
  poisoning: ['my son drank some poison', 'she took too many sleeping pills', 'possible overdose'],
};

for (const [id, phrases] of Object.entries(SHOULD_FLAG)) {
  for (const phrase of phrases) {
    test(`red flag ${id}: "${phrase}"`, () => assert.ok(ids(phrase).includes(id), `got ${ids(phrase)}`));
  }
}

const SHOULD_NOT_FLAG = [
  "I've had pain in my right knee for about a week",
  'I have a headache',
  'My tooth hurts',
  'my skin is itchy with red patches',
  'I am pregnant and want a routine check-up',
  'I have had a fever for three days',
  'I banged my head on the cupboard yesterday',
  'my neck is stiff from sleeping badly',
  'I feel a bit low lately',
  'my eyes are red and watering',
];
for (const phrase of SHOULD_NOT_FLAG) {
  test(`no red flag: "${phrase}"`, () => assert.deepEqual(ids(phrase), []));
}

test('red flags also scan the model JSON, not just the verbatim text', () => {
  const intake = { symptoms: ['chest tight', "can't breathe"], summary_en: 'Chest tightness since morning.' };
  assert.deepEqual(ids('it feels odd here', intake), ['chest', 'breathing']);
});

test('red flags scan a raw unparsed model reply', () => {
  assert.deepEqual(ids('hmm', '{"s":["unconscious"'), ['unconscious']);
});

test('red flags are case-insensitive', () => {
  assert.deepEqual(ids('CHEST PAIN'), ['chest']);
});

// ---- Booking --------------------------------------------------------------------------

const schedule = {
  slot_minutes: 15,
  days: 5,
  doctors: [
    { id: 'o1', name: 'Dr A', department: 'Orthopaedics', hours: ['09:00', '10:00'], taken: { 0: ['09:00'], 1: ['09:00', '09:15'] } },
    { id: 'o2', name: 'Dr B', department: 'Orthopaedics', hours: ['14:00', '15:00'], taken: {} },
    { id: 'e1', name: 'Dr C', department: 'ENT', hours: ['09:00', '09:30'], taken: {} },
  ],
};
const at = (day, hh, mm = 0) => new Date(2026, 9, day, hh, mm);  // October 2026, local time

test('free slots skip taken, past and app-booked slots', () => {
  const now = at(1, 9, 20);
  const booked = [{ doctorId: 'o1', start: at(1, 9, 30).toISOString() }];
  const ortho = freeSlots(schedule, now, booked).filter((s) => s.department === 'Orthopaedics');
  assert.deepEqual(ortho.slice(0, 2).map((s) => s.start.getTime()), [at(1, 9, 45).getTime(), at(1, 14).getTime()]);
});

test('free slots cover exactly 5 days', () => {
  const slots = freeSlots(schedule, at(1, 0, 1));
  assert.equal(new Set(slots.map((s) => s.start.getDate())).size, 5);
  assert.ok(slots.every((s) => s.start < at(6, 0)));
});

test('today: earliest slot today', () => {
  const now = at(1, 8);
  const slot = pickSlot(freeSlots(schedule, now), 'Orthopaedics', 'today', now);
  assert.equal(slot.start.getTime(), at(1, 9, 15).getTime());
  assert.equal(slot.priority, false);
});

test('today with nothing left today: first slot tomorrow morning, flagged priority', () => {
  const now = at(1, 16);
  const slot = pickSlot(freeSlots(schedule, now), 'Orthopaedics', 'today', now);
  assert.equal(slot.start.getTime(), at(2, 9, 30).getTime());
  assert.equal(slot.priority, true);
});

test('this_week: earliest in the window', () => {
  const now = at(1, 16);
  const slot = pickSlot(freeSlots(schedule, now), 'ENT', 'this_week', now);
  assert.equal(slot.start.getTime(), at(2, 9).getTime());
});

test('routine: earliest from 2 days after today', () => {
  const now = at(1, 8);
  const slot = pickSlot(freeSlots(schedule, now), 'ENT', 'routine', now);
  assert.equal(slot.start.getTime(), at(3, 9).getTime());
});

test('no slots in the department → null', () => {
  const now = at(1, 8);
  assert.equal(pickSlot(freeSlots(schedule, now), 'Dental', 'today', now), null);
});

test('different time: next 3 slots in the department after the current one', () => {
  const now = at(1, 8);
  const next = nextSlots(freeSlots(schedule, now), 'Orthopaedics', at(1, 9, 15), 3);
  assert.deepEqual(next.map((s) => s.start.getTime()), [at(1, 9, 30), at(1, 9, 45), at(1, 14)].map((d) => d.getTime()));
});

// ---- Intake ---------------------------------------------------------------------------

test('instruction fits the 2048-character cap', () => assert.ok(INTAKE_FITS));

test('parses the short form into the documented shape', () => {
  const intake = parseIntake('{"n":"Ravi","a":34,"s":["knee pain"],"b":"right knee","d":"1 week","o":"slowly","w":["quite bad"],"dep":"Ortho","u":"week","sum":"Knee pain for a week."}');
  assert.deepEqual(intake, {
    name: 'Ravi', age: 34, symptoms: ['knee pain'], body_part: 'right knee', duration: '1 week', onset: 'gradual',
    severity_words: ['quite bad'], department: 'Orthopaedics', urgency: 'this_week', summary_en: 'Knee pain for a week.',
  });
});

test('cleans the quirks seen in testing', () => {
  const intake = parseIntake('{"n":"I","a":null,"s":"itchy,red patches","b":"unknown","dep":"Derm","u":"routine","sum":"x"}');
  assert.equal(intake.name, null);
  assert.deepEqual(intake.symptoms, ['itchy', 'red patches']);
  assert.equal(intake.body_part, null);
});

test('invalid or missing replies parse to null', () => {
  for (const raw of [null, '', 'not json', '{"s":["a"', '[1,2]']) assert.equal(parseIntake(raw), null);
});

test('follow-up question only when department or symptoms are missing', () => {
  const full = parseIntake('{"s":["toothache"],"dep":"Dental","u":"week","sum":"x"}');
  assert.equal(followUpQuestion(full), null);
  assert.match(followUpQuestion({ ...full, department: null }), /which part of your body/i);
  assert.match(followUpQuestion({ ...full, symptoms: [] }), /symptoms/i);
});

test('merge fills gaps and keeps the more urgent tier', () => {
  const first = parseIntake('{"n":"Ravi","s":["pain"],"u":"routine","sum":"Pain."}');
  const answer = parseIntake('{"s":["knee pain"],"b":"knee","d":"1 week","dep":"Ortho","u":"week","sum":"Knee pain for a week."}');
  const merged = mergeIntake(first, answer);
  assert.equal(merged.name, 'Ravi');
  assert.equal(merged.department, 'Orthopaedics');
  assert.equal(merged.urgency, 'this_week');
  assert.deepEqual(merged.symptoms, ['pain', 'knee pain']);
  assert.equal(merged.summary_en, 'Pain. Knee pain for a week.');
});

test('rejects sentences and pronouns as names', () => {
  for (const n of ['My tooth hurts.', 'I', 'my knee', 'Patient']) assert.equal(parseIntake(`{"n":"${n}","s":["x"]}`).name, null);
  assert.equal(parseIntake('{"n":"Ravi Kumar","s":["x"]}').name, 'Ravi Kumar');
});

// CareLine conversation rules: what to ask next and the short-answer parsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDetails, nextStep, absorbIntake, finalUrgency, parseYesNo, parseAge, parseSeverity,
  parsePhone, parseName, parseDuration, parseTimePreference, spokenPhone, firstNumber,
} from '../shared/careline-conversation.js';
import { freeSlots, nextOffer } from '../shared/careline-booking.js';

test('asks in order and skips what is known', () => {
  const d = emptyDetails();
  assert.equal(nextStep(d).field, 'problem');
  const known = { ...d, symptoms: ['knee pain'], department: 'Orthopaedics', duration: '1 week' };
  assert.equal(nextStep(known).field, 'severity');
  const all = { ...known, severity: 6, name: 'Ravi', age: 34, phone: '9845012345' };
  assert.equal(nextStep(all), null);
});

test('body part is asked only when the department is unknown', () => {
  const d = { ...emptyDetails(), symptoms: ['pain'] };
  assert.equal(nextStep(d).field, 'body_part');
  assert.equal(nextStep({ ...d, department: 'Dental' }).field, 'duration');
});

test('a detail is asked at most twice', () => {
  const d = { ...emptyDetails(), symptoms: ['x'], department: 'ENT', duration: '1 day', severity: 3 };
  assert.equal(nextStep(d, { name: 1 }).field, 'name');
  assert.equal(nextStep(d, { name: 2 }).field, 'age');
});

test('absorbIntake fills gaps and keeps known values', () => {
  const d = { ...emptyDetails(), name: 'Ravi', urgency: 'routine' };
  const out = absorbIntake(d, { name: 'Other', symptoms: ['cough'], body_part: null, duration: '2 days', onset: null, severity_words: [], age: null, department: 'ENT', urgency: 'this_week', summary_en: 'Cough.' });
  assert.equal(out.name, 'Ravi');
  assert.deepEqual(out.symptoms, ['cough']);
  assert.equal(out.urgency, 'this_week');
});

test('severity raises urgency, never lowers it', () => {
  assert.equal(finalUrgency({ urgency: 'routine', severity: 9 }), 'today');
  assert.equal(finalUrgency({ urgency: 'routine', severity: 5 }), 'this_week');
  assert.equal(finalUrgency({ urgency: 'routine', severity: 2, worsening: true }), 'this_week');
  assert.equal(finalUrgency({ urgency: 'today', severity: 1 }), 'today');
  assert.equal(finalUrgency({ urgency: 'routine', severity: 2 }), 'routine');
});

test('yes / no', () => {
  for (const s of ['Yes', 'yes please', 'Okay, book it', "That's right", 'haan']) assert.equal(parseYesNo(s), true, s);
  for (const s of ['No', 'No thanks', "That's wrong", 'Something different', "I don't need one"]) assert.equal(parseYesNo(s), false, s);
  assert.equal(parseYesNo('my knee hurts'), null);
});

test('numbers in words and digits', () => {
  assert.equal(firstNumber('thirty four'), 34);
  assert.equal(firstNumber('I am 67 years old'), 67);
  assert.equal(firstNumber('one hundred and two'), 102);
  assert.equal(parseAge('She is seven.'), 7);
  assert.equal(parseAge('none'), null);
});

test('severity and worsening', () => {
  assert.deepEqual(parseSeverity('About a seven, and getting worse'), { severity: 7, worsening: true });
  assert.deepEqual(parseSeverity('3, it is the same'), { severity: 3, worsening: false });
  assert.deepEqual(parseSeverity('pretty bad'), { severity: null, worsening: null });
});

test('phone numbers from digits and words', () => {
  assert.equal(parsePhone('98450 12345'), '9845012345');
  assert.equal(parsePhone('+91 98450-12345'), '9845012345');
  assert.equal(parsePhone('09845012345'), '9845012345');
  assert.equal(parsePhone('nine eight four five oh one two three four five'), '9845012345');
  assert.equal(parsePhone('nine eight double four five zero one two three four'), '9844501234');
  assert.equal(parsePhone('12345'), null);
  assert.equal(parsePhone('1234567890'), null);  // Indian mobiles start 6-9
  assert.equal(spokenPhone('9845012345'), '9 8 4 5 0, 1 2 3 4 5');
});

test('names', () => {
  assert.equal(parseName('My name is Ravi Kumar.'), 'Ravi Kumar');
  assert.equal(parseName('ravi'), 'Ravi');
  assert.equal(parseName("I'm Priya"), 'Priya');
  assert.equal(parseName('Yes'), null);
  assert.equal(parseName('I have been having pain for a long time'), null);
});

test('duration fallback', () => {
  assert.equal(parseDuration('for about 3 days'), '3 days');
  assert.equal(parseDuration('two weeks now'), 'two weeks');
  assert.equal(parseDuration('since yesterday'), 'since yesterday');
  assert.equal(parseDuration('a while'), null);
});

test('time preferences', () => {
  assert.deepEqual(parseTimePreference('Anything in the evening?'), { part: 'evening' });
  assert.deepEqual(parseTimePreference('Monday morning please'), { part: 'morning', weekday: 1 });
  assert.deepEqual(parseTimePreference('tomorrow'), { day: 'tomorrow' });
});

// ---- Offers with preferences -----------------------------------------------------------
const schedule = {
  slot_minutes: 15, days: 5,
  doctors: [
    { id: 'a', name: 'Dr A', department: 'ENT', hours: ['09:00', '10:00'], taken: {} },
    { id: 'b', name: 'Dr B', department: 'ENT', hours: ['16:00', '17:00'], taken: {} },
  ],
};
const at = (day, hh, mm = 0) => new Date(2026, 9, day, hh, mm);

test('next offer without preference is the next slot', () => {
  const now = at(1, 8);
  assert.equal(nextOffer(freeSlots(schedule, now), 'ENT', at(1, 9), {}, now).start.getTime(), at(1, 9, 15).getTime());
});

test('next offer honours evening and tomorrow', () => {
  const now = at(1, 8);
  const slots = freeSlots(schedule, now);
  assert.equal(nextOffer(slots, 'ENT', at(1, 9), { part: 'evening' }, now).start.getTime(), at(1, 16).getTime());
  assert.equal(nextOffer(slots, 'ENT', at(1, 9), { day: 'tomorrow' }, now).start.getTime(), at(2, 9).getTime());
  assert.equal(nextOffer(slots, 'ENT', at(1, 9), { day: 'tomorrow', part: 'evening' }, now).start.getTime(), at(2, 16).getTime());
});

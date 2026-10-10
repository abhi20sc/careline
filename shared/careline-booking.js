// CareLine booking rules. Pure functions over the mock schedule; no DOM, no storage.
//
// schedule.json stores taken slots by day offset (0 = today), so "the next 5 days" is
// always relative to when the page is opened. Slots booked through the app are passed
// in separately as absolute times.

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date, plusDays = 0) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + plusDays);
  return d;
}

function atTime(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

const slotKey = (doctorId, start) => `${doctorId}@${new Date(start).toISOString()}`;

/**
 * Every free slot from `now` onwards, sorted by start time.
 * `booked` is a list of {doctorId, start} already taken through the app.
 * Returns [{doctorId, doctor, department, start: Date}].
 */
export function freeSlots(schedule, now, booked = []) {
  const takenByApp = new Set(booked.map((b) => slotKey(b.doctorId, b.start)));
  const step = schedule.slot_minutes * 60 * 1000;
  const slots = [];
  for (let offset = 0; offset < schedule.days; offset++) {
    const day = startOfDay(now, offset);
    for (const doc of schedule.doctors) {
      const takenToday = new Set(doc.taken[offset] ?? []);
      const end = atTime(day, doc.hours[1]);
      for (let t = atTime(day, doc.hours[0]); t < end; t = new Date(t.getTime() + step)) {
        const hhmm = t.toTimeString().slice(0, 5);
        if (t <= now || takenToday.has(hhmm) || takenByApp.has(slotKey(doc.id, t))) continue;
        slots.push({ doctorId: doc.id, doctor: doc.name, department: doc.department, start: t });
      }
    }
  }
  return slots.sort((a, b) => a.start - b.start);
}

/**
 * The slot to offer for an urgency, or null when nothing fits.
 *   today     → earliest slot today; else the first slot tomorrow morning, flagged priority
 *   this_week → earliest slot in the 5-day window
 *   routine   → earliest slot from 2 days after today
 * Returns {doctorId, doctor, department, start, priority}.
 */
export function pickSlot(slots, department, urgency, now) {
  const inDept = slots.filter((s) => s.department === department);
  const tomorrow = startOfDay(now, 1);

  if (urgency === 'today') {
    const today = inDept.find((s) => s.start < tomorrow);
    if (today) return { ...today, priority: false };
    const tomorrowMorning = inDept.find((s) => s.start < new Date(tomorrow.getTime() + DAY_MS) && s.start.getHours() < 12);
    const fallback = tomorrowMorning ?? inDept[0];
    return fallback ? { ...fallback, priority: true } : null;
  }
  if (urgency === 'routine') {
    const from = startOfDay(now, 2);
    const slot = inDept.find((s) => s.start >= from);
    return slot ? { ...slot, priority: false } : null;
  }
  return inDept[0] ? { ...inDept[0], priority: false } : null;
}

/** The next `count` slots in a department after `after` (for "different time"). */
export function nextSlots(slots, department, after, count = 3) {
  return slots
    .filter((s) => s.department === department && s.start > new Date(after))
    .slice(0, count)
    .map((s) => ({ ...s, priority: false }));
}

const PARTS = {
  morning: (h) => h < 12,
  afternoon: (h) => h >= 12 && h < 16,
  evening: (h) => h >= 16,
};

/**
 * The next slot to offer after the patient turned one down. `after` is the slot they
 * declined; `pref` comes from parseTimePreference ("evening", "tomorrow", "Monday").
 * A preference searches the whole window, so "Monday" can go earlier than `after`.
 * Returns a slot (priority false) or null.
 */
export function nextOffer(slots, department, after, pref = {}, now = new Date()) {
  const inDept = slots.filter((s) => s.department === department);
  const hasPref = pref.part || pref.day || pref.weekday != null;
  if (!hasPref) return nextSlots(slots, department, after, 1)[0] ?? null;
  const today = startOfDay(now).getTime();
  const match = inDept.find((s) => {
    const day = startOfDay(s.start).getTime();
    if (pref.part && !PARTS[pref.part](s.start.getHours())) return false;
    if (pref.day === 'today' && day !== today) return false;
    if (pref.day === 'tomorrow' && day !== startOfDay(now, 1).getTime()) return false;
    if (pref.weekday != null && s.start.getDay() !== pref.weekday) return false;
    if (pref.later && s.start <= new Date(after)) return false;
    return new Date(s.start).getTime() !== new Date(after).getTime();
  });
  return match ? { ...match, priority: false } : null;
}

// ---- Wording, shared by the card and the spoken confirmation ------------------------

export const formatWhen = (start) =>
  new Date(start).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

export const formatShort = (start) =>
  new Date(start).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function confirmationText(booking) {
  const when = formatWhen(booking.start).replace(' at ', ', at ');
  return `You are booked with ${booking.doctor}, ${booking.department}, on ${when}.`
    + (booking.priority ? ' This is a priority slot.' : '');
}

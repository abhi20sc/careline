import { toWav, MAX_MS, MIN_MS } from '/shared/wav.js';
import { INTAKE_INSTRUCTION, INTAKE_CHARS, INTAKE_FITS, DEPARTMENT_NAMES, URGENCIES, parseIntake } from '/shared/careline-intake.js';
import { findRedFlags } from '/shared/careline-redflags.js';
import { freeSlots, pickSlot, nextOffer, formatWhen, formatShort } from '/shared/careline-booking.js';
import {
  emptyDetails, nextStep, absorbIntake, finalUrgency, parseYesNo, parseAge, parseSeverity,
  parsePhone, parseName, parseDuration, parseTimePreference, spokenPhone, displayPhone,
} from '/shared/careline-conversation.js';

const FALLBACK_DEPARTMENT = 'General Medicine';
const URGENCY_LABEL = { today: 'Today', this_week: 'This week', routine: 'Routine' };
// Details the model reads from free speech. For the others ("Ravi", "34", a phone
// number) code parses the answer and the model's guess is ignored.
const SPOKEN_FIELDS = new Set(['problem', 'body_part', 'duration', 'severity']);

const $ = (id) => document.getElementById(id);
const el = {
  transcript: $('transcript'), dock: $('dock'), mic: $('mic'), state: $('state'),
  handsFree: $('hands-free'), card: $('card'), cardCount: $('card-count'), fields: $('fields'), slot: $('slot'),
  cardActions: $('card-actions'), emergency: $('emergency'), staffRows: $('staff-rows'), staffCount: $('staff-count'),
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const firstName = (d) => (d.name ? `, ${d.name.split(' ')[0]}` : '');

// ---- Records (localStorage can throw or come back empty, e.g. in a private window) ------------
//
// One record per call:
//   {id, time, details, transcript: [{who, text}], red_flags, urgency, booking,
//    override: {department, urgency}, status, ambulance, routed_by_default}
// status: 'in_progress' | 'booked' | 'no_slot' | 'emergency'

const STORE_KEY = 'careline.records.v2';

function loadRecords() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRecords() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(records));
  } catch { /* storage unavailable: the call still works, it just isn't kept */ }
  renderStaff();
}

let records = loadRecords();
const recordById = (id) => records.find((r) => r.id === id);
const departmentOf = (r) => r.override?.department || r.details.department || FALLBACK_DEPARTMENT;
const urgencyOf = (r) => r.override?.urgency || r.urgency || finalUrgency(r.details);

// ---- Schedule ------------------------------------------------------------------------------------

let schedule = null;
const scheduleReady = fetch('schedule.json').then((r) => r.json()).then((s) => { schedule = s; }).catch(() => {});

function slotsFor(record) {
  const others = records.filter((r) => r.id !== record.id && r.booking).map((r) => r.booking);
  return schedule ? freeSlots(schedule, new Date(), others) : [];
}

const toBooking = (slot) => slot && {
  doctorId: slot.doctorId, doctor: slot.doctor, department: slot.department,
  start: new Date(slot.start).toISOString(), priority: !!slot.priority,
};

// ---- Dock state ----------------------------------------------------------------------------------

const STATES = {
  idle: ['Ready when you are', 'Press Start call to begin.'],
  turn: ['Your turn', 'Tap the mic, or hold Space while you talk.'],
  speaking: ['CareLine is speaking', 'Tap the mic to interrupt.'],
  listening: ['Listening… go ahead', 'Pause when you have finished.'],
  holding: ['Listening… go ahead', 'Let go of Space when you have finished.'],
  thinking: ['One moment…', 'Writing that down.'],
  paused: ['Tap the mic to answer', 'I stopped listening because it went quiet.'],
  ended: ['Call ended', 'Tap the mic to start a new call.'],
};

function setDock(state, custom) {
  el.dock.dataset.state = state === 'holding' ? 'listening' : state;
  const [title, hint] = custom ?? STATES[state];
  el.state.innerHTML = `<b>${esc(title)}${state === 'speaking' ? '<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}</b><span>${esc(hint)}</span>`;
  el.mic.setAttribute('aria-label', state === 'listening' ? 'Stop listening' : 'Talk');
}

const restingState = () => (!call ? 'idle' : call.ended ? 'ended' : 'turn');

// ---- Speech out ----------------------------------------------------------------------------------

let speakToken = 0;

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'en-IN') || voices.find((v) => v.lang === 'en-GB') || voices.find((v) => v.lang.startsWith('en'));
}

// Helpline numbers are read digit by digit ("one zero eight", not "one hundred and eight").
const forSpeech = (text) => text.replace(/\b108\b/g, '1 0 8').replace(/\b14416\b/g, '1 4 4 1 6');

/** Speak, then (hands-free) open the mic. Resolves when speech ends or is interrupted. */
function speak(text, { listen = true } = {}) {
  text = forSpeech(text);
  const token = ++speakToken;
  setDock('speaking');
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      resolve();
      if (token !== speakToken) return;  // interrupted: whoever interrupted owns the dock
      if (listen && el.handsFree.checked && call && !call.ended) startListening({ mode: 'auto' });
      else setDock(restingState());
    };
    // Chrome sometimes never fires onend; fall back on a generous estimate of the duration.
    const fallback = setTimeout(finish, 1500 + text.split(/\s+/).length * 450);
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-IN';
      u.rate = 0.98;
      const voice = pickVoice();
      if (voice) u.voice = voice;
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
    } catch {
      finish();
    }
  });
}

function stopSpeaking() {
  speakToken++;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
}

// ---- Listening -------------------------------------------------------------------------------------
//
// mode 'auto': opened by hands-free after CareLine speaks; stops ~1.2 s after the patient
//              stops talking, or is dropped unsent if nobody speaks for 8 s.
// mode 'tap':  opened by tapping the mic; same silence rule, or tap again to stop.
// mode 'hold': Space held; stops on release.

const VAD = { minSpeechMs: 300, endSilenceMs: 1200, noSpeechMs: 8000 };

let stream, recorder, chunks = [], startedAt = 0, audioCtx, rafId, busy = false;
let listen = null;  // {mode, heardSpeech, discard, released, userStopped}

async function ensureMic() {
  if (stream?.active) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return stream;
}

async function startListening({ mode }) {
  if (busy || !INTAKE_FITS || recorder?.state === 'recording') return;
  stopSpeaking();
  const mine = { mode, heardSpeech: false, discard: false, released: false, userStopped: false };
  listen = mine;
  try {
    const src = await ensureMic();
    if (listen !== mine || mine.released || mine.discard) return;  // let go while the mic was starting
    chunks = [];
    recorder = new MediaRecorder(src);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => handleStop(mine);
    recorder.start();
    startedAt = performance.now();
    setDock(mode === 'hold' ? 'holding' : 'listening');
    watchLevel(src, mine);
  } catch (err) {
    setDock('turn', ['Microphone unavailable', `${err.message}. You can still tap the answers on screen.`]);
  }
}

function stopListening({ discard = false } = {}) {
  if (listen) {
    listen.released = true;
    if (discard) listen.discard = true;
  }
  cancelAnimationFrame(rafId);
  el.mic.style.setProperty('--level', 0);
  if (recorder?.state === 'recording') recorder.stop();
}

function watchLevel(src, mine) {
  audioCtx = audioCtx || new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(src).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let floor = 0, samples = 0, loudSince = 0, quietSince = performance.now();

  const loop = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    el.mic.style.setProperty('--level', Math.min(1, rms * 12).toFixed(3));

    const now = performance.now();
    const elapsed = now - startedAt;
    if (elapsed < 250) { floor += rms; samples++; }  // calibrate on the first quarter-second
    const threshold = Math.max(0.012, (samples ? floor / samples : 0) * 2.5);
    if (rms > threshold) {
      loudSince ||= now;
      quietSince = now;
      if (now - loudSince > VAD.minSpeechMs) mine.heardSpeech = true;
    } else {
      loudSince = 0;
    }

    if (elapsed > MAX_MS - 5_000) return stopListening();  // stay under the API's 120 s cap
    if (mine.mode !== 'hold') {
      if (mine.heardSpeech && now - quietSince > VAD.endSilenceMs) return stopListening();
      if (!mine.heardSpeech && elapsed > VAD.noSpeechMs) {
        stopListening({ discard: true });
        return setDock('paused');
      }
    }
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

async function handleStop(mine) {
  if (mine.discard) return;
  if (performance.now() - startedAt < MIN_MS + 200) return setDock('turn', ['Too short', 'Hold a little longer, or tap the mic and speak.']);
  // A quiet room that never crossed the speech threshold: don't pay to transcribe silence.
  if (mine.mode !== 'hold' && !mine.heardSpeech && !mine.userStopped) return setDock('paused');

  busy = true;
  setDock('thinking');
  try {
    const wav = await toWav(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }));
    const config = { llm_instruction: INTAKE_INSTRUCTION };
    // The question just asked is the best context for hearing a short answer ("Ravi", "34").
    if (call?.lastPrompt) config.stt_prompt = call.lastPrompt;
    const form = new FormData();
    // No language_codes: auto-detect handles Hindi and English, and pinning one hurts the other.
    form.append('config', JSON.stringify(config));
    form.append('audio', wav, 'audio.wav');
    const res = await fetch('/api/transcribe', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    busy = false;
    await onUtterance(data);
  } catch (err) {
    busy = false;
    addNote(`That didn't go through: ${err.message}`);
    setDock('paused', ["That didn't go through", 'Tap the mic to try again.']);
  }
}

// ---- The call -------------------------------------------------------------------------------------
//
// steps: 'ambulance' → 'collect' (one detail at a time) → 'confirm_phone' → 'offer' → 'done'
//        any step → 'emergency' when a red flag matches

let call = null;

function newCall() {
  stopSpeaking();
  stopListening({ discard: true });
  const record = {
    id: crypto.randomUUID(), time: new Date().toISOString(), details: emptyDetails(), transcript: [],
    red_flags: [], urgency: null, booking: null, override: {}, status: 'in_progress', ambulance: null,
  };
  records.push(record);
  call = { record, step: 'ambulance', asked: {}, field: null, offer: null, pendingPhone: null, ended: false, lastPrompt: null, ambulanceAsks: 0 };
  el.transcript.innerHTML = '';
  el.cardActions.hidden = true;
  el.emergency.hidden = true;
  renderCard();
  saveRecords();
}

async function startCall() {
  await scheduleReady;
  newCall();
  say('Hello, this is CareLine. I can book a free hospital appointment for you. First, do you need an ambulance right now?',
    { choices: [['No', 'no'], ['Yes, I need an ambulance', 'yes']] });
}

/** CareLine says something: on screen, aloud, and in the record. */
function say(text, { choices = null, listen = true, speech = text } = {}) {
  call.lastPrompt = text;
  call.record.transcript.push({ who: 'careline', text });
  el.transcript.querySelectorAll('.choices').forEach((c) => c.remove());  // only the latest question takes taps
  const line = document.createElement('div');
  line.className = 'line cl';
  line.innerHTML = `<span class="who">CareLine</span>${esc(text)}`;
  if (choices) {
    const row = document.createElement('div');
    row.className = 'choices';
    row.innerHTML = choices.map(([label, value]) => `<button class="btn" data-say="${esc(value)}">${esc(label)}</button>`).join('');
    line.append(row);
  }
  el.transcript.append(line);
  scrollDown();
  saveRecords();
  return speak(speech, { listen });
}

function addPatientLine(text, data, flagged) {
  const line = document.createElement('div');
  line.className = `line me${flagged ? ' flagged' : ''}`;
  const meta = data ? `You said · request ${Math.round(data.request_time_ms)} ms` : 'You tapped';
  line.innerHTML = `${esc(text)}<span class="meta num">${meta}</span>`;
  el.transcript.append(line);
  scrollDown();
}

function addNote(text) {
  const line = document.createElement('div');
  line.className = 'line note';
  line.textContent = text;
  el.transcript.append(line);
  scrollDown();
}

const scrollDown = () => { el.transcript.scrollTop = el.transcript.scrollHeight; };

/** A transcribed reply from the patient. */
async function onUtterance(data) {
  const said = (data.text || '').trim();
  if (!call || call.ended) {
    if (said) addNote(`Heard “${said}”. Start a new call to book again.`);
    return setDock(restingState());
  }
  if (!said) return say("Sorry, I didn't catch that. Could you say it again?");
  // llm_response can be null (llm_error: "timeout" | "error" | "truncated") or not JSON.
  return handleReply(said, parseIntake(data.llm_response), data);
}

/** Safety first, then whatever this step needs. Taps on the answer buttons come here too. */
async function handleReply(said, intake, data = null, shown = said) {
  const record = call.record;
  record.transcript.push({ who: 'patient', text: shown });

  // Red flags run on the verbatim words and the model's output before anything else.
  const flags = call.step === 'emergency' ? [] : findRedFlags(said, intake ?? data?.llm_response);
  addPatientLine(shown, data, flags.length > 0);
  if (flags.length) {
    // Keep what they said ("chest pain") on the record so staff see why it was flagged.
    if (intake) update(absorbIntake(record.details, intake));
    return startEmergency(flags);
  }

  switch (call.step) {
    case 'emergency': return onAmbulanceAnswer(parseYesNo(said));
    case 'ambulance': return onAmbulance(said, intake);
    case 'collect': return onDetail(said, intake);
    case 'confirm_phone': return onConfirmPhone(said);
    case 'offer': return onOffer(said);
    default: return undefined;
  }
}

function update(details) {
  const before = call.record.details;
  call.record.details = details;
  saveRecords();
  renderCard({ before });
}

async function onAmbulance(said, intake) {
  const yn = parseYesNo(said);
  const described = intake?.symptoms.length > 0;
  if (yn === true && !described) return startEmergency([], { ambulance: 'requested' });
  if (yn === false || described) {
    call.step = 'collect';
    if (described) {
      update(absorbIntake(call.record.details, intake));
      call.asked.problem = 1;
    }
    return askNext(described ? 'Thank you.' : 'Okay.');
  }
  if (++call.ambulanceAsks < 2) return say('Sorry, do you need an ambulance right now? Please say yes or no.', { choices: [['No', 'no'], ['Yes', 'yes']] });
  call.step = 'collect';
  return askNext('Okay, I will take that as a no.');
}

/** Store what the reply told us. Code parses the detail we just asked about. */
async function onDetail(said, intake) {
  const field = call.field;
  let d = SPOKEN_FIELDS.has(field) ? absorbIntake(call.record.details, intake) : { ...call.record.details };
  if (field === 'problem' && !d.symptoms.length && !intake) d.symptoms = [said];  // model failed: keep their words
  if (field === 'duration' && !d.duration) d.duration = parseDuration(said);
  if (field === 'severity') {
    const { severity, worsening } = parseSeverity(said);
    d.severity = severity;
    d.worsening = worsening;
  }
  if (field === 'name') d.name = parseName(said);
  if (field === 'age') d.age = parseAge(said);
  update(d);

  if (field === 'phone') {
    const phone = parsePhone(said);
    if (phone) {
      call.pendingPhone = phone;
      call.step = 'confirm_phone';
      return say(`I have ${displayPhone(phone)}. Is that right?`, { speech: `I have ${spokenPhone(phone)}. Is that right?`, choices: [['Yes', 'yes'], ['No', 'no']] });
    }
  }
  if (field === 'name' && d.name) return askNext(`Thank you${firstName(d)}.`);
  return askNext();
}

async function onConfirmPhone(said) {
  const other = parsePhone(said);
  if (other && other !== call.pendingPhone) {
    call.pendingPhone = other;
    return say(`Let me check: ${displayPhone(other)}. Is that right?`, { speech: `Let me check: ${spokenPhone(other)}. Is that right?`, choices: [['Yes', 'yes'], ['No', 'no']] });
  }
  const yn = parseYesNo(said);
  call.step = 'collect';
  if (yn === true || other === call.pendingPhone) {
    update({ ...call.record.details, phone: call.pendingPhone });
    return askNext('Thank you.');
  }
  call.pendingPhone = null;
  return askNext('Sorry about that.');
}

/** Ask for the next missing detail, or offer a slot once we have what we need. */
function askNext(prefix = '') {
  const step = nextStep(call.record.details, call.asked);
  if (!step) return offerFirstSlot();
  const tries = call.asked[step.field] ?? 0;
  call.asked[step.field] = tries + 1;
  call.field = step.field;
  call.step = 'collect';
  return say(`${prefix} ${tries ? step.retry : step.question}`.trim());
}

function offerFirstSlot() {
  const record = call.record;
  if (!record.details.department) record.routed_by_default = true;
  record.urgency = finalUrgency(record.details);
  return offer(pickSlot(slotsFor(record), departmentOf(record), urgencyOf(record), new Date()));
}

function offer(slot, lead = '') {
  const record = call.record;
  if (!slot) {
    record.status = 'no_slot';
    saveRecords();
    endCall();
    renderCard();
    return say(`I'm sorry, there are no ${departmentOf(record)} appointments free in the next 5 days. Our staff will call you to arrange one.`, { listen: false });
  }
  call.offer = slot;
  call.step = 'offer';
  renderCard();
  const priority = slot.priority ? ' I have marked it as priority.' : '';
  return say(`${lead || `Thank you${firstName(record.details)}.`} I can book you with ${slot.doctor} in ${slot.department} on ${formatWhen(slot.start)}.${priority} The appointment is free. Shall I book it?`,
    { choices: [['Yes, book it', 'yes'], ['Another time', 'another time']] });
}

async function onOffer(said) {
  const yn = parseYesNo(said);
  const pref = parseTimePreference(said);
  const wantsOther = yn === false || Object.keys(pref).length > 0 || /\b(another|different|other|else|later|earlier|next)\b/i.test(said);
  if (yn === true && !wantsOther) return book();
  if (wantsOther) {
    const next = nextOffer(slotsFor(call.record), call.offer.department, call.offer.start, pref, new Date());
    if (!next) {
      return say(`Sorry, I have nothing like that in the next 5 days. Shall I book ${formatWhen(call.offer.start)} instead?`,
        { choices: [['Yes, book it', 'yes'], ['Another time', 'another time']] });
    }
    return offer(next, 'How about this one.');
  }
  return say('Shall I book that time? Say yes, or ask for another time, for example "something in the evening".',
    { choices: [['Yes, book it', 'yes'], ['Another time', 'another time']] });
}

function book() {
  const record = call.record;
  record.booking = toBooking(call.offer);
  record.status = 'booked';
  call.offer = null;
  saveRecords();
  endCall();
  renderCard({ stamp: true });
  return say(`Done${firstName(record.details)}. You are booked with ${record.booking.doctor}, ${record.booking.department}, on ${formatWhen(record.booking.start)}. Please arrive 15 minutes early and bring any previous reports. Take care.`, { listen: false });
}

function endCall() {
  call.ended = true;
  call.step = 'done';
  el.cardActions.hidden = false;
}

// ---- Emergency ------------------------------------------------------------------------------------

function startEmergency(flags, { ambulance = null } = {}) {
  const record = call.record;
  record.red_flags = flags.length ? flags : [{ id: 'ambulance', label: 'Ambulance requested' }];
  record.status = 'emergency';
  record.booking = null;
  record.ambulance = ambulance;
  call.offer = null;
  call.step = 'emergency';
  if (ambulance) endCall();
  saveRecords();
  renderCard();

  const suicidal = flags.some((f) => f.id === 'suicidal');
  $('em-reason').textContent = flags.length ? `You mentioned: ${flags.map((f) => f.label.toLowerCase()).join('; ')}.` : 'You asked for an ambulance.';
  $('em-manas').hidden = !suicidal;
  $('em-manas-call').hidden = !suicidal;
  $('em-ask').hidden = !!ambulance;
  showAfter(ambulance ? 'Call 108 now and ask for an ambulance. Our staff have also been alerted.' : null);
  el.emergency.hidden = false;
  (ambulance ? $('em-close') : el.emergency.querySelector('[data-amb="yes"]')).focus();

  const manas = suicidal ? ' You can also call Tele-MANAS on 14416, free, any time.' : '';
  if (ambulance) return say(`Please call 108 now for an ambulance. Our staff have been alerted.${manas}`, { listen: false });
  return say(`Please call 108 or go to the nearest emergency department now.${manas} Do you need an ambulance?`);
}

function showAfter(text) {
  $('em-after').hidden = !text;
  $('em-after').textContent = text ?? '';
}

function onAmbulanceAnswer(yn) {
  if (yn == null) return say('Do you need an ambulance? Please say yes or no.');
  call.record.ambulance = yn ? 'requested' : 'declined';
  saveRecords();
  endCall();
  $('em-ask').hidden = true;
  showAfter(yn
    ? 'Call 108 now and ask for an ambulance. Our staff have also been alerted.'
    : 'Please go to the nearest emergency department now. Call 108 if things get worse.');
  $('em-close').focus();
  return say(yn
    ? 'Please call 108 now and ask for an ambulance. Our staff have also been alerted.'
    : 'Please go to the nearest emergency department now, and call 108 if things get worse.', { listen: false });
}

el.emergency.addEventListener('click', (e) => {
  const amb = e.target.closest('[data-amb]')?.dataset.amb;
  if (!amb || call?.step !== 'emergency' || call.ended) return;
  stopListening({ discard: true });
  handleReply(amb, null, null, amb === 'yes' ? 'Yes' : 'No');
});

$('em-close').addEventListener('click', () => {
  stopSpeaking();
  stopListening({ discard: true });
  el.emergency.hidden = true;
  setDock(restingState());
});

// ---- The card ---------------------------------------------------------------------------------------

function fieldValues(r, details = r.details) {
  const d = details;
  const urgency = r.override?.urgency || r.urgency || (d.urgency ? finalUrgency(d) : null);
  return {
    problem: d.symptoms.join(', '),
    body_part: d.body_part ?? '',
    duration: d.duration ?? '',
    severity: d.severity != null ? `${d.severity} / 10` : '',
    worsening: d.worsening == null ? '' : d.worsening ? 'Yes' : 'No',
    name: d.name ?? '',
    age: d.age != null ? String(d.age) : '',
    phone: d.phone ? displayPhone(d.phone) : '',
    department: d.department ?? (r.routed_by_default ? `${FALLBACK_DEPARTMENT} (staff will check)` : ''),
    urgency: urgency ? URGENCY_LABEL[urgency] : '',
  };
}

/** Fill the card. A value that just changed stays lit until the next reply. */
function renderCard({ before = null, stamp = false } = {}) {
  const record = call?.record;
  const values = record ? fieldValues(record) : {};
  const old = before && record ? fieldValues(record, before) : null;
  let filled = 0;
  for (const row of el.fields.children) {
    const value = values[row.dataset.f] ?? '';
    const dd = row.querySelector('dd');
    if (value) filled++;
    if (dd.textContent !== value) dd.textContent = value;
    row.classList.toggle('fresh', !!(old && value && old[row.dataset.f] !== value));
  }
  // Folded on a phone, the card's one line shows the booking once there is one.
  const folded = matchMedia('(max-width: 900px)').matches;
  el.cardCount.firstChild.textContent = folded && record?.booking ? `Booked ${formatShort(record.booking.start)} `
    : folded && record?.status === 'emergency' ? 'Emergency ' : `${filled} of ${el.fields.children.length} `;

  const s = el.slot;
  s.className = 'slot';
  if (record?.status === 'emergency') {
    s.classList.add('alarm');
    s.innerHTML = `<h2>Not booked</h2><p class="when">Emergency: call 108</p><p class="who">${esc(record.red_flags.map((f) => f.label).join(', '))}</p>`;
  } else if (record?.booking) {
    s.classList.add('booked');
    s.innerHTML = `<h2>Appointment</h2><p class="when num">${esc(formatShort(record.booking.start))}</p><p class="who">${esc(record.booking.doctor)} · ${esc(record.booking.department)}</p>
      <div class="stamp${stamp ? ' land' : ''}" role="img" aria-label="Booked, free">BOOKED<small>FREE</small></div>`;
  } else if (call?.offer) {
    s.classList.add('offered');
    s.innerHTML = `<h2>Offered</h2><p class="when num">${esc(formatShort(call.offer.start))}</p><p class="who">${esc(call.offer.doctor)} · ${esc(call.offer.department)}${call.offer.priority ? ' · priority' : ''}</p>`;
  } else if (record?.status === 'no_slot') {
    s.innerHTML = '<h2>Appointment</h2><p class="empty">No slot free in the next 5 days. Staff will call you.</p>';
  } else {
    s.innerHTML = '<h2>Appointment</h2><p class="empty">Filled in once you agree to a time.</p>';
  }
}

// ---- Staff dashboard ----------------------------------------------------------------------------------

const select = (name, value, choices, labels = {}) => `
  <select data-field="${name}" aria-label="${name === 'department' ? 'Department' : 'Urgency'}">
    ${choices.map((c) => `<option value="${esc(c)}"${c === value ? ' selected' : ''}>${esc(labels[c] ?? c)}</option>`).join('')}
  </select>`;

function renderStaff() {
  const rows = [...records].reverse().filter((r) => r.transcript?.some((t) => t.who === 'patient'));
  const emergencies = rows.filter((r) => r.status === 'emergency').length;
  el.staffCount.textContent = rows.length
    ? `${rows.length} call${rows.length === 1 ? '' : 's'} · ${emergencies} emergenc${emergencies === 1 ? 'y' : 'ies'} · stored in this browser`
    : 'No calls yet.';
  el.staffRows.innerHTML = rows.length ? rows.map((r) => {
    const d = r.details;
    const alarm = r.status === 'emergency';
    const time = new Date(r.time).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const patient = [d.name, d.age != null ? `${d.age} yrs` : null].filter(Boolean).join(', ') || 'Not given';
    const said = r.transcript.filter((t) => t.who === 'patient').map((t) => t.text).join(' / ');
    const facts = [d.symptoms.join(', '), d.duration, d.severity != null ? `${d.severity}/10${d.worsening ? ', worse' : ''}` : null].filter(Boolean).join(' · ');
    const slot = r.booking
      ? `<span class="num">${esc(formatShort(r.booking.start))}</span><span class="sub">${esc(r.booking.doctor)}${r.booking.priority ? ' · priority' : ''}</span>`
      : `<span class="tag wait">${{ emergency: 'Not booked', no_slot: 'No slot: call back', in_progress: 'In progress' }[r.status] ?? 'Ended'}</span>`;
    const staffNote = (f) => (r.override?.[f] ? '<span class="sub">staff override</span>' : '');
    const ambulance = r.ambulance === 'requested' ? '<span class="sub"><b>Ambulance requested</b></span>' : r.ambulance === 'declined' ? '<span class="sub">No ambulance</span>' : '';
    return `
      <tr data-id="${esc(r.id)}" class="${alarm ? 'alarm' : ''}">
        <td class="nowrap num">${esc(time)}</td>
        <td>${esc(patient)}${d.phone ? `<span class="sub num">${esc(displayPhone(d.phone))}</span>` : ''}</td>
        <td>${esc(d.summary_en || facts || '—')}${facts && d.summary_en ? `<span class="sub">${esc(facts)}</span>` : ''}<details class="said"><summary>What they said</summary>“${esc(said)}”</details></td>
        <td>${select('department', departmentOf(r), DEPARTMENT_NAMES)}${staffNote('department')}${r.routed_by_default && !r.override?.department ? '<span class="sub">default, please check</span>' : ''}</td>
        <td>${alarm ? '<span class="tag alarm">Emergency</span>' : select('urgency', urgencyOf(r), URGENCIES, URGENCY_LABEL) + staffNote('urgency')}</td>
        <td>${alarm ? `<span class="tag alarm">EMERGENCY</span><span class="sub">${esc(r.red_flags.map((f) => f.label).join(', '))}</span>${ambulance}` : 'No'}</td>
        <td class="nowrap">${slot}</td>
      </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="7">Calls appear here as patients talk to CareLine.</td></tr>';
}

// A staff override changes the record and, for a bookable call, finds a new slot.
el.staffRows.addEventListener('change', (e) => {
  const field = e.target.dataset.field;
  const record = recordById(e.target.closest('tr')?.dataset.id);
  if (!field || !record) return;
  record.override = { ...record.override, [field]: e.target.value };
  if (record.status === 'booked' || record.status === 'no_slot') {
    const slot = pickSlot(slotsFor(record), departmentOf(record), urgencyOf(record), new Date());
    record.booking = toBooking(slot);
    record.status = slot ? 'booked' : 'no_slot';
  }
  saveRecords();
});

$('clear').addEventListener('click', () => {
  if (!confirm('Delete every call stored in this browser?')) return;
  records = call ? [call.record] : [];
  saveRecords();
});

// The call screen in another tab wrote new records.
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY) return;
  records = loadRecords();
  if (call) call.record = recordById(call.record.id) ?? call.record;
  renderStaff();
});

// ---- Views: careline.html#staff opens the dashboard ------------------------------------------------------

function showView() {
  const staff = location.hash === '#staff';
  $('call-view').hidden = staff;
  $('staff-view').hidden = !staff;
  $('tab-call').setAttribute('aria-current', staff ? 'false' : 'page');
  $('tab-staff').setAttribute('aria-current', staff ? 'page' : 'false');
  if (staff) renderStaff();
}
window.addEventListener('hashchange', showView);
showView();

// The card sits open beside the call on wide screens and folds above it on phones.
const narrow = matchMedia('(max-width: 900px)');
const fitCard = () => { el.card.open = !narrow.matches; };
narrow.addEventListener('change', fitCard);
fitCard();
el.card.querySelector('summary').addEventListener('click', (e) => { if (!narrow.matches) e.preventDefault(); });

// ---- Controls ----------------------------------------------------------------------------------------------

if (!INTAKE_FITS) {
  el.mic.disabled = true;
  $('start-call').disabled = true;
  setDock('idle', ['Setup problem', `Instruction is ${INTAKE_CHARS} / 2048 characters.`]);
}

$('start-call').addEventListener('click', startCall);
$('new-call').addEventListener('click', startCall);

// Tap the mic: start a call, interrupt CareLine and listen, or stop listening early.
el.mic.addEventListener('click', () => {
  if (busy) return;
  if (recorder?.state === 'recording') {
    if (listen) listen.userStopped = true;
    return stopListening();
  }
  if (!call || call.ended) return startCall();
  startListening({ mode: 'tap' });
});

// Answer buttons count as the patient's reply (and still pass the red-flag check).
el.transcript.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-say]');
  if (!btn || !call || call.ended || busy) return;
  stopSpeaking();
  stopListening({ discard: true });
  btn.parentElement.remove();
  handleReply(btn.dataset.say, null, null, btn.textContent.trim());
});

// Hold Space to talk, with or without hands-free.
const typing = (t) => /INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test(t.tagName ?? '');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.emergency.hidden) return $('em-close').click();
  if (e.code !== 'Space' || e.repeat || typing(e.target) || location.hash === '#staff') return;
  e.preventDefault();
  if (!call || call.ended || busy) return;
  if (recorder?.state === 'recording') stopListening({ discard: true });  // replace a hands-free listen
  startListening({ mode: 'hold' });
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || typing(e.target) || listen?.mode !== 'hold') return;
  e.preventDefault();
  stopListening();
});

el.handsFree.addEventListener('change', () => {
  if (!el.handsFree.checked && listen?.mode === 'auto' && recorder?.state === 'recording') {
    stopListening({ discard: true });
    setDock(restingState());
  }
});

setDock('idle');
renderCard();

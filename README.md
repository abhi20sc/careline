# CareLine

A voice appointment line for a hospital outpatient desk. The patient says what's wrong out loud; CareLine asks
a few short questions, fills in an appointment card, routes them to one of 12 departments at the right urgency,
and books a free slot once they say yes. It never diagnoses or gives medical advice.

**Emergency checks are code, not AI.** Fixed rules read every reply before anything else. If a caller
mentions chest pain, a stroke sign or suicidal thoughts, CareLine stops, shows "call 108" and never books.

Built at the [London Voice AI Meetup: Build your own voice app](https://luma.com/k74g72a0), an AssemblyAI ×
Encode Club build night in London on 1 October 2026, on AssemblyAI's
[Dictation API](https://www.assemblyai.com/docs/dictation).

**[Try it live](https://careline-6mbj.onrender.com)** (Chrome, with a microphone. The first load can take up to a
minute while the free server wakes up.)

![CareLine demo](docs/demo.gif)

[Watch the full demo video (28 s, with sound)](docs/demo.mp4)

## How a call goes

```text
"Do you need an ambulance?" → problem → body part → how long → how bad (1-10) / getting worse?
  → name → age → phone (read back to check) → offers one free slot → "yes" books it

On every reply, before anything else:
  red-flag rules run on the caller's exact words AND on the model's JSON
  → any match shows the 108 screen, asks about an ambulance, and never books
```

Staff open `#staff` (the Staff tab) to see every call, spot emergencies, and correct the
department or urgency.

## How it works

Each patient reply is one request to AssemblyAI's Dictation API. That single request returns the verbatim
transcript and an LLM rewrite, so there is no second model call:

- **`llm_instruction`** turns free speech ("my right knee's been hurting for about a week") into compact JSON:
  symptoms, body part, department, urgency.
- **`stt_prompt`** carries the question CareLine just asked, which helps the transcription of short answers.

Short answers such as a name, an age or a phone number are parsed in plain code
([`shared/careline-conversation.js`](shared/careline-conversation.js)), not by the model. "Something in the
evening" or "Monday" picks a different slot.

### Design decisions

- **Safety rules live in code.** [`shared/careline-redflags.js`](shared/careline-redflags.js) holds 14
  categories of emergency (chest pain, breathing, stroke signs, seizures, heavy bleeding, suicidal thoughts,
  poisoning and more) in English and Hindi, in both Latin and Devanagari script. I measured why this matters: a
  clip about "ending my life" came back from the model with urgency `routine`. The rules are deliberately
  over-inclusive ("no chest pain" still matches), because a false alarm costs a phone call and a missed one can
  cost a life. Suicidal thoughts also show the Tele-MANAS helpline, 14416.
- **Compact JSON, because the rewrite's output is capped.** A keyed JSON shape full of nulls came back
  `llm_error: "truncated"` on a 69-character transcript. So the model returns short keys and leaves out anything
  not said, and `parseIntake()` in [`shared/careline-intake.js`](shared/careline-intake.js) expands it. The
  instruction is checked against the API's 2,048-character limit before every request.
- **Urgency decides the slot.** [`shared/careline-booking.js`](shared/careline-booking.js): `today` gets the
  earliest slot today (or first thing tomorrow, flagged as priority), `this_week` the earliest in the next
  5 days, and `routine` the earliest from 2 days out.
- **Confirm before committing.** The phone number and the slot are read back, and nothing is booked without a
  clear yes.
- **The API key never reaches the browser.** [`server.js`](server.js) is a small Express proxy that adds the
  key and forwards the audio.

## Deploy your own

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/abhi20sc/careline)

[`render.yaml`](render.yaml) sets everything up on Render's free plan; it asks for your AssemblyAI key during
setup. The server caps use so a public link can't run up your bill: 40 replies per visitor per hour and 500
per day in total (a full call is about 10). Change them with `DEMO_IP_LIMIT` and `DEMO_DAILY_LIMIT`.

## Run it

You need Node 20 or newer and an [AssemblyAI API key](https://www.assemblyai.com/dashboard/api-keys).

```bash
npm install
cp .env.example .env    # then paste your key into .env
npm start               # http://localhost:3000
```

Open it in Chrome, press **Start call** and allow the microphone. CareLine speaks, then listens until you pause.
Add `#staff` to the address to see the staff dashboard.

```bash
npm test                # 90 tests: red flags, booking rules, intake and answer parsing
```

## Layout

```text
server.js                  Express proxy: holds the key, forwards audio, applies demo limits
render.yaml                one-click Render deploy
public/
  careline.html/.js/.css   caller screen and staff dashboard
  schedule.json            mock schedule: 28 doctors, 15-minute slots over the next 5 days
shared/
  careline-redflags.js     emergency rules (English and Hindi)
  careline-intake.js       the intake instruction and its JSON parser
  careline-conversation.js question order and parsers for names, ages, phone numbers, times
  careline-booking.js      urgency rules and slot picking
  wav.js                   browser recording → 16 kHz mono WAV
test/                      node:test suite
docs/                      demo video
```

## Limitations

This is a prototype, not a medical device.

- The hospital, doctors and schedule are made up. Bookings are saved only in your browser (`localStorage`).
- It runs in a web browser, not on a phone line.
- It has been tested in English and Hindi only.
- The red-flag list is a keyword list. It catches far more than it misses, but it is not a clinical triage
  tool.

## Credits

The speech plumbing (the proxy and WAV encoding) started from AssemblyAI's
[Dictation-HelloWorld](https://github.com/hsingh-aai/Dictation-HelloWorld) starter. Font:
[Atkinson Hyperlegible Next](https://www.brailleinstitute.org/freefont/).

## Licence

[MIT](LICENSE)

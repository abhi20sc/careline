// Limits on `llm_instruction` (the intake instruction sent with every reply).
//
// The cap is 2048 CHARACTERS (codepoints, not bytes — measured 2026-09-22: 2048 'é'
// is 4096 bytes and passes; 2049 'é' is rejected). The API rejects the WHOLE request
// when exceeded, so an over-long instruction doesn't degrade the rewrite, it makes
// every dictation fail with a 400 before any audio is read. Never send without
// checking `fits`.
export const MAX_CHARS = 2048;

/** Codepoint count — what the API actually measures. */
export const charLength = (s) => [...s].length;

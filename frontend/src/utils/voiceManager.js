// voiceManager.js
//
// Shared "hands-free" voice engine for FinBud-AI's chat surfaces
// (Dashboard Chat page + the Advisor popup). Wraps:
//   - STT: browser-native SpeechRecognition (webkitSpeechRecognition)
//   - TTS: browser-native speechSynthesis
// and stitches them into a listen -> transcript -> (caller sends to
// backend) -> speak -> listen loop, so a user can have a fully
// hands-free conversation once voice mode is turned on.
//
// This intentionally only depends on Web APIs (no network calls of its
// own) so it stays free/instant and works with FinBud's existing
// /api/chat/message pipeline unchanged — callers just feed the
// transcript into whatever they already use to talk to the backend,
// and call speak()/speakAndListen() with the AI's reply.
//
// Usage (see Chat.jsx / AdvisorChatBubble.jsx):
//   const vm = new FinBudVoiceManager({
//     onTranscript: (text) => sendMessage(text),
//     onStateChange: (state) => setVoiceState(state),
//   })
//   vm.start()                 // turns hands-free mode on + starts listening
//   vm.speakAndListen(reply)   // called once the AI response comes back
//   vm.stop()                  // turns hands-free mode off entirely

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null

export const VOICE_STATES = {
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
}

export function isVoiceSupported() {
  return !!SpeechRecognitionImpl && typeof window !== 'undefined' && !!window.speechSynthesis
}

// Urdu-script Unicode range (covers Urdu/Arabic-script text regardless of
// whether it's actually Arabic vs Urdu - good enough for a language-toggle
// heuristic in this app, since FinBud only ever produces Urdu-script replies
// in that range).
const URDU_SCRIPT_RE = /[\u0600-\u06FF]/

// Common Roman-Urdu words/particles that essentially never appear in plain
// English sentences - used to catch Roman-Urdu replies (e.g. "Aap ka
// balance RS 5,000 hai") that are written in Latin script but should still
// be read aloud with an Urdu voice rather than an English one.
const ROMAN_URDU_WORD_RE = /\b(hai|hain|kya|kaise|karo|karein|kardo|kar\s*do|bhejo|bhej|bhejna|paisa|paise|paisay|rupay|rupaye|rupaya|aap|apka|apki|shukriya|mera|meri|mere|nahi|nahin|krna|kro|karna|bilkul|theek|acha|zaroor|maloom|batao)\b/i

/**
 * Picks the right speech-synthesis language tag for a given reply so Urdu
 * (script or Roman-Urdu) is never read aloud with an English voice.
 * Returns a BCP-47 tag: 'ur-PK' for Urdu, otherwise 'en-US'.
 */
export function detectSpeechLang(text) {
  if (!text) return 'en-US'
  if (URDU_SCRIPT_RE.test(text)) return 'ur-PK'
  if (ROMAN_URDU_WORD_RE.test(text)) return 'ur-PK'
  return 'en-US'
}

/**
 * Best-effort lookup of an installed voice matching `lang` (e.g. 'ur-PK').
 * Falls back through progressively looser matches (exact -> language-only
 * prefix -> null) since most browsers/OSes don't ship a dedicated Urdu
 * voice - when null is returned, `utterance.lang` alone is left to steer
 * the platform's default voice as closely as possible.
 */
function pickVoiceForLang(synth, lang) {
  if (!synth || !lang) return null
  let voices = []
  try { voices = synth.getVoices() || [] } catch { voices = [] }
  if (!voices.length) return null

  const exact = voices.find(v => v.lang?.toLowerCase() === lang.toLowerCase())
  if (exact) return exact

  const prefix = lang.split('-')[0].toLowerCase() // 'ur' from 'ur-PK'
  const byPrefix = voices.find(v => v.lang?.toLowerCase().startsWith(prefix))
  if (byPrefix) return byPrefix

  return null
}

export class FinBudVoiceManager {
  /**
   * @param {Object} opts
   * @param {(transcript: string) => void} opts.onTranscript - called with the
   *   recognized text once the user finishes speaking. The caller is
   *   responsible for sending it to FinBud's backend.
   * @param {(state: 'idle'|'listening'|'processing'|'speaking') => void} opts.onStateChange
   * @param {(error: string) => void} [opts.onError]
   * @param {string} [opts.lang] - BCP-47 language tag, defaults to 'en-US'.
   */
  constructor({ onTranscript, onStateChange, onError, lang = 'en-US' } = {}) {
    this.onTranscript = onTranscript || (() => {})
    this.onStateChange = onStateChange || (() => {})
    this.onError = onError || (() => {})
    this.lang = lang

    this.recognition = null
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null
    this.isVoiceModeActive = false
    this.state = VOICE_STATES.IDLE
    // Guards against onend firing after we've already been told to stop
    // (e.g. user taps the mic button off mid-utterance).
    this._stopRequested = false

    this._initRecognition()
  }

  _initRecognition() {
    if (!SpeechRecognitionImpl) {
      console.warn('[FinBudVoiceManager] Web Speech API not supported in this browser.')
      return
    }

    const recognition = new SpeechRecognitionImpl()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = this.lang

    recognition.onstart = () => this._setState(VOICE_STATES.LISTENING)

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim()
      if (transcript) {
        this._setState(VOICE_STATES.PROCESSING)
        this.onTranscript(transcript)
      }
    }

    recognition.onerror = (err) => {
      // "no-speech" / "aborted" happen routinely (silence, user toggling
      // off) — don't surface those as hard errors.
      if (err?.error && err.error !== 'no-speech' && err.error !== 'aborted') {
        this.onError(err.error)
      }
      if (this.isVoiceModeActive && err?.error === 'no-speech' && !this._stopRequested) {
        // Nothing heard — re-arm so the loop keeps listening.
        this._restart()
      } else {
        this._setState(VOICE_STATES.IDLE)
      }
    }

    recognition.onend = () => {
      // GUARANTEE: recognition ending always resolves the state machine
      // back to IDLE unless something else has already explicitly moved
      // it forward (PROCESSING, because onresult fired and handed off to
      // the caller; or SPEAKING, because TTS started). Previously this
      // only reset state when we were still LISTENING, which is exactly
      // right for the common case (silence / user stopped talking) - but
      // if recognition ends for any OTHER reason while still nominally
      // "LISTENING" from the state machine's point of view (browser quirks,
      // rapid stop/start, permission hiccups), leaving that check as the
      // only branch is what let the mic button get stuck spinning. This
      // is now the single source of truth: any state other than
      // PROCESSING/SPEAKING gets force-reset to IDLE on every onend.
      if (this.state !== VOICE_STATES.PROCESSING && this.state !== VOICE_STATES.SPEAKING) {
        this._setState(VOICE_STATES.IDLE)
      }
    }

    this.recognition = recognition
  }

  _restart() {
    if (!this.isVoiceModeActive) return
    try {
      this.recognition.start()
    } catch {
      // Recognition refused to (re)start (e.g. still tearing down the
      // previous session). Never leave the UI stuck mid-transition -
      // fall back to IDLE so the mic button reflects reality and a
      // subsequent manual tap can recover cleanly.
      this._setState(VOICE_STATES.IDLE)
    }
  }

  _setState(state) {
    this.state = state
    this.onStateChange(state)
  }

  /** Turns hands-free mode on and starts the first listen. */
  start() {
    if (!this.recognition) {
      this.onError('unsupported')
      return
    }
    this.isVoiceModeActive = true
    this._stopRequested = false
    this.startListening()
  }

  /** Turns hands-free mode off entirely and cancels any in-flight audio. */
  stop() {
    this._stopRequested = true
    this.isVoiceModeActive = false
    try { this.recognition?.stop() } catch { /* noop */ }
    try { this.synth?.cancel() } catch { /* noop */ }
    this._setState(VOICE_STATES.IDLE)
  }

  startListening() {
    if (!this.recognition || !this.isVoiceModeActive) return
    this._stopRequested = false
    try {
      this.recognition.start()
    } catch {
      // "already started" is genuinely fine (a session is already live,
      // which is the state we wanted anyway) - but if `state` had already
      // been set to something transitional before this call, and the
      // browser then never fires onstart/onend for this attempt, we'd
      // hang there indefinitely. Reconcile immediately: recognition is
      // either already listening (leave LISTENING/whatever onstart set)
      // or genuinely failed to start, in which case IDLE is the only
      // safe resting state.
      if (this.state !== VOICE_STATES.LISTENING) {
        this._setState(VOICE_STATES.IDLE)
      }
    }
  }

  stopListening() {
    try { this.recognition?.stop() } catch { /* noop */ }
  }

  /**
   * Speaks `text` aloud. If hands-free mode is active and `reArm` is true
   * (default), automatically starts listening again once speech finishes —
   * this is what makes the conversation "hands-free continuous" rather than
   * a single push-to-talk exchange.
   */
  speak(text, { reArm = true } = {}) {
    if (!this.synth || !text) {
      if (this.isVoiceModeActive && reArm) this.startListening()
      else this._setState(VOICE_STATES.IDLE)
      return
    }

    this.synth.cancel()
    const utterance = new SpeechSynthesisUtterance(text)

    // Dynamic language detection: an Urdu-script or Roman-Urdu reply must
    // be read with an Urdu voice, not the default English one - toggle
    // utterance.lang (and pick a matching installed voice when one
    // exists) based on the actual text being spoken, rather than always
    // using this.lang (which reflects the recognition language, not
    // necessarily the reply language).
    const speechLang = detectSpeechLang(text)
    utterance.lang = speechLang
    const matchedVoice = pickVoiceForLang(this.synth, speechLang)
    if (matchedVoice) utterance.voice = matchedVoice

    utterance.rate = 1.0
    utterance.pitch = 1.0

    this._setState(VOICE_STATES.SPEAKING)

    const finish = () => {
      if (this.isVoiceModeActive && reArm && !this._stopRequested) {
        this.startListening()
      } else {
        this._setState(VOICE_STATES.IDLE)
      }
    }

    utterance.onend = finish
    utterance.onerror = finish

    this.synth.speak(utterance)
  }

  /** Convenience alias matching the "speak, then re-listen" loop. */
  speakAndListen(text) {
    this.speak(text, { reArm: true })
  }
}
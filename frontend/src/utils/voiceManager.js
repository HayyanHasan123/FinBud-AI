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
 * Known male Urdu/Hindi-family voice names across common platforms —
 * extend this list as you test on real devices; voice names are NOT
 * standardized across browsers/OSes, so this needs empirical
 * verification per platform.
 */
const PREFERRED_MALE_VOICE_NAMES = [
  'Microsoft Asad', 'Microsoft Asad Online (Natural) - Urdu (Pakistan)',
  'Google اردو', 'Urdu Male', 'Hindi Male',
]

/**
 * Best-effort lookup of an installed voice matching `lang` (e.g. 'ur-PK').
 * Prefers a known male Urdu-family voice by name first, then falls back
 * through progressively looser matches (exact lang -> language-only
 * prefix -> null) since most browsers/OSes don't ship a dedicated Urdu
 * voice - when null is returned, `utterance.lang` alone is left to steer
 * the platform's default voice as closely as possible.
 *
 * NOTE: browser-native speechSynthesis voice availability, naming, and
 * gender are not standardized or guaranteed across browsers/devices —
 * this is a strict improvement over naive lang-matching, but cannot by
 * itself guarantee identical voice/gender on every platform. See
 * FinBudVoiceManager's cloud-TTS path for a fix that can.
 */
function pickVoiceForLang(synth, lang, cachedVoices = []) {
  if (!synth || !lang) return null
  let voices = []
  try { voices = synth.getVoices() || [] } catch { voices = [] }
  if (!voices.length) voices = cachedVoices
  if (!voices.length) return null

  const byPreferredName = voices.find(v =>
    PREFERRED_MALE_VOICE_NAMES.some(name => v.name?.toLowerCase().includes(name.toLowerCase()))
  )
  if (byPreferredName) return byPreferredName

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
   * @param {string} [opts.lang] - BCP-47 language tag, defaults to 'ur-PK'.
   */
  constructor({ onTranscript, onStateChange, onError, lang = 'ur-PK' } = {}) {
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
    // synth.getVoices() is notoriously async/empty-on-first-call in many
    // browsers — the real list only populates once the 'voiceschanged'
    // event fires. Cache the populated list here so the very first
    // utterance of a session doesn't silently miss an available voice
    // just because getVoices() returned [] on the first call.
    this._cachedVoices = []
    // Currently-playing cloud-TTS <audio> element (Urdu path only), so
    // stop() can halt it the same way it halts local speechSynthesis.
    this._currentAudio = null
    if (this.synth) {
      try { this._cachedVoices = this.synth.getVoices() || [] } catch { /* noop */ }
      if (typeof this.synth.addEventListener === 'function') {
        this.synth.addEventListener('voiceschanged', () => {
          try { this._cachedVoices = this.synth.getVoices() || [] } catch { /* noop */ }
        })
      }
    }

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
      if (!transcript) return

      // Mark PROCESSING immediately so the UI doesn't feel stuck while a
      // possible transliteration call is in flight.
      this._setState(VOICE_STATES.PROCESSING)

      if (URDU_SCRIPT_RE.test(transcript)) {
        // Browsers only return native-script transcripts for Urdu speech
        // recognition (no "ur-Latn-PK" locale exists anywhere) — convert
        // to Roman Urdu server-side before handing off, since the chat
        // NLP pipeline is built around Roman Urdu / English.
        this._transliterateAndSend(transcript)
      } else {
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

  /**
   * Sends an Urdu-script transcript to the backend transliteration
   * endpoint and hands the Roman-Urdu result to onTranscript. Falls back
   * to the raw Urdu-script transcript (rather than blocking the turn) if
   * the call fails or times out — this failure mode is logged, not
   * surfaced to the user as a hard error.
   */
  async _transliterateAndSend(urduTranscript) {
    try {
      const res = await fetch('/api/voice/transliterate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: urduTranscript }),
      })
      if (!res.ok) throw new Error(`transliterate HTTP ${res.status}`)
      const data = await res.json()
      if (data?.success && data?.text) {
        this.onTranscript(data.text)
      } else {
        throw new Error('transliterate response missing text')
      }
    } catch (err) {
      console.warn('[FinBudVoiceManager] Transliteration failed, falling back to raw transcript:', err)
      this.onTranscript(urduTranscript)
    }
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
    try {
      if (this._currentAudio) {
        this._currentAudio.pause()
        this._currentAudio = null
      }
    } catch { /* noop */ }
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
   *
   * For Urdu-script or Roman-Urdu replies, this tries the backend cloud
   * voice first (see /api/voice/synthesize) so every device — mobile or
   * laptop — hears the same real Urdu-accented voice, since most
   * browsers/OSes have no Urdu voice installed and would otherwise read
   * Urdu/Roman-Urdu text aloud in the default English voice. English
   * replies keep using the fast local browser voice unchanged.
   */
  speak(text, { reArm = true } = {}) {
    if (!text) {
      if (this.isVoiceModeActive && reArm) this.startListening()
      else this._setState(VOICE_STATES.IDLE)
      return
    }

    const finish = () => {
      if (this.isVoiceModeActive && reArm && !this._stopRequested) {
        this.startListening()
      } else {
        this._setState(VOICE_STATES.IDLE)
      }
    }

    const speechLang = detectSpeechLang(text)
    this._setState(VOICE_STATES.SPEAKING)

    if (speechLang === 'ur-PK') {
      this._speakUrdu(text, finish)
      return
    }

    this._speakLocal(text, speechLang, finish)
  }

  /**
   * Local browser speechSynthesis path — used for English, and as the
   * fallback for Urdu when the cloud voice is unavailable/fails.
   */
  _speakLocal(text, speechLang, finish) {
    if (!this.synth) {
      finish()
      return
    }

    this.synth.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = speechLang
    const matchedVoice = pickVoiceForLang(this.synth, speechLang, this._cachedVoices)
    if (matchedVoice) utterance.voice = matchedVoice
    utterance.rate = 1.0
    utterance.pitch = 1.0

    utterance.onend = finish
    utterance.onerror = finish

    this.synth.speak(utterance)
  }

  /**
   * Cloud-TTS path for Urdu/Roman-Urdu: fetches real Urdu-accented audio
   * from the backend and plays it through an <audio> element, so the
   * accent is consistent across every device instead of depending on
   * whatever (if any) Urdu voice happens to be installed locally.
   * Falls back to _speakLocal() on any failure so a flaky network never
   * silences a reply.
   */
  async _speakUrdu(text, finish) {
    // Stop any local speech that might still be running.
    try { this.synth?.cancel() } catch { /* noop */ }

    try {
      const res = await fetch('/api/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(`synthesize HTTP ${res.status}`)

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      this._currentAudio = audio

      const cleanup = () => {
        URL.revokeObjectURL(url)
        if (this._currentAudio === audio) this._currentAudio = null
        finish()
      }

      audio.onended = cleanup
      audio.onerror = cleanup
      await audio.play()
    } catch (err) {
      console.warn('[FinBudVoiceManager] Cloud Urdu voice failed, falling back to local voice:', err)
      this._speakLocal(text, 'ur-PK', finish)
    }
  }

  /** Convenience alias matching the "speak, then re-listen" loop. */
  speakAndListen(text) {
    this.speak(text, { reArm: true })
  }
}
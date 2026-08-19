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
      // If nothing else has moved us to PROCESSING/SPEAKING and voice mode
      // is still on, drop back to idle rather than leaving a stale
      // "listening" indicator on screen.
      if (this.state === VOICE_STATES.LISTENING) {
        this._setState(this.isVoiceModeActive ? VOICE_STATES.IDLE : VOICE_STATES.IDLE)
      }
    }

    this.recognition = recognition
  }

  _restart() {
    if (!this.isVoiceModeActive) return
    try {
      this.recognition.start()
    } catch {
      /* already started */
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
      /* recognition already running — ignore */
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
      return
    }

    this.synth.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = this.lang
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

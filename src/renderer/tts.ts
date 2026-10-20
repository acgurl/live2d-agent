import type { TtsVoice } from "../shared/protocol";
import type { Live2DStage } from "./live2d";
import { RendererError, clamp, errorMessage } from "./errors";

export interface TtsMouthTarget {
  stage: Live2DStage;
  ids: string[];
}

export interface TtsSpeakOptions {
  text: string;
  voiceName?: string | null;
  rate?: number;
  pitch?: number;
  /** When set, the model's LipSync parameters are driven while speaking. */
  mouth?: TtsMouthTarget | null;
}

interface ActiveSpeech {
  finish: (error?: unknown) => void;
  utterance: SpeechSynthesisUtterance;
}

function abortError(): Error {
  const error = new Error("Speech was cancelled.");
  error.name = "AbortError";
  return error;
}

function isChineseText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

const MOUTH_INTERVAL_MS = 40;

/**
 * Thin wrapper around window.speechSynthesis:
 * - maintains the voice list (voiceschanged + retries, because Electron/Chromium
 *   often loads voices asynchronously),
 * - speaks with a zh/en language match,
 * - approximes mouth movement while speaking by writing the model LipSync
 *   parameter IDs through the easy-live2d persistent override map.
 */
export class TtsController {
  private readonly synth: SpeechSynthesis | null;
  private voices: TtsVoice[] = [];
  private current: ActiveSpeech | null = null;
  private voiceRetryTimers: number[] = [];
  private mouthTimer: number | null = null;
  private mouthStage: Live2DStage | null = null;
  private mouthIds: string[] = [];

  onVoicesChanged: ((voices: TtsVoice[]) => void) | null = null;

  constructor() {
    this.synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
    this.handleVoicesChanged = this.handleVoicesChanged.bind(this);
    this.refreshVoices();
    if (this.synth) {
      this.synth.addEventListener("voiceschanged", this.handleVoicesChanged);
      // Chromium sometimes never fires voiceschanged for the first call.
      for (const delay of [100, 400, 1200]) {
        this.voiceRetryTimers.push(window.setTimeout(() => this.refreshVoices(), delay));
      }
    }
  }

  get available(): boolean {
    return this.synth !== null && typeof SpeechSynthesisUtterance !== "undefined";
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  get currentVoices(): TtsVoice[] {
    return this.voices.slice();
  }

  /**
   * Picks a voice the same way speak() does; exposed so the viewer can report
   * the resolved language/voice when needed.
   */
  resolveVoice(text: string, voiceName?: string | null): { name: string; lang: string } | null {
    const voice = this.pickVoice(voiceName, text);
    return voice ? { name: voice.name, lang: voice.lang } : null;
  }

  async speak(options: TtsSpeakOptions): Promise<void> {
    const synth = this.synth;
    if (!synth) {
      throw new RendererError("TTS_UNAVAILABLE", "Speech synthesis is not available in the Live2D window.");
    }
    const text = options.text.trim();
    if (text.length === 0) return;
    this.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice(options.voiceName, text);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = isChineseText(text) ? "zh-CN" : "en-US";
    }
    utterance.rate = clamp(options.rate ?? 1, 0.5, 2);
    utterance.pitch = clamp(options.pitch ?? 1, 0, 2);
    utterance.volume = 1;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let safety: number | null = null;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (safety !== null) {
          window.clearTimeout(safety);
          safety = null;
        }
        this.current = null;
        this.stopMouth();
        if (error) reject(error);
        else resolve();
      };
      this.current = { finish, utterance };
      utterance.onend = () => finish();
      utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
        const reason = event.error;
        if (reason === "canceled" || reason === "interrupted") {
          finish(abortError());
          return;
        }
        finish(new RendererError("TTS_UNAVAILABLE", "Speech synthesis failed: " + reason));
      };
      safety = window.setTimeout(() => finish(), Math.min(120_000, Math.max(10_000, text.length * 550)));
      try {
        synth.speak(utterance);
      } catch (error) {
        finish(new RendererError("TTS_UNAVAILABLE", "Speech synthesis could not start: " + errorMessage(error)));
        return;
      }
      if (options.mouth && options.mouth.ids.length > 0) {
        this.startMouth(options.mouth.stage, options.mouth.ids);
      }
    });
  }

  cancel(): void {
    const current = this.current;
    this.current = null;
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch {
        // ignore: cancel is best-effort
      }
    }
    this.stopMouth();
    current?.finish(abortError());
  }

  dispose(): void {
    this.cancel();
    for (const timer of this.voiceRetryTimers) window.clearTimeout(timer);
    this.voiceRetryTimers = [];
    if (this.synth) this.synth.removeEventListener("voiceschanged", this.handleVoicesChanged);
    this.onVoicesChanged = null;
  }

  private handleVoicesChanged(): void {
    this.refreshVoices();
  }

  private refreshVoices(): void {
    const synth = this.synth;
    if (!synth) return;
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = synth.getVoices();
    } catch {
      voices = [];
    }
    const next: TtsVoice[] = voices.map((voice) => ({ name: voice.name, lang: voice.lang, default: voice.default }));
    const before = JSON.stringify(this.voices);
    const after = JSON.stringify(next);
    if (before === after) return;
    this.voices = next;
    this.onVoicesChanged?.(this.currentVoices);
  }

  private pickVoice(name: string | null | undefined, text: string): SpeechSynthesisVoice | null {
    const synth = this.synth;
    if (!synth) return null;
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = synth.getVoices();
    } catch {
      voices = [];
    }
    if (voices.length === 0) return null;
    const requested = (name ?? "").trim().toLowerCase();
    if (requested.length > 0) {
      const exact = voices.find((voice) => voice.name.toLowerCase() === requested);
      if (exact) return exact;
      const partial = voices.find((voice) => voice.name.toLowerCase().includes(requested));
      if (partial) return partial;
      const uri = voices.find((voice) => voice.voiceURI.toLowerCase() === requested);
      if (uri) return uri;
      const byLang = voices.find((voice) => voice.lang.toLowerCase().startsWith(requested));
      if (byLang) return byLang;
    }
    const prefix = isChineseText(text) ? "zh" : "en";
    const matched = voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix) && voice.default)
      ?? voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix));
    return matched ?? voices.find((voice) => voice.default) ?? voices[0] ?? null;
  }

  private startMouth(stage: Live2DStage, ids: string[]): void {
    this.stopMouth();
    this.mouthStage = stage;
    this.mouthIds = ids.slice();
    const startedAt = performance.now();
    this.mouthTimer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const wave = (Math.sin(elapsed / 110) + Math.sin(elapsed / 53 + 1.7) + Math.sin(elapsed / 29 + 0.4)) / 3;
      const openness = clamp(0.45 + 0.55 * wave, 0.06, 1);
      for (const id of this.mouthIds) {
        const range = stage.getParameterRange(id);
        if (!range) continue;
        const value = range.min + (range.max - range.min) * openness;
        stage.setTransientParameter(id, value);
      }
    }, MOUTH_INTERVAL_MS);
  }

  private stopMouth(): void {
    if (this.mouthTimer !== null) {
      window.clearInterval(this.mouthTimer);
      this.mouthTimer = null;
    }
    const stage = this.mouthStage;
    if (stage) {
      for (const id of this.mouthIds) stage.clearParameterOverride(id);
    }
    this.mouthStage = null;
    this.mouthIds = [];
  }
}

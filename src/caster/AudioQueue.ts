// AudioQueue — priority-driven TTS playback for the Tier 1 caster.
//
// Why a queue: kills fire faster than speech plays. We don't want to drop calls,
// but we also don't want a low-priority "Round live." to drown out an ace. So:
//   - Lower-priority items wait in line.
//   - A higher-priority item PREEMPTS the current utterance and jumps the queue.
// The plan's framing: kill barks (Tier 1) are instant, color commentary (Tier 2,
// Phase 4) can defer — when LLM lines arrive they'll go in at priority 1 and
// fill the gaps.
//
// Speech: Web Speech API (window.speechSynthesis). Zero deps, no API key, works
// in every modern browser. The browser gates speech behind a user gesture, so
// callers MUST trigger `unlock()` from a click handler at least once.
//
// TODO(phase 4): swap in ElevenLabs for the LLM color-commentary lane (better
// voice for the demo). Tier 1 barks can stay on Web Speech — they need to be
// instant, and a network round-trip per bark defeats the point.

export interface QueuedSpeech {
  text: string;
  priority: 1 | 2 | 3;
  // Optional id so callers can dedupe (e.g. don't re-queue the same kill twice).
  dedupeKey?: string;
}

export interface AudioQueueOpts {
  // Voice rate (0.1 - 10), default 1.1 — slightly punchy, fits the caster role.
  rate?: number;
  // Voice pitch (0 - 2), default 1.0.
  pitch?: number;
  // Volume (0 - 1), default 1.0.
  volume?: number;
  // Preferred voice name substring (e.g. "Google US English"). First match wins.
  preferredVoice?: string;
}

export class AudioQueue {
  private queue: QueuedSpeech[] = [];
  private current: QueuedSpeech | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private unlocked = false;
  private voice: SpeechSynthesisVoice | null = null;
  private recentKeys = new Set<string>(); // sliding window for dedupe
  private opts: Required<Omit<AudioQueueOpts, "preferredVoice">> & { preferredVoice?: string };

  constructor(opts: AudioQueueOpts = {}) {
    this.opts = {
      rate: opts.rate ?? 1.1,
      pitch: opts.pitch ?? 1.0,
      volume: opts.volume ?? 1.0,
      preferredVoice: opts.preferredVoice,
    };
    // Voices load asynchronously in some browsers (Chrome). Hook the event so
    // we re-pick the voice once it's available.
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const pick = () => this.pickVoice();
      pick();
      window.speechSynthesis.onvoiceschanged = pick;
    }
  }

  // MUST be called from inside a user-gesture handler (button click, key press)
  // before the first enqueue. Plays a silent utterance to satisfy the browser's
  // autoplay policy, after which subsequent speech can fire any time.
  unlock(): void {
    if (this.unlocked) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0; // silent
    window.speechSynthesis.speak(u);
    this.unlocked = true;
  }

  // Enqueue a line. Higher priority preempts the currently-playing utterance
  // and jumps in front of any lower-priority queued items.
  enqueue(item: QueuedSpeech): void {
    // Dedupe: same kill event firing twice shouldn't be spoken twice.
    if (item.dedupeKey) {
      if (this.recentKeys.has(item.dedupeKey)) return;
      this.recentKeys.add(item.dedupeKey);
      // Trim the window so it doesn't grow forever.
      if (this.recentKeys.size > 128) {
        const first = this.recentKeys.values().next().value;
        if (first !== undefined) this.recentKeys.delete(first);
      }
    }

    // Preempt if the new item outranks what's playing.
    if (this.current && item.priority > this.current.priority) {
      // Push the current item back into the queue (at the front of its priority
      // bucket) so it isn't lost.
      this.queue.unshift(this.current);
      this.current = null;
      this.cancelCurrent();
    }

    // Insert into queue ordered by priority desc (stable for same priority).
    let insertAt = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < item.priority) {
        insertAt = i;
        break;
      }
    }
    this.queue.splice(insertAt, 0, item);

    this.pump();
  }

  // Drop everything pending + stop the current line. Used on stop/teardown.
  clear(): void {
    this.queue = [];
    this.current = null;
    this.cancelCurrent();
    this.recentKeys.clear();
  }

  // Diagnostic getter for the demo UI.
  get queueLength(): number {
    return this.queue.length;
  }

  // ---- internals ----

  private cancelCurrent(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    this.currentUtterance = null;
  }

  private pump(): void {
    if (this.current) return; // already playing
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.speak(next);
  }

  private speak(item: QueuedSpeech): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      // Headless / SSR — just clear the slot so the queue keeps draining.
      this.current = null;
      this.pump();
      return;
    }
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = this.opts.rate;
    u.pitch = this.opts.pitch;
    u.volume = this.opts.volume;
    if (this.voice) u.voice = this.voice;
    u.onend = () => {
      // Only advance if this is still the active utterance — preemption sets
      // currentUtterance to null, which we treat as "already advanced".
      if (this.currentUtterance === u) {
        this.current = null;
        this.currentUtterance = null;
        this.pump();
      }
    };
    u.onerror = () => {
      if (this.currentUtterance === u) {
        this.current = null;
        this.currentUtterance = null;
        this.pump();
      }
    };
    this.currentUtterance = u;
    window.speechSynthesis.speak(u);
  }

  private pickVoice(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return;

    // Try preferred substring first.
    if (this.opts.preferredVoice) {
      const match = voices.find((v) =>
        v.name.toLowerCase().includes(this.opts.preferredVoice!.toLowerCase())
      );
      if (match) {
        this.voice = match;
        return;
      }
    }
    // Prefer an English voice that sounds natural-ish. "Google" / "Samantha" /
    // "Alex" are the usual high-quality picks on Chrome / macOS.
    const ranked = voices
      .filter((v) => v.lang.startsWith("en"))
      .sort((a, b) => {
        const score = (v: SpeechSynthesisVoice) =>
          (v.name.includes("Google") ? 3 : 0) +
          (v.name.includes("Samantha") || v.name.includes("Alex") ? 2 : 0) +
          (v.lang === "en-US" ? 1 : 0);
        return score(b) - score(a);
      });
    this.voice = ranked[0] ?? voices[0];
  }
}

// Module-level singleton so the demo + game can share one queue. (The game side
// will instantiate its own if it needs separate tuning.)
let _shared: AudioQueue | null = null;
export function getSharedAudioQueue(): AudioQueue {
  if (!_shared) _shared = new AudioQueue();
  return _shared;
}

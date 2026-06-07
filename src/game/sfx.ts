// ─────────────────────────────────────────────────────────────────────────
// sfx.ts — tiny Web Audio sound engine for the game (no library).
//
// Each clip in /public/Sounds is fetched + decoded ONCE into an AudioBuffer;
// playSfx() then fires cheap, overlapping one-shots (so rapid gunshots stack).
// Browsers block audio until a user gesture, so initAudio() (called on the
// first click — the same click that locks the pointer) creates/ resumes the
// AudioContext and kicks off loading. Calls before buffers finish loading are
// simply dropped (no audio that frame), which is fine.
//
// HMR SAFETY: all mutable state lives on a globalThis singleton (`S` below).
// During dev, hot-updating this file (or a React-Refresh importer) can create a
// second module instance; without the singleton, input.ts could unlock/load one
// instance while combat.playSfx() reads another empty one — so sounds triggered
// after an edit would silently no-op. Sharing state on globalThis keeps every
// instance on the same AudioContext + buffers. No effect in the prod bundle.
//
// Hooks (see callers): playSfx("shot"|"rayblast") in Weapon.fire(),
// playSfx("reload") in Weapon.beginReload(), playSfx("hit") on a non-lethal hit
// and playSfx("scream") on a kill in combat.applyDamage(), setWalking() from the
// footstep driver in GameScene, and setEntityWalk() per bot in Bot.tsx.
// ─────────────────────────────────────────────────────────────────────────

const SOUND_URLS = {
  shot: "/Sounds/u_f09vejvoga-gun-shot-350315.mp3",
  rayblast: "/Sounds/flutie8211-ray-gun-blast-1-546936.mp3",
  reload: "/Sounds/dragon-studio-gun-reload-511309.mp3",
  walk: "/Sounds/u_3x9ga8wevj-walking-sound-effect-272246.mp3",
  hit: "/Sounds/hitmarker_2.mp3",
  scream: "/Sounds/VOXScrm_Wilhelm scream (ID 0477)_BigSoundBank.com.mp3",
} as const;

export type SfxName = keyof typeof SOUND_URLS;

// Per-clip volume, tuned to each FILE's real peak so the mix matches intent.
// (Measured peaks: scream 0.56, hit 1.14, shot 0.35.) The scream is boosted to
// clearly dominate on a kill; the hot hitmarker is pulled down so it doesn't
// drown it.
const VOLUME: Record<SfxName, number> = {
  shot: 0.6,
  rayblast: 0.6,
  reload: 0.6,
  walk: 0.4,
  hit: 0.35,
  scream: 1.6, // file peak is only ~0.56 → ~0.9 output, the loudest cue
};

// Cap how much of a clip plays (seconds). The pistol shot mp3 has a long tail —
// only the first ~0.7s is the crack, so we trim it (tune this to taste, 0–1s).
const MAX_S: Partial<Record<SfxName, number>> = {
  shot: 0.7,
};

// Crouched footsteps: half playbackRate slows the loop ~50% AND drops the pitch
// an octave (playbackRate couples speed + pitch in Web Audio).
const CROUCH_RATE = 0.5;

// ── Singleton mutable state (shared across HMR instances) ──────────────────
interface SfxState {
  ctx: AudioContext | null;
  master: GainNode | null;
  loading: boolean;
  buffers: Partial<Record<SfxName, AudioBuffer>>;
  walkSource: AudioBufferSourceNode | null;
  walkWanted: boolean;
  walkCrouched: boolean;
  entityWalk: Record<string, { src: AudioBufferSourceNode; gain: GainNode }>;
}
const S: SfxState = ((globalThis as unknown as { __moshSfx?: SfxState }).__moshSfx ??= {
  ctx: null,
  master: null,
  loading: false,
  buffers: {},
  walkSource: null,
  walkWanted: false,
  walkCrouched: false,
  entityWalk: {},
});

/** Create/resume the AudioContext on a user gesture and start loading clips.
 *  Idempotent — safe to call on every click. */
export function initAudio() {
  if (!S.ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    S.ctx = new AC();
    S.master = S.ctx.createGain();
    S.master.gain.value = 1;
    S.master.connect(S.ctx.destination);
    void loadAll();
  }
  if (S.ctx.state === "suspended") void S.ctx.resume();
}

async function loadAll() {
  if (S.loading || !S.ctx) return;
  S.loading = true;
  await Promise.all(
    (Object.keys(SOUND_URLS) as SfxName[]).map(async (name) => {
      try {
        const res = await fetch(encodeURI(SOUND_URLS[name]));
        const arr = await res.arrayBuffer();
        S.buffers[name] = await S.ctx!.decodeAudioData(arr);
      } catch (e) {
        console.warn(`[sfx] failed to load ${name}`, e); // non-fatal: clip just won't play
      }
    }),
  );
  if (S.walkWanted) startWalk(); // requested before the buffer was ready
}

/** Play a one-shot (overlapping). No-op until audio is unlocked + loaded. */
export function playSfx(name: SfxName, volume = 1) {
  // Dev diagnostic: log the death scream + any sound that can't play yet.
  if (import.meta.env.DEV && (name === "scream" || !S.ctx || !S.buffers[name])) {
    console.log(`[sfx] ${name} | ctx=${S.ctx?.state ?? "none"} buf=${!!S.buffers[name]}`);
  }
  if (!S.ctx || !S.master) return;
  const buf = S.buffers[name];
  if (!buf) return;
  const src = S.ctx.createBufferSource();
  src.buffer = buf;
  const g = S.ctx.createGain();
  const vol = volume * VOLUME[name];
  g.gain.value = vol;
  src.connect(g).connect(S.master);

  const dur = MAX_S[name];
  if (dur != null) {
    // Play only the first `dur` seconds, with a short fade so the cut-off
    // doesn't click.
    const now = S.ctx.currentTime;
    const rel = Math.min(0.04, dur * 0.25);
    g.gain.setValueAtTime(vol, now + dur - rel);
    g.gain.linearRampToValueAtTime(0, now + dur);
    src.start(0, 0, dur);
  } else {
    src.start();
  }
}

function startWalk() {
  if (!S.ctx || !S.master || S.walkSource) return;
  const buf = S.buffers.walk;
  if (!buf) return;
  const src = S.ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = S.walkCrouched ? CROUCH_RATE : 1;
  const g = S.ctx.createGain();
  g.gain.value = VOLUME.walk;
  src.connect(g).connect(S.master);
  src.start();
  S.walkSource = src;
}

function stopWalk() {
  if (!S.walkSource) return;
  try {
    S.walkSource.stop();
  } catch {
    // already stopped
  }
  S.walkSource.disconnect();
  S.walkSource = null;
}

/** Loop the footstep clip while `on`; stop it when `off`. When `crouched`, the
 *  loop plays ~50% slower + pitched down. Idempotent; both args update live. */
export function setWalking(on: boolean, crouched = false) {
  if (crouched !== S.walkCrouched) {
    S.walkCrouched = crouched;
    if (S.walkSource) S.walkSource.playbackRate.value = crouched ? CROUCH_RATE : 1;
  }
  if (on === S.walkWanted) return;
  S.walkWanted = on;
  if (on) startWalk();
  else stopWalk();
}

// ── Per-entity (bot) footsteps, distance-attenuated by the caller ──────────
// Each bot gets its own looping footstep voice whose gain the caller updates
// every frame (a 0..1 factor that falls off linearly with distance). Desynced
// by a random start offset so a "bunch of bots" doesn't stomp in lockstep.

/** Loop entity `id`'s footsteps at `volume` (0..1, already distance-scaled), or
 *  stop them when `on` is false. Gain updates live on each call. */
export function setEntityWalk(id: string, on: boolean, volume: number) {
  if (!S.ctx || !S.master) return;
  const cur = S.entityWalk[id];
  if (on) {
    if (cur) {
      cur.gain.gain.value = volume * VOLUME.walk;
      return;
    }
    const buf = S.buffers.walk;
    if (!buf) return;
    const src = S.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = S.ctx.createGain();
    g.gain.value = volume * VOLUME.walk;
    src.connect(g).connect(S.master);
    src.start(0, Math.random() * buf.duration); // desync from other bots
    S.entityWalk[id] = { src, gain: g };
  } else if (cur) {
    try {
      cur.src.stop();
    } catch {
      // already stopped
    }
    cur.src.disconnect();
    delete S.entityWalk[id];
  }
}

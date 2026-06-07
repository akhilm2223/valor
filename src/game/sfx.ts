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
// Hooks (see callers): playSfx("shot"|"rayblast") in Weapon.fire(),
// playSfx("reload") in Weapon.beginReload(), playSfx("scream") in
// combat.applyDamage() on a kill, and setWalking() from the footstep driver in
// GameScene (loops the walk clip while the player is moving on the ground).
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

// Per-clip baseline volume so nothing blows out the mix. The death scream is set
// deliberately the LOUDEST so it cuts over the shot/hitmarker on a kill.
const VOLUME: Record<SfxName, number> = {
  shot: 0.55,
  rayblast: 0.6,
  reload: 0.6,
  walk: 0.4,
  hit: 0.55,
  scream: 1.0,
};

// Cap how much of a clip plays (seconds). The pistol shot mp3 has a long tail —
// only the first ~0.7s is the crack, so we trim it (tune this to taste, 0–1s).
// Clips not listed play in full.
const MAX_S: Partial<Record<SfxName, number>> = {
  shot: 0.7,
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let loading = false;
const buffers: Partial<Record<SfxName, AudioBuffer>> = {};

// Looping walk state.
let walkSource: AudioBufferSourceNode | null = null;
let walkWanted = false;
let walkCrouched = false;
// Crouched footsteps: half playbackRate slows the loop ~50% AND drops the pitch
// an octave (playbackRate couples speed + pitch in Web Audio) — exactly the
// "slower and pitched down" feel.
const CROUCH_RATE = 0.5;

/** Create/resume the AudioContext on a user gesture and start loading clips.
 *  Idempotent — safe to call on every click. */
export function initAudio() {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    void loadAll();
  }
  if (ctx.state === "suspended") void ctx.resume();
}

async function loadAll() {
  if (loading || !ctx) return;
  loading = true;
  await Promise.all(
    (Object.keys(SOUND_URLS) as SfxName[]).map(async (name) => {
      try {
        const res = await fetch(encodeURI(SOUND_URLS[name]));
        const arr = await res.arrayBuffer();
        buffers[name] = await ctx!.decodeAudioData(arr);
      } catch (e) {
        console.warn(`[sfx] failed to load ${name}`, e); // non-fatal: clip just won't play
      }
    }),
  );
  if (walkWanted) startWalk(); // requested before the buffer was ready
}

/** Play a one-shot (overlapping). No-op until audio is unlocked + loaded. */
export function playSfx(name: SfxName, volume = 1) {
  if (!ctx || !master) return;
  const buf = buffers[name];
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  const vol = volume * VOLUME[name];
  g.gain.value = vol;
  src.connect(g).connect(master);

  const dur = MAX_S[name];
  if (dur != null) {
    // Play only the first `dur` seconds, with a short fade so the cut-off
    // doesn't click.
    const now = ctx.currentTime;
    const rel = Math.min(0.04, dur * 0.25);
    g.gain.setValueAtTime(vol, now + dur - rel);
    g.gain.linearRampToValueAtTime(0, now + dur);
    src.start(0, 0, dur);
  } else {
    src.start();
  }
}

function startWalk() {
  if (!ctx || !master || walkSource) return;
  const buf = buffers.walk;
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = walkCrouched ? CROUCH_RATE : 1;
  const g = ctx.createGain();
  g.gain.value = VOLUME.walk;
  src.connect(g).connect(master);
  src.start();
  walkSource = src;
}

function stopWalk() {
  if (!walkSource) return;
  try {
    walkSource.stop();
  } catch {
    // already stopped
  }
  walkSource.disconnect();
  walkSource = null;
}

/** Loop the footstep clip while `on`; stop it when `off`. When `crouched`, the
 *  loop plays ~50% slower + pitched down. Idempotent; both args update live. */
export function setWalking(on: boolean, crouched = false) {
  // Live-update crouch speed/pitch on the running loop.
  if (crouched !== walkCrouched) {
    walkCrouched = crouched;
    if (walkSource) walkSource.playbackRate.value = crouched ? CROUCH_RATE : 1;
  }
  if (on === walkWanted) return;
  walkWanted = on;
  if (on) startWalk();
  else stopWalk();
}

// ── Per-entity (bot) footsteps, distance-attenuated by the caller ──────────
// Each bot gets its own looping footstep voice whose gain the caller updates
// every frame (it passes a 0..1 factor that falls off linearly with distance to
// the player). Loops are desynced by a random start offset so a "bunch of bots"
// doesn't stomp in lockstep.
const entityWalk: Record<string, { src: AudioBufferSourceNode; gain: GainNode }> = {};

/** Loop entity `id`'s footsteps at `volume` (0..1, already distance-scaled), or
 *  stop them when `on` is false. Gain updates live on each call. */
export function setEntityWalk(id: string, on: boolean, volume: number) {
  if (!ctx || !master) return;
  const cur = entityWalk[id];
  if (on) {
    if (cur) {
      cur.gain.gain.value = volume * VOLUME.walk;
      return;
    }
    const buf = buffers.walk;
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = volume * VOLUME.walk;
    src.connect(g).connect(master);
    src.start(0, Math.random() * buf.duration); // desync from other bots
    entityWalk[id] = { src, gain: g };
  } else if (cur) {
    try {
      cur.src.stop();
    } catch {
      // already stopped
    }
    cur.src.disconnect();
    delete entityWalk[id];
  }
}

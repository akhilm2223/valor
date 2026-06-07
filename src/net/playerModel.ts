// playerModel — network-synced character selection WITHOUT a server schema
// change.
//
// The "proper" sync would be a `model` column on the server Player table, set
// via join(). That needs a Rust change + maincloud republish. Until then we
// piggyback the choice on the one Player field that ALREADY syncs to every
// client through join(): `name`. We pack `name<US>modelKey` on the wire (where
// <US> is the ASCII Unit Separator, 0x1F) and unpack it wherever a name is
// displayed or a body is rendered.
//
// When the server gains a real `model` field: send/read that instead, and the
// only edits are encodeName()/decodeName()'s call sites — the MODELS registry
// and everything downstream stay the same.

// ASCII Unit Separator (0x1F). Built from a char code so no invisible control
// character ever lives in this source file. It can't be typed into the name box.
const SEP = String.fromCharCode(31);

export interface CharOption {
  key: string; // short, wire-stable id (kept tiny — it's sent every join)
  label: string;
  url: string;
}

/** Single source of truth for selectable characters (lobby + in-game). */
export const MODELS: CharOption[] = [
  { key: "a", label: "Ranger", url: "/models/character_a.glb" },
  { key: "b", label: "Scout", url: "/models/character_b.glb" },
];

export const DEFAULT_MODEL_URL = MODELS[1].url; // Scout (prior default character_b)

function keyForUrl(url: string): string {
  return MODELS.find((m) => m.url === url)?.key ?? MODELS[1].key;
}

function urlForKey(key: string): string {
  return MODELS.find((m) => m.key === key)?.url ?? DEFAULT_MODEL_URL;
}

/** Pack a display name + chosen model url into the wire `name` for join(). */
export function encodeName(displayName: string, modelUrl: string): string {
  return `${displayName}${SEP}${keyForUrl(modelUrl)}`;
}

/** Unpack a wire `name` into a clean display name + model url. Tolerates plain
 *  names (no separator, e.g. an older client) → default model. */
export function decodeName(raw: string | undefined | null): { name: string; modelUrl: string } {
  if (!raw) return { name: "", modelUrl: DEFAULT_MODEL_URL };
  const i = raw.indexOf(SEP);
  if (i < 0) return { name: raw, modelUrl: DEFAULT_MODEL_URL };
  return { name: raw.slice(0, i), modelUrl: urlForKey(raw.slice(i + 1)) };
}

/** Convenience: just the clean display name. */
export function displayName(raw: string | undefined | null): string {
  return decodeName(raw).name;
}

// <US> + the 1-letter model key. Built from SEP so no control char sits in this
// source. Used to scrub tags out of freeform text (e.g. server commentary).
const TAG_RE = new RegExp(SEP + ".", "g");

/** Strip any packed model tags out of freeform text. The server builds kill
 *  commentary like `"{name} drops {name}"` from the RAW (encoded) names, so a
 *  bark can contain `name<US>a`. Turns "Akhil<US>a drops Bob<US>b" → "Akhil
 *  drops Bob". Safe (no-op) on already-clean text. */
export function stripTags(text: string): string {
  return text.replace(TAG_RE, "");
}

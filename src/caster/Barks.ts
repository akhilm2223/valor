// Tier 1 of the AI caster: pre-written one-liners ("barks") spliced with the
// killer/victim/team name at fire time and spoken instantly. No LLM, no fetch,
// no network — these exist so a kill always gets a callout in <100ms even when
// the LLM color-commentary lane (Phase 4 / Tier 2) is mid-request or down.
//
// Priority scale: 1 = chatter, 2 = notable, 3 = hype moment. AudioQueue uses
// priority to preempt currently-playing speech (an ace interrupts a single kill).

export type BarkPriority = 1 | 2 | 3;

export interface BarkTemplate {
  id: string;
  text: string;
  priority: BarkPriority;
}

// ~20 lines covering the kill-feed events Tier 1 has to handle on its own.
// Variants are duplicated per event so the caster doesn't repeat itself the
// second time the same thing happens in a round.
export const BARKS: BarkTemplate[] = [
  // First blood — opens the round, always priority 2
  { id: "first_blood_a", text: "First blood — {killer} draws it for {team}.", priority: 2 },
  { id: "first_blood_b", text: "{killer} opens the round. First blood, {team}.", priority: 2 },

  // Solo kill — the bread and butter, priority 1
  { id: "kill_solo_a", text: "{killer} downs {victim}.", priority: 1 },
  { id: "kill_solo_b", text: "{victim} taken out by {killer}.", priority: 1 },
  { id: "kill_solo_c", text: "Clean frag — {killer}.", priority: 1 },

  // Headshot — same priority as solo but called out for the highlight
  { id: "headshot_a", text: "Headshot. {killer} on {victim}.", priority: 2 },
  { id: "headshot_b", text: "{killer} — straight to the head.", priority: 2 },

  // Double kill
  { id: "double_a", text: "Double down — {killer} on fire.", priority: 2 },
  { id: "double_b", text: "{killer} with the double. {team} pushing.", priority: 2 },

  // Ace — full team wipe. Highest priority, preempts anything playing.
  { id: "ace_a", text: "Ace! {killer} clears the field.", priority: 3 },
  { id: "ace_b", text: "Unbelievable — {killer} with the ace for {team}.", priority: 3 },

  // Revenge kill — killer is the player who just got fragged previously
  { id: "revenge_a", text: "Revenge — {killer} pays {victim} back.", priority: 2 },
  { id: "revenge_b", text: "{killer} settles the score on {victim}.", priority: 2 },

  // Round lifecycle
  { id: "round_start_a", text: "Round live. Pistols out.", priority: 1 },
  { id: "round_start_b", text: "Here we go — round is live.", priority: 1 },
  { id: "round_win_a", text: "Round to {team}.", priority: 2 },
  { id: "round_win_b", text: "{team} takes it.", priority: 2 },

  // Self-status callouts (would be wired off the local player's HUD events,
  // not the kill stream — left here for HUD to fire directly).
  { id: "low_ammo", text: "{player}, low ammo.", priority: 1 },
  { id: "hit_warning", text: "{player} — you're hit.", priority: 1 },
];

// Lookup by id, mostly for tests + the demo UI showing what fired.
const BY_ID = new Map(BARKS.map((b) => [b.id, b]));
export function getBark(id: string): BarkTemplate | undefined {
  return BY_ID.get(id);
}

// Substitute {killer}, {victim}, {team}, etc. in a template. Missing keys
// collapse to an empty string instead of leaving the literal "{killer}"
// visible — never want a placeholder spoken aloud.
export function renderBark(template: BarkTemplate | string, vars: Record<string, string>): string {
  const text = typeof template === "string" ? template : template.text;
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

// Random pick across templates whose id matches `category` exactly or starts
// with `category_`. Lets callers say "give me any solo-kill bark" without
// hard-coding which variant.
export function pickBark(category: string): BarkTemplate {
  const matches = BARKS.filter((b) => b.id === category || b.id.startsWith(category + "_"));
  if (matches.length === 0) {
    // Shouldn't happen with the categories defined above, but fall back to a
    // generic kill line instead of throwing — caster should NEVER crash the UI.
    return BARKS.find((b) => b.id === "kill_solo_a")!;
  }
  return matches[Math.floor(Math.random() * matches.length)];
}

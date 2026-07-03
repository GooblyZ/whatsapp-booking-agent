// app/dashboard/ai-assistant/voice-preview.ts
// PURE DATA + a pure string builder — no DB, no Gemini, no network, no crypto, no Date/random.
// Type-only imports keep it safe to import from a CLIENT component (same rule as persona-presets.ts).
//
// Static owner-facing "voice preview": deterministically composes an EXAMPLE assistant reply from the
// selected style so the owner can hear the voice without messaging the live bot. UI-ONLY — nothing here
// feeds the runtime prompt (persona.ts) or the resolved style (resolve-style-profile.ts). The one
// deliberate semantic overlap (the emoji cap map, duplicated because emojiCapFor lives in a server-only
// module) is LOCKED equal to the runtime by eval §59, so it can never drift silently.
//
// Authoring rules (same as persona-presets.ts): vertical-neutral (no industry vocabulary — a preview
// must read right for a clinic, a studio, and a salon alike), style-only (no prices/digits, no URLs, no
// booking-completed claims, no operational promises), and no slash-gender forms.

import type { AISettingsEmojiUsage, AISettingsResponseLength } from "@/types/database";

export type PreviewPresetId =
  | "warm" | "professional" | "casual" | "premium" | "concise" // the shipped presets
  | "custom"   // owner-edited free text → neutral generic preview
  | "default"; // empty personality → neutral generic preview

/** Card copy for the preset chooser — description + a one-line voice sample per shipped preset. */
export interface PresetCardMeta {
  description: string;
  sample: string;
}

export const PRESET_CARD_META: Record<Exclude<PreviewPresetId, "custom" | "default">, PresetCardMeta> = {
  warm: {
    description: "טון לבבי ואישי — שיחה אנושית ונעימה.",
    sample: "היי, איזה כיף שפנית! אני כאן לכל שאלה.",
  },
  professional: {
    description: "רגוע, מסודר ואמין — בלי סלנג.",
    // NOTE: card copy must stay clean of the policy-lint terms (it models VOICE, not topics) —
    // §59 asserts flagsBusinessPolicy() returns no hits on every description/sample.
    sample: "שלום, אשמח לסייע בצורה מסודרת וברורה.",
  },
  casual: {
    description: "קליל, חברותי ובגובה העיניים.",
    sample: "היי! מה שבא לך לשאול — אני על זה.",
  },
  premium: {
    description: "מוקפד ואלגנטי — יחס אישי ומדוד.",
    sample: "שלום, נעים מאוד. אשמח להעניק מענה אישי ומדויק.",
  },
  concise: {
    description: "ישיר וממוקד — בדיוק מה שנשאל.",
    sample: "שלום, במה אפשר לעזור?",
  },
};

/** Server-resolved style-dimension data passed from page.tsx (resolveStyleProfile is server-only —
 *  it imports node crypto — so the client receives its output as plain JSON via this shape).
 *  emojiDefault/lengthDefault are each preset's PACKAGE defaults (the resolver's own
 *  PRESET_STYLE_DEFAULTS output) — applied together with the text on card click, and used for the
 *  advanced-settings "differs from the style's default" tags. Type-only addition; no logic here. */
export interface PresetDims {
  formality: number;
  warmth: number;
  energy: number;
  register: string;
  emojiDefault: AISettingsEmojiUsage;
  lengthDefault: AISettingsResponseLength;
}
export interface StyleDimsData {
  presets: Record<string, PresetDims>;
  neutral: PresetDims;
  brevityByLength: Record<AISettingsResponseLength, number>;
}

// Duplicates emojiCapFor semantics by necessity (that helper lives in a server-only module).
// Eval §59 asserts the appended-emoji count per usage === emojiCapFor(usage) — drift fails the gate.
const EMOJI_CAP: Record<AISettingsEmojiUsage, number> = { none: 0, low: 1, medium: 2 };

// Three sentences per voice — greeting / what-you-can-ask / booking-direction. short→1, medium→2,
// long→3. Every sentence ends with a single terminal mark (the §59 sentence counter relies on it).
const SENTENCES: Record<PreviewPresetId, [string, string, string]> = {
  warm: [
    "היי, איזה כיף שפנית אלינו!",
    "אפשר לשאול אותי כאן על השירותים, המחירים והזמנים — אני כאן בשבילך.",
    "וכשנוח לך, נוכל גם להתקדם לקביעת תור בקלות.",
  ],
  professional: [
    "שלום, אשמח לסייע.",
    "ניתן לשאול כאן על השירותים, הזמינות והמחירים ולקבל מענה מסודר.",
    "בנוסף, אפשר להתקדם לקביעת תור בזמן שנוח לך.",
  ],
  casual: [
    "היי! כיף שכתבת.",
    "אפשר לשאול אותי הכול — על השירותים, המחירים ומתי פנוי.",
    "ואם מתאים לך, אפשר גם לקבוע תור — פשוט ומהיר.",
  ],
  premium: [
    "שלום, נעים מאוד.",
    "אשמח להציע מענה אישי ומדויק לכל שאלה על השירותים והזמינות.",
    "כאשר יתאים לך, נוכל להמשיך יחד לקביעת תור, ברוגע ובנוחות.",
  ],
  concise: [
    "שלום, במה אפשר לעזור?",
    "אפשר לשאול כאן על שירותים, מחירים וזמינות.",
    "אפשר גם לקבוע תור בקלות.",
  ],
  custom: [
    "שלום, אפשר לשאול אותי כאן כל דבר על העסק.",
    "אשמח לעזור עם שאלות על השירותים, המחירים והזמנים.",
    "אפשר גם להתקדם לקביעת תור כשנוח לך.",
  ],
  default: [
    "שלום, אפשר לשאול אותי כאן כל דבר על העסק.",
    "אשמח לעזור עם שאלות על השירותים, המחירים והזמנים.",
    "אפשר גם להתקדם לקביעת תור כשנוח לך.",
  ],
};

// Deterministic per-voice emoji pair; the explicit emoji control decides HOW MANY are shown (the
// explicit control wins over the preset's default — mirroring the resolver's override semantics).
const EMOJIS: Record<PreviewPresetId, [string, string]> = {
  warm: ["🙂", "💛"],
  professional: ["🙂", "🙏"],
  casual: ["😊", "👍"],
  premium: ["✨", "🌟"],
  concise: ["👍", "🙂"],
  custom: ["🙂", "✨"],
  default: ["🙂", "✨"],
};

export interface VoicePreviewInput {
  presetId: PreviewPresetId;
  emojiUsage: AISettingsEmojiUsage;
  responseLength: AISettingsResponseLength;
}

/**
 * Deterministically composes the static example reply for the selected style. Pure and fail-open:
 * an unknown preset id or enum value falls back to the neutral bank / low-emoji behavior.
 */
export function buildVoicePreview(input: VoicePreviewInput): string {
  const bank = SENTENCES[input.presetId] ?? SENTENCES.default;
  const sentenceCount = input.responseLength === "short" ? 1 : input.responseLength === "long" ? 3 : 2;
  const text = bank.slice(0, sentenceCount).join(" ");
  const cap = EMOJI_CAP[input.emojiUsage] ?? 1;
  const emojis = (EMOJIS[input.presetId] ?? EMOJIS.default).slice(0, cap);
  return emojis.length > 0 ? `${text} ${emojis.join(" ")}` : text;
}

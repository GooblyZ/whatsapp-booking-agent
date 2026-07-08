// lib/ai/brain.ts
// Server-side only.
//
// The receptionist brain. Conversation (not intent classification) is the primary
// abstraction: runReceptionistTurn() reasons over the customer's goal, the live
// BOOKING CONTEXT, the facts, and real availability, then decides what to say and
// returns structured understanding for the system to merge into the session.
//
// PURE — no DB writes, no logging, no actions — so callers (conversation engine /
// debug page) reuse it safely.
//
// AI-FIRST: uncertainty / missing info NEVER triggers a rule-based path — Gemini
// asks a natural clarifying question. Deterministic fallback is reserved for real
// failures (API down, malformed output, unresolvable grounding, AI disabled).

import type { BusinessAIContext } from "@/types/database";
import type { GeminiTurn, GeminiUsage } from "./gemini";
import { geminiGenerateConversation } from "./gemini";
import { buildFacts, formatFacts, buildFactIndex, type BusinessFacts, type Capabilities } from "./facts";
import { buildReceptionistInstruction, resolveStyleForSettings } from "./persona";
import { buildPromptProfile } from "./prompt-profile";
import { verifyGrounding, extractTimeTokens, extractPhoneDigits } from "./grounding";
import { parseAiJsonResponse } from "./json-parse";
import { buildContextReply, type BookingSession } from "./booking-session";
import { revealsInternalInstructions } from "./reply-polish";
import { renderVerdictReplyHe, type AvailabilityInfo } from "./availability-facts";
import { estimateTokens, promptSizeBucket, safeHash } from "./telemetry";
import type { AIEventResponseType } from "./events";

export type ReceptionistIntent =
  | "smalltalk" | "faq" | "meta" | "booking" | "cancel_request"
  | "reschedule_request" | "out_of_scope" | "unclear";

const VALID_INTENTS: ReceptionistIntent[] = [
  "smalltalk", "faq", "meta", "booking", "cancel_request", "reschedule_request", "out_of_scope", "unclear",
];

/** Intents that assert a business operation (everything else is conversational). */
const OPERATION_INTENTS: ReceptionistIntent[] = ["booking", "cancel_request", "reschedule_request"];

/** Appointment lifecycle intent — the system must never confuse these. */
export type AppointmentIntent = "BOOK" | "RESCHEDULE" | "CANCEL" | "MODIFY" | "LIST" | "NONE";

const VALID_APPT_INTENTS: AppointmentIntent[] = ["BOOK", "RESCHEDULE", "CANCEL", "MODIFY", "LIST", "NONE"];

/** Gemini's structured output. `reply` is the only thing a customer ever sees. */
export interface ReceptionistTurn {
  reply: string;
  understanding: {
    conversationGoal?: string | null;
    /**
     * ACTIONABILITY GATE — is the customer asking the business to perform an
     * operation (book / reschedule / cancel / list) or requesting a service?
     * Default false. The system treats this as authoritative: when false, no
     * operation is possible (appointmentIntent is forced to NONE downstream).
     */
    requestsBusinessAction: boolean;
    intent: ReceptionistIntent;
    appointmentIntent: AppointmentIntent;
    serviceName?: string | null;
    dateText?: string | null;
    time?: string | null;            // concrete "HH:MM"
    timePreference?: string | null;  // softer ("בערב")
    customerReference?: string | null;
    missingInformation?: string | null;
    /** Customer wants a DIFFERENT value for a detail of the current DRAFT. */
    changeRequest?: "service" | "day" | "time" | null;
    userCorrecting?: boolean;     // "you misunderstood / forgot"
    userRepeatingInfo?: boolean;  // repeating info already given
    userFrustrated?: boolean;
    explicitConfirmation?: boolean;
  };
  needs?: "none" | "services" | "availability" | "policies";
}

/** Everything the brain needs for one turn (facts in, words out). */
export interface TurnInput {
  /**
   * Recent history as REAL turns (preferred — native multi-turn attention).
   * When provided, it is sent as actual conversation contents.
   */
  historyTurns?: GeminiTurn[];
  /** Legacy/simple alternative: transcript embedded in the instruction. */
  conversationContext: string;
  message: string;               // the customer's current message
  availabilityBlock?: string;    // rendered system-checked availability + evaluation
  bookingBlock?: string;         // rendered CURRENT BOOKING working memory
  stuckTurns?: number;           // loop detection signal (>=2 → change strategy)
  allowedTimes?: string[];       // extra exact times quotable this turn (slots, nearest)
  replyGuidance?: string;        // system-computed next-step hint for this reply
  /** Platform mode: scheduling happens on the booking page; persona drops it. */
  platformMode?: boolean;
  /** The customer's own phone — exempt from the business-phone grounding fence
   *  (it identifies the customer; it is not a business-contact claim). */
  customerPhone?: string;
  /** Caller's supersede check. On a Gemini 503 it lets an obsolete (superseded) turn abort
   *  instead of retrying / tripping the global overload cooldown. */
  abortIfSuperseded?: () => Promise<boolean>;
  /** Per-conversation single-flight signal. When a newer turn supersedes this one, the in-flight
   *  Gemini request is cancelled (no completion, no retry, no overload strike). */
  abortSignal?: AbortSignal;
}

export interface ReceptionistDecision {
  geminiCalled: boolean;
  ok: boolean;
  turn: ReceptionistTurn | null;
  replyText: string;
  responseType: AIEventResponseType;
  grounded: boolean | null;
  replySource: "gemini" | "fallback";
  wantsToCancel: boolean;          // customer wants to stop/pause the booking
  branch: string;                  // which path produced the reply (debug)
  skipReason?: string;
  fallbackReason?: string;
  groundingViolations?: string[];
  /** Exact token usage + estimated cost for this turn's Gemini call (null if not called / unavailable). */
  usage?: GeminiUsage | null;
}

// Deterministic safety fallbacks — used ONLY for real failures, never for "the AI
// is unsure". The grounding fallback is made fact-aware in groundingFallback().
export const FALLBACK = {
  aiDisabled:
    "כדי לקבוע תור אפשר לכתוב 'תור' 🙂 ולכל שאלה אחרת נשמח לעזור ישירות.",
  noise:
    "לא בטוח/ה שהבנתי 🙂 אפשר לשאול אותי כל שאלה על העסק, או לקבוע תור.",
  abuse:
    "נשמח לעזור בכל שאלה שקשורה לעסק 🙂",
  error:
    "נראה שמשהו השתבש אצלי לרגע 😅 אפשר לכתוב שוב, ואני כאן.",
  errorAlt:
    "סליחה, עדיין יש לי שיהוק טכני קטן 🙏 שווה לנסות שוב בעוד רגע, או לפנות ישירות לעסק.",
  overloaded:
    "יש לי רגע עומס קטן במערכת 🙏 אפשר לכתוב לי מה תרצה לקבוע — שירות, יום ושעה — ואני אסדר את זה לפי הפרטים שיש לי.",
  overloadedAgain:
    "אני עדיין בעומס קצר 🙏 אפשר בינתיים לכתוב לי שירות, יום ושעה — ואני אמשיך לפי מה שיש לי.",
  grounding:
    "אני רוצה לתת לך מידע מדויק ולא בטוח/ה בפרט הזה כרגע 🙏 מומלץ לפנות ישירות לעסק.",
  disclosure:
    "אני כאן כדי לעזור עם תורים ושאלות על העסק 🙂 איך אפשר לעזור?",
} as const;

type InputKind = "ok" | "noise" | "abuse";

const NOISE_TOKENS = new Set(["asdf", "asd", "asdfgh", "qwerty"]);
const ABUSE_TOKENS = ["fuck", "shit", "bitch", "זין", "כוס", "שרמוטה", "מניאק"];

/**
 * Cheap deterministic guard BEFORE Gemini — spam/noise/abuse ONLY. Everything
 * else (greetings, smalltalk, questions, digits, times) goes to Gemini.
 */
export function classifyInput(text: string): InputKind {
  const t = text.trim();
  if (t.length < 1) return "noise";
  const lower = t.toLowerCase();
  if (ABUSE_TOKENS.some((w) => lower.includes(w))) return "abuse";
  if (NOISE_TOKENS.has(lower)) return "noise";
  if (!/[a-zA-Z֐-׿0-9]/.test(t)) return "noise";     // emoji/punct only
  if (/^(.)\1{3,}$/.test(t)) return "noise";           // "חחחחח", "kkkk"
  return "ok";
}

function fallback(
  replyText: string,
  responseType: AIEventResponseType,
  branch: string,
  extra: Partial<ReceptionistDecision> = {}
): ReceptionistDecision {
  return {
    geminiCalled: false,
    ok: false,
    turn: null,
    replyText,
    responseType,
    grounded: null,
    replySource: "fallback",
    wantsToCancel: false,
    branch,
    ...extra,
  };
}

/** Fact-aware grounding fallback: use known facts instead of a generic deflection. */
function groundingFallback(facts: BusinessFacts, kinds: string[]): string {
  if (kinds.includes("time")) {
    const open = facts.hours.filter((h) => !h.closed && h.opens && h.closes);
    if (open.length > 0) {
      const summary = open.map((h) => `${h.day} ${h.opens}-${h.closes}`).join(", ");
      return `רגע, שאדייק 🙏 שעות הפעילות שלנו: ${summary}. אפשר לבדוק שעה בטווח הזה?`;
    }
  }
  return FALLBACK.grounding;
}

/**
 * Decides how the receptionist responds to one customer message.
 * PURE: no DB writes, no logging, no booking execution. Calls Gemini (read-only).
 */
export async function runReceptionistTurn(
  ctx: BusinessAIContext,
  input: TurnInput
): Promise<ReceptionistDecision> {
  const ai = ctx.aiSettings;
  const aiEnabled = ai?.ai_enabled !== false;
  const faqEnabled = ai?.faq_enabled !== false;
  const intentEnabled = ai?.intent_detection_enabled !== false;

  if (!aiEnabled) {
    return fallback(FALLBACK.aiDisabled, "ai_disabled", "ai_disabled", { skipReason: "ai_disabled", fallbackReason: "ai_disabled" });
  }

  const guard = classifyInput(input.message);
  if (guard === "abuse") return fallback(FALLBACK.abuse, "abuse", "guard_abuse", { skipReason: "abuse" });
  if (guard === "noise") return fallback(FALLBACK.noise, "noise", "guard_noise", { skipReason: "noise" });

  // KB is conservatively scoped to THIS message's topic on the AI path (full KB on any doubt — see
  // scopeKnowledge). Structured facts (name/services/hours/location) are always included.
  const facts = buildFacts(ctx, { message: input.message });
  const caps: Capabilities = {
    canAnswer: faqEnabled,
    canStartBooking: intentEnabled && facts.bookingEnabled,
    canCancel: false,
    canReschedule: false,
  };

  const useNativeHistory = (input.historyTurns?.length ?? 0) > 0;
  const factsBlock = formatFacts(facts);
  // AI Settings Phase 1B: build the normalized owner profile ONCE and pass it to the persona, so the
  // prompt sources identity/style from the same PromptProfile the outbound fences use. Its hash +
  // version are logged below for turn traceability ("this reply used this settings profile").
  const profile = buildPromptProfile(ctx.aiSettings, ctx.business.id);
  // Phase B2: the resolved presentation-style profile — resolved ONCE via the persona's own legacy
  // chain (so the styleHash always describes the character text the prompt renders) and passed in.
  // styleHash is ADDITIVE observability: profileHash keeps its exact meaning and consumers.
  const styleProfile = resolveStyleForSettings(ctx.aiSettings);
  const instruction = buildReceptionistInstruction(ctx, {
    factsBlock,
    caps,
    profile,
    styleProfile,
    // With native history, the transcript block is redundant — the turns speak
    // for themselves (and far more naturally).
    conversationContext: useNativeHistory ? "" : input.conversationContext,
    nativeHistory: useNativeHistory,
    availabilityBlock: input.availabilityBlock,
    bookingBlock: input.bookingBlock,
    stuckTurns: input.stuckTurns,
    replyGuidance: input.replyGuidance,
    platformMode: input.platformMode,
  });
  const turns: GeminiTurn[] = [
    ...(input.historyTurns ?? []),
    { role: "user", text: input.message.slice(0, 1000) },
  ];

  // LOG-ONLY correlation id for this turn — a phone-safe one-way hash (never the raw phone), tying this
  // `[gemini-prompt]` line to the `[gemini-attempt]` / `[gemini-usage]` / `[gemini-health]` lines emitted
  // by the call below. Time-seeded so each turn is distinct.
  const turnId = safeHash(`${ctx.business.id}:${input.customerPhone ?? ""}:${Date.now()}`);

  // Cost instrumentation: per-request prompt composition (CHAR sizes only — safe
  // metadata, no content). persona_base = instruction minus the injected blocks.
  {
    const sz = (s: string | undefined) => (s ?? "").length;
    const historyChars = (input.historyTurns ?? []).reduce((n, t) => n + t.text.length, 0);
    const messageChars = Math.min(input.message.length, 1000);
    const injected =
      sz(factsBlock) + sz(input.availabilityBlock) + sz(input.bookingBlock) +
      sz(input.replyGuidance) + (useNativeHistory ? 0 : sz(input.conversationContext)) +
      sz(ctx.aiSettings?.custom_instructions ?? undefined);
    // Whole-call estimate (system instruction + native-history turns + the user message) → tokens + bucket,
    // so a FAILED call (no API usage metadata) can still be analyzed by size. ~4 chars/token heuristic.
    const promptTokensEst = estimateTokens(instruction.length + historyChars + messageChars);
    // KB scoping observability (Stage 3B Phase 3): how many active KB items were sent vs available.
    const kbActive = ctx.knowledgeBaseItems.filter((k) => k.active).length;
    const kbScoped = facts.knowledge.length < kbActive;
    // Prompt-budget visibility (post-v1 audit Slice 1 — LOG-ONLY, computed from data already in
    // scope; no prompt byte changes): the FACTS block split by section, an EXPLICIT flag for the
    // formatFacts 6k tail-truncation (previously silent — the top scaling risk), whether an owner
    // personality is present (via the SAME legacy chain the prompt renders), and per-section token
    // estimates so growth is attributable without re-deriving from chars.
    const kbChars = facts.knowledge.reduce((n, k) => n + k.title.length + k.content.length, 0);
    const factsTruncated = factsBlock.endsWith("…(truncated)");
    const personaPresent = styleProfile.preset !== "default"; // resolved via effectivePersonality chain
    console.log(
      `[gemini-prompt] turn=${turnId} business=${ctx.business.id} mode=full kb=${facts.knowledge.length}/${kbActive} kb_scoped=${kbScoped} chars: instruction=${instruction.length}` +
      ` (persona_base≈${Math.max(0, instruction.length - injected)}` +
      ` facts=${sz(factsBlock)} availability=${sz(input.availabilityBlock)}` +
      ` booking=${sz(input.bookingBlock)} guidance=${sz(input.replyGuidance)}` +
      ` custom=${sz(ctx.aiSettings?.custom_instructions ?? undefined)}` +
      ` transcript=${useNativeHistory ? 0 : sz(input.conversationContext)})` +
      ` + history_turns=${input.historyTurns?.length ?? 0} (${historyChars} chars)` +
      ` + message=${messageChars}` +
      ` | facts_services_n=${facts.services.length} facts_hours_n=${facts.hours.length}` +
      ` facts_kb_n=${facts.knowledge.length} facts_kb_chars=${kbChars} facts_truncated=${factsTruncated}` +
      ` persona_present=${personaPresent}` +
      ` | promptTokensEst=${promptTokensEst} bucket=${promptSizeBucket(promptTokensEst)}` +
      ` instrTokensEst=${estimateTokens(instruction.length)} factsTokensEst=${estimateTokens(sz(factsBlock))}` +
      ` historyTokensEst=${estimateTokens(historyChars)} instrHash=${safeHash(instruction)}` +
      // Settings traceability (safe metadata only — no prompt, message, phone, or custom-instruction text).
      // styleHash (Phase B2) = the RESOLVED presentation style only (ignores name; collapses
      // semantically identical styles) — additive next to the full profileHash, never replacing it.
      ` | profileHash=${profile.promptProfileHash} settingsVersion=${profile.settingsVersion ?? "-"} styleHash=${styleProfile.resolvedHash}`
    );
  }

  const res = await geminiGenerateConversation(instruction, turns, {
    abortIfSuperseded: input.abortIfSuperseded,
    signal: input.abortSignal,
    turnId,
  });
  if (!res.ok) {
    if (res.code === "not_configured") {
      return fallback(FALLBACK.error, "not_configured", "not_configured", { skipReason: "not_configured", fallbackReason: "not_configured" });
    }
    if (res.code === "overloaded") {
      // 503 / high demand — transient upstream pressure, NOT a generic glitch:
      // the customer gets a useful "leave me the details" line, and the engine's
      // cooldown (lib/ai/gemini.ts) keeps the next turns deterministic.
      return fallback(FALLBACK.overloaded, "error", "api_overloaded", { geminiCalled: true, fallbackReason: "gemini_overloaded" });
    }
    return fallback(FALLBACK.error, "error", "api_error", { geminiCalled: true, fallbackReason: `gemini_${res.code}` });
  }

  const turn = parseReceptionistTurn(res.text);
  if (!turn) {
    // Rich, observable failure diagnostics. `diag` re-runs the recovery pass (cheap,
    // failure-path only) to classify WHY it failed. reason="schema_mismatch" means
    // valid JSON that lacked required fields; otherwise it's a parse failure with a
    // typed reason. We log a large capped slice of the raw MODEL output (not the
    // customer's message) so these are debuggable from logs alone.
    const diag = parseAiJsonResponse(res.text);
    const reason = diag.ok ? "schema_mismatch" : diag.reason;
    const errMsg = (diag.ok ? "valid JSON, missing/invalid required fields" : diag.error).slice(0, 240);
    console.warn(
      `[ai] malformed_json reason=${reason} rawLen=${res.text.length} err="${errMsg}" ` +
      `raw(2000)="${res.text.slice(0, 2000).replace(/\s+/g, " ")}"`
    );
    return fallback(FALLBACK.error, "error", "parse_error", { geminiCalled: true, fallbackReason: `malformed_json:${reason}`, usage: res.usage });
  }

  // INTERNAL-DISCLOSURE FENCE (model-output safety; same discard-for-safe-deflection
  // pattern as grounding below): a hostile owner custom_instruction may try to make the
  // model echo its system instruction / output schema. The only internal material in the
  // prompt is the persona scaffold + JSON schema (secrets/config are never put in the
  // prompt), so a reply regurgitating it is the entire leak surface — caught structurally
  // here and swapped for a safe, content-free deflection. No-op on every normal reply.
  if (revealsInternalInstructions(turn.reply)) {
    console.warn("[ai] internal_disclosure_blocked — model reply regurgitated system scaffolding/schema; served safe deflection");
    return fallback(FALLBACK.disclosure, "irrelevant", "internal_disclosure_blocked", {
      geminiCalled: true,
      turn,
      fallbackReason: "internal_disclosure_blocked",
      usage: res.usage,
    });
  }

  // Strict grounding (last-resort fence; availability truth was fed upstream):
  // allowed = inside open-hours ranges ∪ system-provided times ∪ customer-echoed times.
  const index = buildFactIndex(facts);
  const allowedTimes = new Set(input.allowedTimes ?? []);
  const echoTimes = extractTimeTokens(input.message);
  // The customer's own number + any phone they typed are quotable (not a business
  // claim). Live bug: in platform mode the booking link carries ?p=<customerPhone>,
  // so the customer's phone landed in history → the model echoed it → the fence
  // wrongly flagged it as a non-business phone and suppressed the booking link.
  const allowedPhones = extractPhoneDigits(input.message);
  if (input.customerPhone) {
    const d = input.customerPhone.replace(/\D/g, "");
    if (d.length >= 9) allowedPhones.add(d);
  }

  const grounding = verifyGrounding(turn.reply, index, allowedTimes, echoTimes, allowedPhones);
  if (!grounding.ok) {
    console.warn(`[ai] grounding failed: ${grounding.violations.join("; ")}`);
    return fallback(groundingFallback(facts, grounding.kinds), "grounding_failed", "grounding_failed", {
      geminiCalled: true,
      turn,
      grounded: false,
      wantsToCancel: turn.understanding.intent === "cancel_request",
      groundingViolations: grounding.violations,
      fallbackReason: `grounding:${grounding.kinds.join(",") || "unknown"}`,
      usage: res.usage,
    });
  }

  return {
    geminiCalled: true,
    ok: true,
    turn,
    replyText: turn.reply,
    responseType: intentToResponseType(turn.understanding.intent),
    grounded: true,
    replySource: "gemini",
    wantsToCancel: turn.understanding.intent === "cancel_request",
    branch: "gemini_reply",
    usage: res.usage,
  };
}

function intentToResponseType(intent: ReceptionistIntent): AIEventResponseType {
  switch (intent) {
    case "faq": return "faq_answer";
    case "smalltalk": return "conversation";
    case "booking": return "booking_intent";
    case "cancel_request":
    case "reschedule_request": return "cancel_reschedule";
    case "out_of_scope": return "irrelevant";
    default: return "unknown";
  }
}

/** Parses + validates Gemini's JSON into a ReceptionistTurn. Returns null if untrustworthy. */
export function parseReceptionistTurn(raw: string): ReceptionistTurn | null {
  // Robust, recovery-capable parse (fences, surrounding prose, unescaped inner
  // quotes like ש"ח). Never fabricates: an unrecoverable response returns null and
  // the caller logs rich diagnostics + serves the safe fallback.
  const result = parseAiJsonResponse(raw);
  if (!result.ok) return null;
  if (typeof result.data !== "object" || result.data === null) return null;
  const obj = result.data as Record<string, unknown>;

  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  if (reply.length === 0) return null;

  const u = (typeof obj.understanding === "object" && obj.understanding !== null
    ? obj.understanding
    : {}) as Record<string, unknown>;

  const rawIntent = typeof u.intent === "string" ? u.intent : "unclear";
  let intent = (VALID_INTENTS as string[]).includes(rawIntent)
    ? (rawIntent as ReceptionistIntent)
    : "unclear";

  const rawApptIntent = typeof u.appointmentIntent === "string" ? u.appointmentIntent.toUpperCase() : "NONE";
  let appointmentIntent = (VALID_APPT_INTENTS as string[]).includes(rawApptIntent)
    ? (rawApptIntent as AppointmentIntent)
    : "NONE";

  // ACTIONABILITY is authoritative — it resolves the "uncertainty → BOOK" drift at
  // the source. The model first decides whether this is a business operation; if
  // not, the turn CANNOT carry one (NONE), and a contradictory operation-intent is
  // downgraded to unclear. This keeps intent + appointmentIntent internally
  // coherent instead of leaving "intent=booking appt=BOOK" on a vague message.
  const requestsBusinessAction = u.requestsBusinessAction === true;
  if (!requestsBusinessAction) {
    appointmentIntent = "NONE";
    if (OPERATION_INTENTS.includes(intent)) intent = "unclear";
  } else if (appointmentIntent === "NONE") {
    // Affirmed an operation but didn't name it → derive from intent (default BOOK,
    // the common case: a new appointment / service request).
    appointmentIntent = intent === "cancel_request" ? "CANCEL"
      : intent === "reschedule_request" ? "RESCHEDULE" : "BOOK";
  }

  const needsRaw = typeof obj.needs === "string" ? obj.needs : "none";
  const needs = (["none", "services", "availability", "policies"] as const).includes(
    needsRaw as "none" | "services" | "availability" | "policies"
  )
    ? (needsRaw as ReceptionistTurn["needs"])
    : "none";

  return {
    reply,
    understanding: {
      conversationGoal: optionalString(u.conversationGoal),
      requestsBusinessAction,
      intent,
      appointmentIntent,
      serviceName: optionalString(u.serviceName),
      dateText: optionalString(u.dateText),
      time: optionalString(u.time),
      timePreference: optionalString(u.timePreference),
      customerReference: optionalString(u.customerReference),
      missingInformation: optionalString(u.missingInformation),
      changeRequest: parseChangeRequest(u.changeRequest),
      userCorrecting: u.userCorrecting === true,
      userRepeatingInfo: u.userRepeatingInfo === true,
      userFrustrated: u.userFrustrated === true,
      explicitConfirmation: u.explicitConfirmation === true,
    },
    needs,
  };
}

function optionalString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function parseChangeRequest(v: unknown): "service" | "day" | "time" | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  return t === "service" || t === "day" || t === "time" ? t : undefined;
}

// ── Degraded mode (Gemini overload cooldown) ──────────────────────────────────

// Low-value acknowledgements — during an overload cooldown these never justify
// an AI call ("אוקי" right after a 503 storm must not re-trigger the model).
// "לא" is deliberately EXCLUDED: it can mean offer rejection.
const ACK_TOKENS = new Set([
  "אוקי", "אוקיי", "אוקי תודה", "בסדר", "סבבה", "טוב", "מעולה", "אחלה", "מגניב",
  "תודה", "תודה רבה", "סגור", "הבנתי", "כן", "יאללה",
  "ok", "okay", "thanks", "thank you", "10x",
]);

// Single acknowledgement WORDS — used to recognize a message composed ENTIRELY of acks even when the exact
// COMBINATION isn't a listed token (e.g. "מעולה תודה", "תודה מעולה", "אחלה תודה רבה"). General, not a phrase
// list: every word must be an ack word, so a real business message ("תודה אני רוצה לקבוע") is never an ack.
// "כן" is deliberately omitted — a bare/leading "yes" is an AFFIRMATION (offer resolution), handled elsewhere.
const ACK_WORDS = new Set([
  "אוקי", "אוקיי", "בסדר", "סבבה", "טוב", "מעולה", "אחלה", "מגניב", "תודה", "רבה",
  "סגור", "הבנתי", "יאללה", "בכיף", "ok", "okay", "thanks", "thank", "you", "10x",
]);

export function isLowValueAck(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!?.,…]+$/g, "").trim();
  if (t.length === 0 || t.length > 20) return false;
  if (ACK_TOKENS.has(t) || /^אוקי+$/.test(t) || /^סבבה+$/.test(t)) return true;
  // Multi-word acknowledgement: 2–4 words, ALL of them ack words (a business word anywhere → not an ack).
  const words = t.split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((w) => ACK_WORDS.has(w));
}

/**
 * True for our own failure/degraded lines. They carry no conversational
 * information, and fed back as model turns they teach the model to talk about
 * glitches — so conversation memory keeps them OUT of the AI-facing history
 * (the guard-facing transcript keeps everything).
 */
export function isKnownFallbackText(s: string): boolean {
  // Two families, both kept OUT of AI-facing history (they carry no business
  // information and, as model turns, teach the bot to talk about glitches/confusion):
  //   1) error / overload notices
  //   2) deterministic low-signal / quiet-mode / "I didn't understand" canned lines
  //      (Risk A) — matched by distinctive, gender-stable fragments (outbound gender
  //      enforcement may rewrite מצליחה→מצליח, hence מצליח(?:ה)?). Fragments are long
  //      and specific so a genuine business answer is never dropped.
  return /משהו השתבש אצלי|שיהוק טכני|עומס קטן במערכת|עדיין בעומס|הייתה לי תקלה|לא הצלחתי להבין|לא מצליח(?:ה)? להבין את הכוונה|כשיהיה ברור מה צריך|אפשר לכתוב לי אם תרצה לקבוע תור|סליחה על הבלבול|לא בטוח\/ה שהבנתי/.test(s);
}

/**
 * True when the overload notice was already shown in the current conversation
 * window — checked against ALL assistant lines of the transcript, not just the
 * last one (an intermediate "סבבה" must not reset the notice and cause spam).
 */
export function overloadNoticeAlreadyShown(transcript: string): boolean {
  return transcript
    .split("\n")
    .some((l) => l.startsWith("Assistant (you, earlier): ") && l.includes("עומס"));
}

/**
 * Deterministic reply for a turn served WITHOUT Gemini (overload cooldown).
 * Priorities: honest availability verdict > booking continuation (recap + ONE
 * question) > short ack > degraded notice. The notice appears at most once per
 * conversation window (noticeSent — see overloadNoticeAlreadyShown).
 */
export function composeDegradedReply(
  message: string,
  session: BookingSession,
  availability: AvailabilityInfo | null,
  noticeSent: boolean
): string {
  const notice = "יש לי רגע עומס קטן במערכת 🙏";

  // A system-checked verdict on a concrete request is the most useful thing we own.
  if (availability?.requested && availability.requested.category !== "available") {
    const verdict = renderVerdictReplyHe(availability, session.rejectedSlots);
    if (verdict) return verdict;
  }
  if (isLowValueAck(message)) {
    if (noticeSent) return "סבבה 🙂";
    return session.active
      ? `${notice} ${buildContextReply(session)}`
      : `${notice} כשתרצה — אפשר לכתוב לי שירות, יום ושעה ואני אסדר את זה.`;
  }
  if (session.active) {
    const ctx = buildContextReply(session);
    return noticeSent ? ctx : `${notice} ${ctx}`;
  }
  return noticeSent ? FALLBACK.overloadedAgain : FALLBACK.overloaded;
}

// scripts/eval/reliability-eval.ts
// Reliability EVAL HARNESS — deterministic golden layer (Phase 0 / WS D / T4).
//
// PURPOSE: a small, fast, ZERO-COST safety net over the reliability/routing/
// aggregation DECISION logic — the already-pure functions. It snapshots the
// CURRENT decision behavior as a committed golden baseline so future refactors
// (esp. WS A's TurnPipeline consolidation) are provably behavior-neutral, without
// live-WhatsApp roulette. This is a safety net, NOT a test platform.
//
// GUARANTEES (definition of done):
//   • NO network, NO Gemini, NO DB writes. Uses inline Understanding objects and
//     the chainable mock-db pattern from simulate-conversations.ts (scenarios
//     41 & 43). Runs in well under 2s and is CI-safe WITHOUT any API keys.
//   • Imports ONLY already-exported pure functions — it changes no runtime code.
//   • Passes with 0 golden diffs against the implementation it was generated from.
//
// RUN (no env needed):
//   npm i -D --no-save tsx        # once per node_modules
//   npm run eval                  # diff against golden.json  (exit 1 on any diff)
//   npm run eval -- --update-golden   # regenerate the baseline (the git diff IS
//                                     # the review artifact — inspect it on purpose)
//
// The live-Gemini understanding check is a SEPARATE command (`npm run eval:live`,
// scripts/eval/live-understanding.ts) and is never required for this pass.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveRoute, modelOperation, messageOperation, linkKindForRoute, type Route,
} from "../../lib/ai/routing";
import {
  preGeminiAction, lowSignalKind, countsTowardQuiet, lowSignalActionFor, quietModePlan,
  greetingResetPlan, applyBookingEvidenceGate, hasBookingSignal, isEmojiOnly, looksLikeNoise,
  looksLikeGreetingOrMeta, suppressLinkFor, persistPlatformState,
  readLowSignalCount, readGreetingCount,
  LOW_SIGNAL_SHORT, LOW_SIGNAL_BOUNDARY, LOW_SIGNAL_QUIET_REMINDER, QUIET_RESET,
  COMPLAINT_ACK, META_FALLBACK, GREETING_DETERMINISTIC_AT,
} from "../../lib/ai/platform-turn";
import { aggregateBurst } from "../../lib/message-handler";
import { hasNewerInbound } from "../../lib/booking/flow";
import { getAggregationDebounceMs } from "../../lib/config";
import { isKnownFallbackText, FALLBACK, type ReceptionistDecision } from "../../lib/ai/brain";

const GOLDEN_PATH = fileURLToPath(new URL("./golden.json", import.meta.url));

// The test tenant's services (matches simulate-conversations.ts so golden values
// line up with documented incidents). Examples only — never the product model.
const SERVICES = ["תספורת", "צבע", "פן"];

// ── Cast helpers (the pattern used across the sim suite, scenarios 30/34/42) ─────
type Understanding = Parameters<typeof resolveRoute>[0];
/** Build a minimal Understanding inline. Fresh object each call so the in-place
 *  evidence gate can mutate it without leaking across cases. */
const mkU = (intent: string, appt: string, action = true): Understanding =>
  ({ requestsBusinessAction: action, intent, appointmentIntent: appt }) as unknown as Understanding;
/** Wrap an Understanding as an OK decision (for lowSignalKind). */
const mkDec = (u: Understanding): ReceptionistDecision =>
  ({ ok: true, turn: { reply: "r", understanding: u } }) as unknown as ReceptionistDecision;

// ── Mock DBs (no real I/O — same shape as simulate-conversations.ts) ─────────────
/** Records upserts so persistPlatformState's contract is checkable without a live DB. */
function mkRecordingDb(): { db: Parameters<typeof persistPlatformState>[0]; upserts: () => number; lastCtx: () => Record<string, unknown> } {
  let upserts = 0;
  let lastCtx: Record<string, unknown> = {};
  const db = {
    from: () => ({
      upsert: async (row: { context: Record<string, unknown> }) => { upserts++; lastCtx = row.context; return { data: null, error: null }; },
    }),
  } as unknown as Parameters<typeof persistPlatformState>[0];
  return { db, upserts: () => upserts, lastCtx: () => lastCtx };
}
/** Chainable burst DB: lastOut query ends in .maybeSingle(); the burst query awaits .order(). */
const mkBurstDb = (lastOut: string | null, rows: Array<{ body: string }>): Parameters<typeof aggregateBurst>[0] => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "lte", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: lastOut ? { created_at: lastOut } : null });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: rows });
  return { from: () => chain } as unknown as Parameters<typeof aggregateBurst>[0];
};
/** Chainable "newer inbound exists?" DB: returns rows whose timestamp > the gt() anchor. */
const mkSerialDb = (times: string[]): Parameters<typeof hasNewerInbound>[0] => {
  let gtArg: string | null = null;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain; chain.eq = () => chain; chain.limit = () => chain;
  chain.gt = (_c: string, v: string) => { gtArg = v; return chain; };
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve({ data: times.filter((t) => gtArg !== null && t > gtArg).map((t) => ({ id: t })) });
  return { from: () => chain } as unknown as Parameters<typeof hasNewerInbound>[0];
};

// ═════════════════════════════════════════════════════════════════════════════════
// TEMPORARY decision-sequence runner.
//
//   ⚠ THIS IS A SAFETY-CHECK SCAFFOLD, NOT A SECOND SOURCE OF TRUTH. ⚠
//
// It composes the EXPORTED pure functions in runPlatformTurn's documented order to
// snapshot the multi-turn DECISION SKELETON only: { geminiCalled, counters,
// suppressReply, route, link }. It deliberately models NONE of the runtime's reply
// text, fences, URL stripping, persistence, or logging — those stay owned solely by
// runPlatformTurn. It exists ONLY so the golden layer can catch a regression in how
// the pure functions COMPOSE across turns.
//
// DELETE THIS BLOCK once WS A (T1) extracts a pure TurnPipeline: point the sequence
// fixtures at the real pipeline and remove this scaffold. Do not let it grow into a
// reimplementation of runPlatformTurn — if a faithful sequence check needs more than
// composing these pure functions, that is the signal that the real pipeline must be
// extracted first.
// ═════════════════════════════════════════════════════════════════════════════════
interface SeqTurn { msg: string; stub?: { action: boolean; intent: string; appt: string }; }
interface StepOut { gemini: boolean; low: number; greet: number; suppress: boolean; route: Route | "NONE"; link: string | null; }

function step(prevLow: number, prevGreet: number, t: SeqTurn): StepOut {
  // 1) Emoji-only → never Gemini; same low-signal escalation as text gibberish.
  if (isEmojiOnly(t.msg)) {
    const low = prevLow + 1;
    const action = lowSignalActionFor(low);
    const suppress = action === "quiet_mode" ? quietModePlan(low).suppressReply : false;
    return { gemini: false, low, greet: 0, suppress, route: "NONE", link: null };
  }
  // 2) Pre-Gemini guard (cost control before any model call).
  const pre = preGeminiAction(prevLow, prevGreet, t.msg, SERVICES);
  if (pre === "skip_gemini_gibberish") {
    const low = prevLow + 1;
    return { gemini: false, low, greet: 0, suppress: quietModePlan(low).suppressReply, route: "NONE", link: null };
  }
  if (pre === "cheap_reset_reply") {
    const greet = prevGreet + 1;
    return { gemini: false, low: 0, greet, suppress: greetingResetPlan(greet).suppressReply, route: "NONE", link: null };
  }
  // 3) Proceed to Gemini — modeled with a SCRIPTED stub understanding (no live call).
  const stub = t.stub ?? { action: false, intent: "unclear", appt: "NONE" };
  const u = mkU(stub.intent, stub.appt, stub.action);
  applyBookingEvidenceGate(u, t.msg, SERVICES); // in-place downgrade of an unsupported claim
  let route: Route | "NONE" = "NONE";
  let link: string | null = null;
  if (!suppressLinkFor(t.msg)) {
    const rd = resolveRoute(u, t.msg);
    route = rd.route;
    const lk = linkKindForRoute(rd.route);
    const bookingSignal = hasBookingSignal(t.msg, SERVICES);
    if (lk === "booking" && !(rd.reason === "model_intent" && !bookingSignal)) link = "booking";
    else if (lk === "manage") link = "manage(db-resolved)"; // data-resolved path — not exercised here
  }
  // Post-Gemini low-signal counter.
  const kind = lowSignalKind(mkDec(u), t.msg, SERVICES);
  const counts = countsTowardQuiet(kind);
  const low = counts ? prevLow + 1 : 0;
  const greet = (kind === "smalltalk" || kind === "meta") ? prevGreet + 1 : 0;
  const action = lowSignalActionFor(low);
  // The low-signal block nulls any link from count 2 up (short_clarify/boundary/quiet).
  if (action === "short_clarify" || action === "boundary" || action === "quiet_mode") link = null;
  const suppress = action === "quiet_mode" ? quietModePlan(low).suppressReply : false;
  return { gemini: true, low, greet, suppress, route, link };
}

/** Runs a multi-turn script through step(), threading the counters. */
function runSequence(turns: SeqTurn[]): { geminiCalls: number; finalLow: number; finalGreet: number; trace: StepOut[] } {
  let low = 0, greet = 0, geminiCalls = 0;
  const trace: StepOut[] = [];
  for (const t of turns) {
    const out = step(low, greet, t);
    if (out.gemini) geminiCalls++;
    low = out.low; greet = out.greet;
    trace.push(out);
  }
  return { geminiCalls, finalLow: low, finalGreet: greet, trace };
}

// ── Golden case registry ─────────────────────────────────────────────────────────
const cases: Array<{ name: string; value: unknown }> = [];
const add = (name: string, value: unknown): void => { cases.push({ name, value }); };

async function buildCases(): Promise<void> {
  // ── ROUTING INTEGRITY (lib/ai/routing.ts) ──────────────────────────────────────
  const rd = (intent: string, appt: string, msg: string, action = true) => {
    const d = resolveRoute(mkU(intent, appt, action), msg);
    return { route: d.route, reason: d.reason, link: linkKindForRoute(d.route) };
  };
  // The live bug: model self-contradicts (intent=booking + appt=LIST) on "show my appts".
  add("routing.list_self_contradiction", rd("booking", "LIST", "אפשר לראות את כל התורים שלי?"));
  // Opposite direction: an explicit booking verb wins over a model LIST mislabel.
  add("routing.book_verb_over_list_label", rd("unclear", "LIST", "אפשר לקבוע פן?"));
  // Full operation matrix from the USER'S OWN WORDS, robust to a wrong model label.
  add("routing.operation_matrix", [
    "אפשר לקבוע פן?", "אני רוצה לקבוע תור נוסף", "אפשר לראות את כל התורים שלי?", "מה התורים שלי?",
    "אני רוצה לשנות את התור שלי", "אפשר להזיז את התור?", "אני רוצה לבטל את התור", "לבטל ולקבוע מחדש",
  ].map((m) => ({ msg: m, route: resolveRoute(mkU("unclear", "LIST"), m).route })));
  // FAQ / smalltalk never route to an operation (even with an op verb in the text).
  add("routing.faq_smalltalk_never_operation", {
    cancelCost: rd("faq", "NONE", "כמה עולה לבטל תור?", false),
    howAreYou: rd("smalltalk", "NONE", "מה שלומך?", false),
    parking: rd("faq", "NONE", "יש חניה?", false),
  });
  // Model field disagreement reconciled: appointmentIntent (fine) wins over coarse intent.
  add("routing.model_field_reconcile", {
    bookingList: modelOperation(mkU("booking", "LIST")),
    bookingCancel: modelOperation(mkU("booking", "CANCEL")),
    unclearBook: modelOperation(mkU("unclear", "BOOK")),
    none: modelOperation(mkU("smalltalk", "NONE", false)),
  });
  // No-verb message falls back to the (reconciled) model route.
  add("routing.no_verb_fallback", {
    pen: resolveRoute(mkU("booking", "BOOK"), "פן בבקשה").route,
    oki: resolveRoute(mkU("unclear", "NONE", false), "אוקיי").route,
  });
  // Link kind agrees with route for every route (no link/intent disagreement possible).
  add("routing.link_kinds", {
    BOOK: linkKindForRoute("BOOK"), LIST: linkKindForRoute("LIST"), RESCHEDULE: linkKindForRoute("RESCHEDULE"),
    CANCEL: linkKindForRoute("CANCEL"), NONE: linkKindForRoute("NONE"),
  });
  // Route depends ONLY on (understanding, message): the model's appt label can't distort it.
  add("routing.independent_of_model_label", {
    bookSame: resolveRoute(mkU("unclear", "LIST"), "אפשר לקבוע פן?").route === resolveRoute(mkU("unclear", "BOOK"), "אפשר לקבוע פן?").route,
    listSame: resolveRoute(mkU("booking", "BOOK"), "אפשר לראות את כל התורים שלי?").route === resolveRoute(mkU("unclear", "CANCEL"), "אפשר לראות את כל התורים שלי?").route,
  });
  // messageOperation precedence (RESCHEDULE > CANCEL > LIST > BOOK), and null on no verb.
  add("routing.message_operation", {
    book: messageOperation("אני רוצה לקבוע תור"),
    list: messageOperation("להציג את התורים שלי"),
    cancel: messageOperation("אני רוצה לבטל"),
    reschedule: messageOperation("אפשר להזיז את התור?"),
    cancelThenRebook: messageOperation("לבטל ולקבוע מחדש"),
    none: messageOperation("מה שלומך?"),
    empty: messageOperation(""),
  });

  // ── LOW-SIGNAL / QUIET MODE (lib/ai/platform-turn.ts) ───────────────────────────
  add("lowSignal.action_tiers", [0, 1, 2, 3, 4, 5, 6].map((c) => lowSignalActionFor(c)));
  // Escalate over consecutive low turns, then RESET on a productive turn (sim scenario 32).
  {
    const seq = [true, true, true, true, false, true];
    let c = 0; const acts: string[] = [];
    for (const low of seq) { c = low ? c + 1 : 0; acts.push(lowSignalActionFor(c)); }
    add("lowSignal.escalate_then_reset", acts);
  }
  add("lowSignal.quiet_plan", [1, 3, 4, 5, 6, 7, 8].map((c) => ({ c, ...quietModePlan(c) })));
  add("lowSignal.greeting_reset_plan", [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ n, ...greetingResetPlan(n) })));
  // preGeminiAction over the documented decision table (greetingCount=0 unless noted).
  const pa = (low: number, greet: number, msg: string) => preGeminiAction(low, greet, msg, SERVICES);
  add("lowSignal.pre_gemini", [
    { low: 3, greet: 0, msg: "חכלגצג" }, { low: 4, greet: 0, msg: "היי" }, { low: 4, greet: 0, msg: "יש תשובה?" },
    { low: 4, greet: 0, msg: "מה קורה פה" }, { low: 4, greet: 0, msg: "אני רוצה לקבוע תור" },
    { low: 0, greet: 0, msg: "היי" }, { low: 2, greet: 0, msg: "חכלגצג" },
    { low: 1, greet: 0, msg: "היי" }, { low: 2, greet: 0, msg: "את פה?" },
    { low: 0, greet: GREETING_DETERMINISTIC_AT, msg: "היי" },
    { low: 0, greet: 0, msg: "חבצב\nאת פה?" }, { low: 0, greet: 0, msg: "אני רוצה\nלקבוע פן" },
    { low: 2, greet: 0, msg: "כמה עולה פן?" }, { low: 3, greet: 0, msg: "יש חניה?" },
  ].map((r) => ({ ...r, action: pa(r.low, r.greet, r.msg) })));
  // lowSignalKind labels per (intent, message) + whether each counts toward quiet mode.
  add("lowSignal.kind", [
    { intent: "smalltalk", appt: "NONE", action: false, msg: "מה נשמע" },
    { intent: "meta", appt: "NONE", action: false, msg: "אתה בוט?" },
    { intent: "unclear", appt: "NONE", action: false, msg: "חכלגצג" },
    { intent: "unclear", appt: "NONE", action: false, msg: "בלה בלה משהו" },
    { intent: "faq", appt: "NONE", action: false, msg: "יש חניה" },
    { intent: "booking", appt: "BOOK", action: true, msg: "אני רוצה פן" },
  ].map((r) => {
    const kind = lowSignalKind(mkDec(mkU(r.intent, r.appt, r.action)), r.msg, SERVICES);
    return { msg: r.msg, intent: r.intent, kind, counts: countsTowardQuiet(kind) };
  }));

  // ── EVIDENCE GATE & BOOKING SIGNAL (BUG-004) ────────────────────────────────────
  // Gibberish + a hallucinated BOOK is downgraded to non-actionable + low-signal.
  add("evidence.gibberish_downgrades", ["חכלגצג", "חבצב", "חגלגגצמגמד"].map((g) => {
    const u = mkU("booking", "BOOK", true);
    const ev = applyBookingEvidenceGate(u, g, SERVICES);
    return {
      msg: g, evidence: ev.evidence, reason: ev.reason,
      action: u.requestsBusinessAction, appt: u.appointmentIntent, intent: u.intent,
      counts: countsTowardQuiet(lowSignalKind(mkDec(u), g, SERVICES)),
    };
  }));
  // A genuine operation with evidence in the message is NOT downgraded.
  {
    const u = mkU("booking", "BOOK", true);
    const ev = applyBookingEvidenceGate(u, "אני רוצה פן", SERVICES);
    add("evidence.genuine_keeps_book", { evidence: ev.evidence, action: u.requestsBusinessAction, appt: u.appointmentIntent });
  }
  // FAQ is productive and untouched by the gate (not an operation).
  {
    const u = mkU("faq", "NONE", false);
    const ev = applyBookingEvidenceGate(u, "יש חניה?", SERVICES);
    add("evidence.faq_untouched", { reason: ev.reason, intent: u.intent });
  }
  // hasBookingSignal: domain verbs + generic nouns + the business's OWN service names;
  // negatives stay false (including the bare-"תור"-inside-"תורה" misfire guard).
  add("evidence.booking_signal", {
    bookVerb: hasBookingSignal("אני רוצה לקבוע", SERVICES),
    serviceName: hasBookingSignal("אני רוצה פן", SERVICES),
    customServiceName: hasBookingSignal("אני רוצה יוגה", ["יוגה"]),
    genericNoun: hasBookingSignal("אשמח לתאם טיפול", SERVICES),
    cancelVerb: hasBookingSignal("אני רוצה לבטל", SERVICES),
    smalltalk: hasBookingSignal("מה שלומך?", SERVICES),
    torahNotTor: hasBookingSignal("אני לומד תורה", SERVICES),
    empty: hasBookingSignal("", SERVICES),
  });

  // ── TURN-KIND DETECTORS ─────────────────────────────────────────────────────────
  const labelMap = (msgs: string[], fn: (m: string) => boolean) =>
    Object.fromEntries(msgs.map((m) => [m, fn(m)]));
  add("turnKind.emoji_only", labelMap(
    ["🙏🏻", "🥹", "😊😊😊", "👍", "🙂!", "תודה 😊", "אני רוצה תור 😊", "היי", "חכלגצג"],
    (m) => isEmojiOnly(m)));
  add("turnKind.noise", labelMap(
    ["כ", "ח", "....", "לגךדכחע", "חכלגתד", "כללסתג",
      "אני רוצה פן", "אפשר לקבוע תור", "יש חניה", "מה נשמע", "שלום", "מחר", "כן", "תודה"],
    (m) => looksLikeNoise(m, SERVICES)));
  add("turnKind.greeting_meta", labelMap(
    ["היי", "שלום", "מה קורה?", "הלו?", "יש תשובה?", "למה לא ענית?", "מה קורה פה?", "את פה?",
      "אני רוצה לקבוע תור", "יש חניה", "כמה עולה תספורת", "חכלגצג"],
    (m) => looksLikeGreetingOrMeta(m, SERVICES)));

  // ── AGGREGATION (lib/message-handler.ts, lib/booking/flow.ts, lib/config.ts) ─────
  const agg = (rows: string[], fallback: string) =>
    aggregateBurst(mkBurstDb(null, rows.map((body) => ({ body }))), "b", "c", "2026-06-15T10:00:00Z", fallback);
  add("aggregation.burst_join", {
    fragmentedBooking: await agg(["אני רוצה", "לקבוע פן"], "FB"),
    fragmentedFaq: await agg(["מה המחיר", "של פן"], "FB"),
    greetingSplit: await agg(["היי", "מה קורה?"], "FB"),
    single: await agg(["שלום"], "FALLBACK_MSG"),
  });
  add("aggregation.has_newer", {
    newer: await hasNewerInbound(mkSerialDb(["2026-06-15T10:00:01Z"]), "b", "c", "2026-06-15T10:00:00Z"),
    noNewer: await hasNewerInbound(mkSerialDb([]), "b", "c", "2026-06-15T10:00:00Z"),
    nullAnchor: await hasNewerInbound(mkSerialDb(["x"]), "b", "c", null),
  });
  // 3-fragment burst serialization: exactly ONE fragment has no newer inbound → one proceeds.
  {
    const fragTimes = ["2026-06-16T10:00:00.000Z", "2026-06-16T10:00:00.700Z", "2026-06-16T10:00:01.400Z"];
    let proceeds = 0;
    for (const ti of fragTimes) if (!(await hasNewerInbound(mkSerialDb(fragTimes), "b", "c", ti))) proceeds++;
    add("aggregation.burst_serializes_to_one", proceeds);
  }
  // Debounce config (default 2000 / "0" disables / explicit / invalid→default / cap 10s).
  {
    const restore = process.env.AGGREGATION_DEBOUNCE_MS;
    delete process.env.AGGREGATION_DEBOUNCE_MS; const dDefault = getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "0"; const dZero = getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "1500"; const dSet = getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "abc"; const dBad = getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "999999"; const dCap = getAggregationDebounceMs();
    if (restore === undefined) delete process.env.AGGREGATION_DEBOUNCE_MS; else process.env.AGGREGATION_DEBOUNCE_MS = restore;
    add("aggregation.debounce_config", { default: dDefault, zero: dZero, set: dSet, invalid: dBad, cap: dCap });
  }

  // ── HISTORY HYGIENE (isKnownFallbackText) ───────────────────────────────────────
  // Every canned low-signal / quiet / error line is filtered from AI-facing history;
  // genuine business answers are NEVER dropped.
  add("history.fallback_text", {
    lowSignalShort: isKnownFallbackText(LOW_SIGNAL_SHORT),
    boundary: isKnownFallbackText(LOW_SIGNAL_BOUNDARY),
    boundaryMale: isKnownFallbackText(LOW_SIGNAL_BOUNDARY.replace("מצליחה", "מצליח")),
    quietReminder: isKnownFallbackText(LOW_SIGNAL_QUIET_REMINDER),
    quietReset: isKnownFallbackText(QUIET_RESET),
    complaintAck: isKnownFallbackText(COMPLAINT_ACK),
    metaFallback: isKnownFallbackText(META_FALLBACK),
    error: isKnownFallbackText(FALLBACK.error),
    overloaded: isKnownFallbackText(FALLBACK.overloaded),
    realBooking: isKnownFallbackText("מעולה, נקבע לך תור לחמישי ב-17:30"),
    realFaq: isKnownFallbackText("שעות הפעילות שלנו הן 9:00-19:00"),
    realService: isKnownFallbackText("כן, אנחנו עושים פן בשמחה"),
  });

  // ── DECISION-SEQUENCE (TEMPORARY composition runner — see banner above) ──────────
  const greet = { action: false, intent: "smalltalk", appt: "NONE" };
  const book = { action: true, intent: "booking", appt: "BOOK" };
  const halBook = { action: true, intent: "booking", appt: "BOOK" }; // hallucinated on gibberish
  add("sequence.greeting_spam", runSequence(Array(8).fill(0).map(() => ({ msg: "היי", stub: greet }))));
  add("sequence.gibberish_recover", runSequence([
    { msg: "חכלגצג", stub: halBook }, { msg: "חבצב", stub: halBook }, { msg: "חכלגתד", stub: halBook },
    { msg: "חבחל", stub: halBook }, { msg: "אני רוצה לקבוע תור", stub: book },
  ]));
  add("sequence.emoji_spam", runSequence(Array(5).fill(0).map(() => ({ msg: "😊" }))));
  add("sequence.booking_burst", runSequence([{ msg: "אני רוצה\nלקבוע פן", stub: book }]));

  // ── persistPlatformState contract (Risks E + F) — recorded, no live write ────────
  {
    const r = mkRecordingDb();
    const wroteSuperseded = await persistPlatformState(r.db, "b", "c", 3, 0, { consecutiveLowSignalTurns: 2 }, async () => true);
    const upsertsAfterSuperseded = r.upserts();
    const wrote = await persistPlatformState(r.db, "b", "c", 4, 1, { consecutiveLowSignalTurns: 2, keepMe: "x" }, async () => false);
    add("persist.contract", {
      supersededWrote: wroteSuperseded, upsertsAfterSuperseded,
      normalWrote: wrote, upsertsTotal: r.upserts(),
      low: r.lastCtx().consecutiveLowSignalTurns, greet: r.lastCtx().consecutiveGreetingTurns,
      mergedField: r.lastCtx().keepMe,
    });
  }
  // Counter readers coerce junk to a safe non-negative integer.
  add("persist.counter_readers", {
    lowValid: readLowSignalCount({ consecutiveLowSignalTurns: 3 }),
    lowNeg: readLowSignalCount({ consecutiveLowSignalTurns: -2 }),
    lowMissing: readLowSignalCount({}),
    lowNaN: readLowSignalCount({ consecutiveLowSignalTurns: "x" as unknown as number }),
    greetValid: readGreetingCount({ consecutiveGreetingTurns: 5 }),
    greetMissing: readGreetingCount({}),
  });
}

// ── Stable, key-sorted serialization so compares never depend on key order ───────
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
const truncate = (s: string, n = 220): string => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main(): Promise<void> {
  const updateGolden = process.argv.includes("--update-golden");
  await buildCases();

  // Re-serialize through JSON so the committed baseline and in-memory values are
  // compared in identical (UTF-8, key-sorted) form.
  const actual: Record<string, unknown> = {};
  for (const c of cases) actual[c.name] = JSON.parse(stableStringify(c.value));

  if (updateGolden) {
    writeFileSync(GOLDEN_PATH, stableStringify(actual) + "\n", "utf8");
    console.log(`[eval] wrote golden baseline: ${cases.length} cases → ${GOLDEN_PATH}`);
    return;
  }

  if (!existsSync(GOLDEN_PATH)) {
    console.error(`[eval] no golden baseline found at ${GOLDEN_PATH}.\n` +
      `[eval] generate it once with:  npm run eval -- --update-golden`);
    process.exit(1);
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, unknown>;
  const diffs: Array<{ name: string; expected: string; actual: string }> = [];
  const goldenKeys = new Set(Object.keys(golden));

  for (const c of cases) {
    const a = stableStringify(actual[c.name]);
    const e = c.name in golden ? stableStringify(golden[c.name]) : "<MISSING IN GOLDEN>";
    if (a !== e) diffs.push({ name: c.name, expected: e, actual: a });
    goldenKeys.delete(c.name);
  }
  // A case that exists in golden but not in this run is also a drift (removed/renamed).
  for (const stale of goldenKeys) diffs.push({ name: stale, expected: stableStringify(golden[stale]), actual: "<MISSING IN RUN>" });

  // ── One-screen report ───────────────────────────────────────────────────────────
  const sections = new Map<string, { total: number; pass: number }>();
  for (const c of cases) {
    const sec = c.name.split(".")[0];
    const s = sections.get(sec) ?? { total: 0, pass: 0 };
    s.total++;
    if (!diffs.some((d) => d.name === c.name)) s.pass++;
    sections.set(sec, s);
  }
  console.log("══════════════ Reliability golden eval (deterministic · 0 network · 0 DB writes) ══════════════");
  for (const [sec, s] of sections) {
    console.log(`  ${s.pass === s.total ? "✓" : "✗"} ${sec.padEnd(12)} ${s.pass}/${s.total}`);
  }
  const passed = cases.length - diffs.filter((d) => cases.some((c) => c.name === d.name)).length;
  console.log("────────────────────────────────────────────────────────────────────────────────────────────");
  console.log(`  ${diffs.length === 0 ? "PASS ✓" : "FAIL ✗"}  ${passed}/${cases.length} golden cases match` +
    (diffs.length ? `  (${diffs.length} diff${diffs.length === 1 ? "" : "s"})` : "  (expected: 0 diffs)"));

  if (diffs.length > 0) {
    console.log("\n  Per-case diffs (input encoded in the case name → expected vs actual):");
    for (const d of diffs) {
      console.log(`\n  ▸ ${d.name}`);
      console.log(`      expected: ${truncate(d.expected)}`);
      console.log(`      actual:   ${truncate(d.actual)}`);
    }
    console.log(`\n  If this change is INTENTIONAL, regenerate the baseline and review the git diff:`);
    console.log(`      npm run eval -- --update-golden`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("EVAL ERROR:", e instanceof Error ? e.message : String(e)); process.exit(1); });

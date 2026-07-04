// scripts/audit-unsolicited-sends.ts
// READ-ONLY audit: scans the messages log and flags any CONVERSATIONAL (reactive) outbound that has no
// inbound from the same customer within N seconds before it — the "no unsolicited send" invariant. A
// reusable "prove / disprove a ghost-reply claim" tool. Never writes.
//
// Run:
//   node --env-file=.env.local --import tsx scripts/audit-unsolicited-sends.ts \
//     [--customer <uuid>] [--since 2026-07-03T00:00:00Z] [--until 2026-07-04T00:00:00Z] [--gap-seconds 300]
//
// Uses the SAME pure classifier the runtime chokepoint uses (lib/booking/outbound-audit.ts), so the
// offline verdict matches production exactly.

import { supabaseServer } from "../lib/supabase/server";
import { getDefaultBusinessId } from "../lib/config";
import {
  classifyOutbound, DEFAULT_MAX_SOLICIT_GAP_MS, type OutboundVerdict,
} from "../lib/booking/outbound-audit";
import type { OutboundSource } from "../lib/booking/outbound";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function maskPhoneLast4(phone: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : "••••";
}

interface Row {
  id: string;
  customer_id: string | null;
  direction: string;
  created_at: string;
  source: string | null;
  reason: string | null;
  meta_message_id: string | null;
  to_phone: string | null;
}

async function main(): Promise<void> {
  const db = supabaseServer();
  const businessId = arg("business") || getDefaultBusinessId();
  const customer = arg("customer");
  const since = arg("since") || new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const until = arg("until") || new Date().toISOString();
  const gapMs = (Number(arg("gap-seconds")) || DEFAULT_MAX_SOLICIT_GAP_MS / 1000) * 1000;

  console.log("=== audit-unsolicited-sends (read-only) ===");
  console.log(`business=${businessId} customer=${customer ?? "(all)"} since=${since} until=${until} gapMs=${gapMs}`);

  let q = db
    .from("messages")
    .select("id, customer_id, direction, created_at, source, reason, meta_message_id, to_phone")
    .eq("business_id", businessId)
    .gte("created_at", since)
    .lte("created_at", until)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (customer) q = q.eq("customer_id", customer);

  const { data, error } = await q;
  if (error) { console.error("query failed:", error.message); process.exitCode = 1; return; }
  const rows = (data ?? []) as Row[];

  // Walk chronologically, tracking the last inbound time per customer.
  const lastInboundAt = new Map<string, number>();
  const tally: Record<OutboundVerdict, number> = { solicited: 0, unsolicited: 0, exempt: 0, unknown_source: 0 };
  const flagged: Array<{ t: string; verdict: OutboundVerdict; source: string; reason: string; gapMs: string; wamid: string; phone: string; customer: string }> = [];

  for (const r of rows) {
    if (!r.customer_id) continue;
    if (r.direction === "inbound") {
      lastInboundAt.set(r.customer_id, new Date(r.created_at).getTime());
      continue;
    }
    // outbound
    const nowMs = new Date(r.created_at).getTime();
    const lastMs = lastInboundAt.has(r.customer_id) ? lastInboundAt.get(r.customer_id)! : null;
    const source = (r.source ?? "unknown") as OutboundSource;
    const verdict = classifyOutbound({ source, lastInboundAtMs: lastMs, nowMs, maxGapMs: gapMs });
    tally[verdict]++;
    if (verdict === "unsolicited" || verdict === "unknown_source") {
      flagged.push({
        t: new Date(r.created_at).toISOString(),
        verdict, source: r.source ?? "unknown", reason: r.reason ?? "-",
        gapMs: lastMs === null ? "none" : String(nowMs - lastMs),
        wamid: lastInboundAt.has(r.customer_id) ? "(see prior inbound)" : "none",
        phone: maskPhoneLast4(r.to_phone), customer: r.customer_id,
      });
    }
  }

  console.log(
    `\nrows=${rows.length} outbound verdicts: solicited=${tally.solicited} exempt=${tally.exempt}` +
    ` unsolicited=${tally.unsolicited} unknown_source=${tally.unknown_source}`
  );
  if (flagged.length === 0) {
    console.log("\n✓ No unsolicited / unclassified reactive sends in range.");
  } else {
    console.log(`\n⚠ ${flagged.length} flagged send(s):`);
    for (const f of flagged) {
      console.log(
        `  [${f.verdict}] ${f.t} src=${f.source} reason=${f.reason} gapMs=${f.gapMs}` +
        ` phone=${f.phone} customer=${f.customer}`
      );
    }
  }
  process.exitCode = flagged.length > 0 ? 2 : 0; // 2 = flags found (audit signal, not a crash)
}

void main();

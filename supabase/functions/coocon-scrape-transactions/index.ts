// supabase/functions/coocon-scrape-transactions/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isasDecrypt } from "./seed-cbc.ts";

/* ================= Types ================= */

type Direction = "IN" | "OUT";

type Body = {
  eventId: string;
  scrapeAccountId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  cooconOutput?: unknown;
  decryptParams?: {
    uid?: string;
    action?: string;
  };
  accountNumber?: string;
  accountMasked?: string;
  bankCode?: string;

  // (optional) 프론트가 넘겨줄 수도 있는 ceremonyDate (YYYY-MM-DD)
  // 없으면 서버에서 event_settings.ceremony_date를 조회해서 사용
  ceremonyDate?: string;
};

type NormalizedTx = {
  event_id: string;
  scrape_account_id: string;

  tx_date: string; // YYYY-MM-DD
  tx_time: string | null; // HH:mm:ss | null

  amount: number; // always +
  direction: Direction;

  balance: number | null;
  memo: string | null;
  counterparty: string | null;
  sender: string | null;

  tx_hash: string;
  raw_json: unknown | null;
};

/* ================= CORS ================= */

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/* ================= Utils ================= */

function isYmd(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normalizeDateYmd(input: unknown): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;

  if (isYmd(s)) return s;

  if (/^\d{8}$/.test(s)) {
    const out = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return isYmd(out) ? out : null;
  }

  const m = s.match(/^(\d{4})[./-](\d{2})[./-](\d{2})$/);
  if (m) {
    const out = `${m[1]}-${m[2]}-${m[3]}`;
    return isYmd(out) ? out : null;
  }

  return null;
}

function normalizeTimeHms(input: unknown): string | null {
  if (input == null) return null;
  const t = String(input).trim();
  if (!t) return null;
  if (/^\d{6}$/.test(t)) return `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t;
  if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`;
  return null;
}

function normalizeAmount(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).replace(/[^\d.-]/g, "");
  if (!s || s === "-") return 0;
  const n = Number(s);
  return isNaN(n) ? 0 : Math.abs(n);
}

function normalizeDirection(v: unknown): Direction {
  const s = String(v ?? "").toUpperCase();
  if (s.includes("출금") || s.includes("OUT") || s.includes("-")) return "OUT";
  return "IN";
}

// ✅ Deterministic Hash Generation for Deduplication
async function generateTxHash(
  date: string,
  time: string | null,
  amount: number,
  balance: number | null,
  sender: string | null,
  memo: string | null
): Promise<string> {
  const raw = [
    date,
    time ?? "00:00:00",
    amount,
    balance ?? "0",
    (sender ?? "").trim(),
    (memo ?? "").trim(),
  ].join("|");

  const msgUint8 = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

/* ================= Normalize Coocon ================= */

async function normalizeFromCooconOutput(
  eventId: string,
  scrapeAccountId: string,
  cooconOutput: any,
  decryptParams?: { uid?: string; action?: string },
  log: (msg: string, data?: any) => void = console.log
): Promise<NormalizedTx[]> {
  if (!cooconOutput) {
    log("[ERROR] cooconOutput is null or undefined");
    return [];
  }

  log("[normalizeFromCooconOutput] Starting normalization...");

  let processedOutput = cooconOutput;

  // 1) Decryption phase (서버에서 다시 한 번 복호화 가능하도록 유지)
  if (cooconOutput?.Output?.Result && typeof cooconOutput.Output.Result === "string") {
    if (decryptParams?.uid && decryptParams?.action) {
      try {
        const decryptedStr = await isasDecrypt(
          cooconOutput.Output.Result,
          decryptParams.uid,
          decryptParams.action
        );

        try {
          const decryptedResult = JSON.parse(decryptedStr);
          processedOutput = {
            ...cooconOutput,
            Output: {
              ...cooconOutput.Output,
              Result: decryptedResult,
            },
          };
          log("[INFO] Decryption and JSON parse successful");
        } catch (jsonErr: any) {
          log("[ERROR] Decrypted string is not valid JSON:", {
            error: jsonErr.message,
            preview: String(decryptedStr).substring(0, 120),
          });
          throw jsonErr;
        }
      } catch (e: any) {
        log("[ERROR] Decryption failed:", e?.message || String(e));
        // 계속 진행 (다만 결과는 비어있을 가능성 큼)
      }
    } else {
      log("[WARN] Encrypted Result found but decryptParams (uid/action) is missing");
    }
  }

  // 2) Root extraction
  const root =
    processedOutput?.Result ??
    processedOutput?.Output?.Result ??
    processedOutput?.Output ??
    processedOutput;

  if (!root || typeof root !== "object") {
    log("[ERROR] Could not find root object in processedOutput", {
      keys: Object.keys(processedOutput || {}),
    });
    return [];
  }

  const candidateLists: any[][] = [];
  const keys = [
    "ResultList",
    "List",
    "TX_LIST",
    "txList",
    "Data",
    "rows",
    "items",
    "수시거래내역조회",
    "거래내역조회",
  ];

  if (Array.isArray(root)) candidateLists.push(root);

  for (const k of keys) {
    if (Array.isArray((root as any)?.[k])) {
      log(`[INFO] Found transaction list in key: ${k}`);
      candidateLists.push((root as any)[k]);
    }
  }

  if ((root as any)?.Result && typeof (root as any).Result === "object") {
    const nested = (root as any).Result;
    if (Array.isArray(nested)) candidateLists.push(nested);

    for (const k of keys) {
      if (Array.isArray(nested?.[k])) {
        log(`[INFO] Found transaction list in nested Result key: ${k}`);
        candidateLists.push(nested[k]);
      }
    }
  }

  const list = candidateLists.find((l) => Array.isArray(l) && l.length > 0);
  if (!list) {
    log("[ERROR] No transaction lists found. Root keys:", Object.keys(root as any));
    return [];
  }

  // 3) Row normalize
  const out: NormalizedTx[] = [];
  let rowIdx = 0;
  let skipLogged = 0;
  const MAX_SKIP_LOGS = 15;

  for (const r of list) {
    try {
      rowIdx++;

      const tx_date = normalizeDateYmd(
        (r as any).tx_date ?? (r as any).TRN_DT ?? (r as any).거래일자 ?? (r as any).거래일
      );
      if (!tx_date) {
        log(`[WARN] Skipping row ${rowIdx}: missing or invalid tx_date`, r);
        continue;
      }

      const tx_time = normalizeTimeHms(
        (r as any).tx_time ??
          (r as any).TRN_TM ??
          (r as any).거래시각 ??
          (r as any).거래시간 ??
          null
      );

      const depositAmount = normalizeAmount((r as any).입금액 ?? (r as any).amount_in ?? 0);
      const withdrawAmount = normalizeAmount((r as any).출금액 ?? (r as any).amount_out ?? 0);

      let amount = 0;
      let direction: Direction = "OUT";

      if (depositAmount > 0) {
        amount = depositAmount;
        direction = "IN";
      } else if (withdrawAmount > 0) {
        amount = withdrawAmount;
        direction = "OUT";
      } else {
        amount = normalizeAmount((r as any).amount ?? (r as any).TRN_AMT ?? (r as any).거래금액);
        direction = normalizeDirection((r as any).direction ?? (r as any).입출금구분 ?? "");
      }

      // ✅ deposit-only filter
      if (direction !== "IN" || amount <= 0) {
        if (skipLogged < MAX_SKIP_LOGS) {
          log(
            `[SKIP] Row ${rowIdx} filtered (deposit-only). dir=${direction} amount=${amount} dep=${depositAmount} wd=${withdrawAmount}`,
            {
              tx_date,
              tx_time,
              memo: (r as any).memo ?? (r as any).적요 ?? (r as any).기재사항2 ?? null,
              sender: (r as any).sender ?? (r as any).기재사항1 ?? null,
            }
          );
          skipLogged++;
        }
        continue;
      }

      const balance = normalizeAmount(
        (r as any).balance ?? (r as any).TRN_BAL ?? (r as any).거래후잔액 ?? (r as any).잔액 ?? null
      );

      const memo = ((r as any).memo ?? (r as any).기재사항2 ?? (r as any).적요 ?? null) as
        | string
        | null;

      const sender = ((r as any).sender ??
        (r as any).기재사항1 ??
        (r as any).counterparty ??
        (r as any).상대방 ??
        null) as string | null;

      const tx_hash = await generateTxHash(tx_date, tx_time, amount, balance, sender, memo);

      out.push({
        event_id: eventId,
        scrape_account_id: scrapeAccountId,
        tx_date,
        tx_time,
        amount,
        direction,
        balance: balance || null,
        memo,
        counterparty: sender,
        sender,
        tx_hash,
        raw_json: r,
      });
    } catch (rowErr: any) {
      log(`[ERROR] Failed to normalize row ${rowIdx}:`, { error: rowErr?.message, raw: r });
    }
  }

  log(`[SUMMARY] Total input rows: ${list.length}, Normalized deposit rows: ${out.length}, Skip logs emitted: ${skipLogged}`);
  return out;
}

/* ================= Main ================= */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = (await req.json()) as Partial<Body>;

    if (!body.eventId || !body.scrapeAccountId || !body.startDate || !body.endDate) {
      return json({ error: "Missing required fields" }, 400);
    }

    if (!isYmd(body.startDate) || !isYmd(body.endDate)) {
      return json({ error: "Invalid date format" }, 400);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    /* ================= Logging setup ================= */
    const debugLogs: string[] = [];
    const log = (msg: string, data?: any) => {
      const line = data ? `${msg} ${JSON.stringify(data)}` : msg;
      console.log(line);
      debugLogs.push(line);
    };

    log("[coocon-scrape-transactions] Processing request:", {
      eventId: body.eventId,
      scrapeAccountId: body.scrapeAccountId,
      startDate: body.startDate,
      endDate: body.endDate,
      hasDecryptParams: !!(body.decryptParams?.uid && body.decryptParams?.action),
      hasCooconOutput: !!body.cooconOutput,
      hasBodyCeremonyDate: !!body.ceremonyDate,
    });

    /* ✅ ceremony_date 결정: (1) body.ceremonyDate 우선 (2) event_settings 조회 */
    let ceremonyDate: string | null = null;

    const bodyCeremonyDate = body.ceremonyDate && isYmd(body.ceremonyDate) ? body.ceremonyDate : null;
    if (bodyCeremonyDate) {
      ceremonyDate = bodyCeremonyDate;
      log("[INFO] ceremony_date from body:", ceremonyDate);
    } else {
      const { data: eventSettings, error: settingsErr } = await admin
        .from("event_settings")
        .select("ceremony_date")
        .eq("event_id", body.eventId)
        .maybeSingle();

      if (settingsErr) log("[WARN] Failed to fetch event_settings:", settingsErr);

      ceremonyDate = (eventSettings?.ceremony_date as string | null) ?? null;

      if (!ceremonyDate) log("[WARN] ceremony_date is null – ledger will not be filtered by date");
      else log("[INFO] ceremony_date resolved from event_settings:", ceremonyDate);
    }

    /* 1️⃣ Normalize */
    const normalized = await normalizeFromCooconOutput(
      body.eventId,
      body.scrapeAccountId,
      body.cooconOutput,
      body.decryptParams,
      log
    );

    /* 2️⃣ Upsert into event_scrape_transactions (중복 방어: unique index (scrape_account_id, tx_hash)) */
    let insertedTx = 0;
    let insertedLedger = 0;

    if (normalized.length > 0) {
      const onConflict = "scrape_account_id,tx_hash";

      const { error: upsertErr, count } = await admin
        .from("event_scrape_transactions")
        .upsert(normalized, {
          onConflict,
          ignoreDuplicates: true,
          count: "exact",
        });

      if (upsertErr) {
        log("[UPSERT ERROR]", upsertErr);
        throw new Error(
          `transaction upsert failed (onConflict=${onConflict}): ${upsertErr.message}`
        );
      }

      insertedTx = count ?? normalized.length;

      /* 3️⃣ event_ledger_entries 자동 추가 (중복 방지) */
      // scrape_account_id -> event_scrape_accounts.event_account_id
      const { data: scrapeAccount, error: scrapeErr } = await admin
        .from("event_scrape_accounts")
        .select("event_account_id")
        .eq("id", body.scrapeAccountId)
        .maybeSingle();

      if (scrapeErr) log("[WARN] Failed to fetch scrape account:", scrapeErr);

      if (scrapeAccount?.event_account_id) {
        // event_account_id -> event_accounts.owner_member_id
        const { data: eventAccount, error: accountErr } = await admin
          .from("event_accounts")
          .select("owner_member_id")
          .eq("id", scrapeAccount.event_account_id)
          .maybeSingle();

        if (accountErr) log("[WARN] Failed to fetch event account:", accountErr);

        if (eventAccount?.owner_member_id) {
          let txQuery = admin
            .from("event_scrape_transactions")
            .select("id, tx_hash, sender, amount, memo, tx_date")
            .eq("scrape_account_id", body.scrapeAccountId)
            .in(
              "tx_hash",
              normalized.map((tx) => tx.tx_hash)
            );

          // ✅ 핵심: ledger로 넘어갈 때는 "예식 당일"만 (ceremonyDate가 있으면)
          if (ceremonyDate) txQuery = txQuery.eq("tx_date", ceremonyDate);

          const { data: candidateTxs, error: txQueryErr } = await txQuery;

          if (txQueryErr) {
            log("[WARN] Failed to query candidate transactions for ledger:", txQueryErr);
          } else if (candidateTxs && candidateTxs.length > 0) {
            const ledgerEntries = candidateTxs.map((tx: any) => ({
              event_id: body.eventId,
              owner_member_id: eventAccount.owner_member_id,
              scrape_transaction_id: tx.id,
              guest_name: tx.sender || "입금자 미상",
              attended: true,
              gift_amount: tx.amount,
              gift_method: "account" as const,
              created_source: "scrape" as const,
              memo: tx.memo ?? null,
            }));

            // 중복 체크: scrape_transaction_id 기준
            const ids = ledgerEntries
              .map((e: any) => e.scrape_transaction_id)
              .filter(Boolean);

            const existingIds = new Set<string>();
            if (ids.length > 0) {
              const { data: existingEntries, error: existingErr } = await admin
                .from("event_ledger_entries")
                .select("scrape_transaction_id")
                .in("scrape_transaction_id", ids);

              if (existingErr) log("[WARN] Failed to query existing ledger entries:", existingErr);

              if (existingEntries) {
                existingEntries.forEach((e: any) => {
                  if (e.scrape_transaction_id) existingIds.add(e.scrape_transaction_id);
                });
              }
            }

            const newEntries = ledgerEntries.filter(
              (e: any) => !existingIds.has(e.scrape_transaction_id)
            );

            if (newEntries.length > 0) {
              const { error: ledgerErr, count: ledgerCount } = await admin
                .from("event_ledger_entries")
                .insert(newEntries, { count: "exact" });

              if (ledgerErr) {
                log("[WARN] Failed to insert ledger entries:", ledgerErr);
              } else {
                insertedLedger = ledgerCount ?? newEntries.length;
                log(
                  `[SUCCESS] Inserted ${insertedLedger} new ledger entries (skipped ${ledgerEntries.length - newEntries.length} duplicates)`
                );
              }
            } else {
              log("[INFO] All candidate transactions already exist in ledger");
            }
          } else {
            log("[INFO] No candidate transactions for ledger (likely none on ceremonyDate)");
          }
        } else {
          log("[WARN] No owner_member_id found for event_account");
        }
      } else {
        log("[WARN] No event_account_id found for scrape_account");
      }
    } else {
      log("[INFO] normalized list is empty (nothing to upsert)");
    }

    return json({
      ok: true,
      fetched: normalized.length,
      insertedTx,
      insertedLedger,
      startDate: body.startDate,
      endDate: body.endDate,
      ceremonyDate,
      debugLogs,
    });
  } catch (e: any) {
    console.error("[ERROR]", e);
    return json({ error: "Unhandled", detail: String(e?.message ?? e) }, 500);
  }
});

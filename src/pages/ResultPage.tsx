// src/pages/ResultPage.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";
import * as XLSX from "xlsx";

type RouteParams = {
  eventId: string;
  [key: string]: string | undefined;
};

type MessageRow = {
  id: string;
  created_at: string;
  side: string | null;
  guest_name: string | null;
  nickname: string | null;
  relationship: string | null;
  body: string;
};

type Recipient = {
  name: string;
  role: string;
  contact: string;
};

type EventSettingsLite = {
  ceremony_date: string | null;
  ceremony_start_time: string | null;
  ceremony_end_time: string | null;
  recipients: Recipient[] | null;
  media_urls?: string[] | null; // ✅ event_settings.media_urls (첫번째 사진을 메시지탭 배경으로)
};

type TabKey = "messages" | "ledger";

type GiftMethod = "account" | "cash" | "unknown";
type CreatedSource = "manual" | "guestpage" | "import" | "scrape";

type LedgerRow = {
  id: string;
  event_id: string;
  owner_member_id: string;

  side: "groom" | "bride" | null;

  guest_name: string;
  relationship: string | null;
  guest_phone: string | null;

  attended: boolean | null;
  attended_at: string | null;

  gift_amount: number | null;
  gift_method: GiftMethod;

  ticket_count: number;
  return_given: boolean;
  thanks_done: boolean;
  memo: string | null;

  created_source?: CreatedSource | null;
  scrape_transaction_id?: string | null;

  // Joined data
  event_scrape_transactions?: {
    tx_date: string;
  } | null;

  updated_at: string;
  created_at: string;
};

type TransactionRow = {
  id: string;
  event_id: string;
  scrape_account_id: string;
  tx_date: string;
  tx_time: string | null;
  amount: number;
  direction: "IN" | "OUT";
  balance: number | null;
  memo: string | null;
  sender: string | null;
  counterparty: string | null;
  is_reflected: boolean | null;
  created_at: string;
};

const PAGE_SIZE = 10;

function sourceLabel(src?: string | null) {
  if (src === "import") return "엑셀 업로드";
  if (src === "manual") return "빠른추가";
  if (src === "guestpage") return "현장 QR";
  if (src === "scrape") return "QR 축의금";
  return "빠른추가";
}

function onlyDigits(s: string) {
  return (s ?? "").replace(/\D/g, "");
}

function formatKoreanMobile(input: string) {
  const d = onlyDigits(input).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

function normalizeBool(v: any): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (["y", "yes", "true", "1", "o", "ok", "참석", "출석", "참"].includes(s)) return true;
  if (["n", "no", "false", "0", "x", "불참", "미참석", "불출석", "미참"].includes(s)) return false;
  return null;
}

function normalizeGiftMethod(v: any): GiftMethod {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("현금") || s === "cash") return "cash";
  if (s.includes("계좌") || s.includes("이체") || s === "account") return "account";
  return "unknown";
}

function normalizeSide(v: any): "groom" | "bride" | "" {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("신랑") || s === "groom") return "groom";
  if (s.includes("신부") || s === "bride") return "bride";
  return "";
}

function sideToDb(side: "groom" | "bride" | null): boolean | null {
  if (side === "groom") return true;
  if (side === "bride") return false;
  return null;
}

function sideFromDb(value: any): "groom" | "bride" | null {
  if (value === true) return "groom";
  if (value === false) return "bride";
  return null;
}

function toIsoMaybe(v: any): string | null {
  if (!v) return null;
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    const js = new Date(d.y, (d.m ?? 1) - 1, d.d ?? 1, d.H ?? 0, d.M ?? 0, d.S ?? 0);
    return js.toISOString();
  }
  const s = String(v).trim();
  if (!s) return null;

  const asDate = new Date(s);
  if (!isNaN(asDate.getTime())) return asDate.toISOString();

  return null;
}

function safeNumber(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && !isNaN(v)) return v;
  const d = onlyDigits(String(v));
  if (!d) return null;
  const n = Number(d);
  return isNaN(n) ? null : n;
}

function yyyymmdd(dateStr?: string | null) {
  const d = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${da}`;
}

function formatKSTTime(iso?: string | null) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function safeFilenamePart(s: string) {
  return (s ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

// 간단 해시(카드 랜덤 느낌 고정)
function hash01(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 0..1
  return ((h >>> 0) % 1000) / 1000;
}

const ADMIN_EMAIL =
  (import.meta as any).env?.VITE_ADMIN_EMAIL || "goraeuniverse@gmail.com";

export default function ResultPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { eventId } = useParams<RouteParams>();

  const asMemberId = useMemo(() => {
    try {
      return new URLSearchParams(location.search).get("asMemberId");
    } catch {
      return null;
    }
  }, [location.search]);

  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [settings, setSettings] = useState<EventSettingsLite | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 메시지 액션
  const [messagesLoading, setMessagesLoading] = useState(false);

  // ✅ 메시지 탭 캡처(모바일 이미지 저장)
  const [savingImage, setSavingImage] = useState(false);
  const messageStageRef = useRef<HTMLDivElement | null>(null);

  // 스크래핑
  const [scrapeAccountId, setScrapeAccountId] = useState<string | null>(null);
  const [txCount, setTxCount] = useState<number>(0);
  const [scraping, setScraping] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<string | null>(null);

  // ✅ 마지막 업데이트(스크래핑 최신 created_at)
  const [lastTxCreatedAt, setLastTxCreatedAt] = useState<string | null>(null);

  // 탭/페이지
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<TabKey>("ledger");

  // 장부(원장)
  const [ownerMemberId, setOwnerMemberId] = useState<string | null>(null);
  const [ownerRole, setOwnerRole] = useState<string | null>(null);
  const [ownerLabel, setOwnerLabel] = useState<string>("내");
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  // ✅ 로그인 사용자(엑셀 파일명/내 메시지 필터)
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);

  // ✅ 관리자 뷰 전환: 이 이벤트의 멤버 옵션
  const [memberOptions, setMemberOptions] = useState<
  { id: string; role: string | null; user_id: string | null }[]
  >([]);


  const isAdmin = useMemo(() => {
    return !!ownerEmail && ownerEmail.toLowerCase() === String(ADMIN_EMAIL).toLowerCase();
  }, [ownerEmail]);

  // 거래내역(현재 UI에선 주석/비표시지만, lastTxCreatedAt 계산용으로 유지)
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);

  // ✅ (중요) 최신 ledger row를 ref에 보관 (stale 방지)
  const ledgerRef = useRef<Record<string, LedgerRow>>({});
  useEffect(() => {
    const map: Record<string, LedgerRow> = {};
    for (const r of ledger) map[r.id] = r;
    ledgerRef.current = map;
  }, [ledger]);

  // ✅ 자동 저장(디바운스) 큐
  const saveTimersRef = useRef<Record<string, number>>({});
  const pendingSaveIdsRef = useRef<Set<string>>(new Set());

  // 장부 필터/검색
  const [q, setQ] = useState("");
  const [onlyAttended, setOnlyAttended] = useState(false);

  // 장부 수기 추가
  const [newName, setNewName] = useState("");
  const [newRelOption, setNewRelOption] = useState("친구");
  const [newRelCustom, setNewRelCustom] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newAttended, setNewAttended] = useState<boolean | null>(null);

  // Excel UI
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [excelHelpOpen, setExcelHelpOpen] = useState(false);
  const [excelUploading, setExcelUploading] = useState(false);
  const [excelUploadResult, setExcelUploadResult] = useState<string | null>(null);

  /* ------------------ 내 member id 찾기 ------------------ */
  async function resolveOwnerMemberId(overrideMemberId?: string | null): Promise<string | null> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;

  const user = authData.user;
  const email = user.email ?? null;

  setOwnerEmail(email);
  setOwnerUserId(user.id ?? null);

  const isAdminNow = !!email && email.toLowerCase() === String(ADMIN_EMAIL).toLowerCase();

  // ✅ 1) ADMIN + asMemberId 있으면: 그 멤버로 보기
  if (isAdminNow && overrideMemberId) {
    try {
      const { data: m, error: mErr } = await supabase
        .from("event_members")
        .select("id, role, user_id")
        .eq("event_id", eventId)
        .eq("id", overrideMemberId)
        .maybeSingle();

      if (mErr) throw mErr;

      const role = (m as any)?.role ?? null;
      const uid = (m as any)?.user_id ?? null;

      // admin view에서는 groom/bride 필터링 안 걸리게 null 처리
      setOwnerRole(null);
      setOwnerLabel(
        role
          ? `${role}${uid ? ` • ${String(uid).slice(0, 6)}` : ""}`
          : `멤버${uid ? ` • ${String(uid).slice(0, 6)}` : ""}`
      );

      return overrideMemberId;
    } catch (e) {
      console.error("resolveOwnerMemberId(admin override) error:", e);
      setOwnerRole(null);
      setOwnerLabel("멤버");
      return overrideMemberId;
    }
  }

  // ✅ 2) ADMIN + asMemberId 없으면: 이 이벤트의 owner 멤버를 기본으로 선택
  if (isAdminNow) {
    try {
      // owner 먼저 찾기
      const { data: ownerRow, error: oErr } = await supabase
        .from("event_members")
        .select("id, role, user_id, created_at")
        .eq("event_id", eventId)
        .eq("role", "owner")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (oErr) throw oErr;

      if (ownerRow?.id) {
        const uid = (ownerRow as any).user_id ?? null;
        setOwnerRole(null);
        setOwnerLabel(`owner${uid ? ` • ${String(uid).slice(0, 6)}` : ""}`);
        return ownerRow.id;
      }

      // owner 없으면 첫 멤버
      const { data: firstRow, error: fErr } = await supabase
        .from("event_members")
        .select("id, role, user_id, created_at")
        .eq("event_id", eventId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (fErr) throw fErr;

      if (firstRow?.id) {
        const role = (firstRow as any).role ?? null;
        const uid = (firstRow as any).user_id ?? null;
        setOwnerRole(null);
        setOwnerLabel(`${role || "member"}${uid ? ` • ${String(uid).slice(0, 6)}` : ""}`);
        return firstRow.id;
      }

      setOwnerRole(null);
      setOwnerLabel("멤버");
      return null;
    } catch (e) {
      console.error("resolveOwnerMemberId(admin default) error:", e);
      setOwnerRole(null);
      setOwnerLabel("멤버");
      return null;
    }
  }

  // ✅ 3) 일반 사용자: 기존 로직 유지 (user_id로 내 멤버 찾기)
  const { data, error } = await supabase
    .from("event_members")
    .select("id, role")
    .eq("event_id", eventId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("resolveOwnerMemberId error:", error);
    return null;
  }

  if (data?.id) {
    setOwnerLabel(data.role === "owner" ? "주최" : "내");
    setOwnerRole(data.role ?? null);
    return data.id;
  }

  setOwnerLabel("내");
  setOwnerRole(null);
  return null;
}


  async function refreshTxCount() {
    if (!eventId) return;
    const { count, error } = await supabase
      .from("event_scrape_transactions")
      .select("*", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("is_reflected", true);

    if (!error) setTxCount(count ?? 0);
  }

  // ✅ 마지막 스크래핑 업데이트 시간 (event_scrape_transactions 최신 created_at)
  async function refreshLastTxCreatedAt() {
    if (!eventId) return;
    try {
      // 방향/계좌 제한 없이 "이 이벤트에서 가장 최근 생성된 tx" 기준
      const { data, error } = await supabase
        .from("event_scrape_transactions")
        .select("created_at")
        .eq("event_id", eventId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      setLastTxCreatedAt(data?.created_at ?? null);
    } catch (e) {
      console.error("refreshLastTxCreatedAt error:", e);
      setLastTxCreatedAt(null);
    }
  }

  /* ------------------ 메시지: 새로고침 ------------------ */
  async function refreshMessages() {
    if (!eventId) return;
    setMessagesLoading(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id, created_at, side, guest_name, nickname, relationship, body")
        .eq("event_id", eventId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
    } catch (e) {
      console.error(e);
      alert("메시지를 새로고침하는 중 오류가 발생했어요.");
    } finally {
      setMessagesLoading(false);
    }
  }

  /* ------------------ 데이터 로드 ------------------ */
  useEffect(() => {
    if (!eventId) {
      setError("잘못된 접근입니다.");
      setLoading(false);
      return;
    }

    const fetchAll = async () => {
      setLoading(true);
      setError(null);

      try {
        // 메시지
        const { data: msgData, error: msgError } = await supabase
          .from("messages")
          .select("id, created_at, side, guest_name, nickname, relationship, body")
          .eq("event_id", eventId)
          .order("created_at", { ascending: true });

        if (msgError) throw msgError;
        setMessages(msgData || []);

        // 예식 설정 (+ media_urls)
        const { data: settingsData, error: setErrorRes } = await supabase
          .from("event_settings")
          .select("ceremony_date, ceremony_start_time, ceremony_end_time, recipients, media_urls")
          .eq("event_id", eventId)
          .maybeSingle();

        if (setErrorRes) throw setErrorRes;
        if (settingsData) {
          // media_urls는 jsonb array로 내려오거나(정상), string일 수도 있어서 방어
          let mediaUrls: string[] | null = null;
          const raw = (settingsData as any).media_urls;
          if (Array.isArray(raw)) mediaUrls = raw.filter(Boolean);
          else if (typeof raw === "string" && raw.trim()) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) mediaUrls = parsed.filter(Boolean);
            } catch {
              mediaUrls = null;
            }
          }

          setSettings({
            ceremony_date: settingsData.ceremony_date,
            ceremony_start_time: settingsData.ceremony_start_time ?? null,
            ceremony_end_time: settingsData.ceremony_end_time ?? null,
            recipients: (settingsData.recipients as Recipient[] | null) ?? null,
            media_urls: mediaUrls,
          });
        }

        // 스크래핑 계좌(최신)
        const { data: acc } = await supabase
          .from("event_scrape_accounts")
          .select("id")
          .eq("event_id", eventId)
          .order("verified_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (acc?.id) setScrapeAccountId(acc.id);

        await refreshTxCount();
        await refreshLastTxCreatedAt();

        // ✅ admin이면 이 이벤트의 멤버 옵션 로드(뷰 전환 드롭다운용)
        try {
          const { data: authData } = await supabase.auth.getUser();
          const email = authData?.user?.email ?? null;
          const isAdminNow = !!email && email.toLowerCase() === String(ADMIN_EMAIL).toLowerCase();

          if (!isAdminNow) {
            setMemberOptions([]);
          } else {
            // ✅ [수정포인트 3] name 제거, user_id 포함
            // 1차: created_at 정렬 (있으면 이게 베스트)
            const { data: mems1, error: err1 } = await supabase
              .from("event_members")
              .select("id, role, user_id, created_at")
              .eq("event_id", eventId)
              .order("created_at", { ascending: true });

            if (err1) {
              console.error("[memberOptions] query1 failed:", err1);

              // 2차: created_at 없이 재시도 (created_at 컬럼 없을 때 400 방어)
              const { data: mems2, error: err2 } = await supabase
                .from("event_members")
                .select("id, role, user_id")
                .eq("event_id", eventId);

              if (err2) {
                console.error("[memberOptions] query2 failed:", err2);
                setMemberOptions([]);
              } else {
                setMemberOptions(((mems2 as any[]) ?? []).filter(Boolean));
              }
            } else {
              setMemberOptions(((mems1 as any[]) ?? []).filter(Boolean));
            }
          }
        } catch (e) {
          console.error("admin memberOptions load failed:", e);
          setMemberOptions([]);
        }


        // owner_member_id (✅ admin override 지원)
        const memberId = await resolveOwnerMemberId(asMemberId);
        setOwnerMemberId(memberId ?? null);
      } catch (err) {
        console.error(err);
        setError("리포트를 불러오는 중 오류가 발생했어요.");
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, asMemberId]);

  // ✅ 페이지 복귀/포커스/라우트 변경 시 최신화 (스크래핑 후 returnTo로 돌아온 경우 포함)
  useEffect(() => {
    if (!eventId) return;

    const onFocus = async () => {
      await refreshTxCount();
      await refreshLastTxCreatedAt();
    };
    window.addEventListener("focus", onFocus);

    (async () => {
      await refreshTxCount();
      await refreshLastTxCreatedAt();
    })();

    return () => {
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, location.key]);

  /* ------------------ 장부 로드 ------------------ */
  async function fetchLedgerNow() {
    if (!eventId || !ownerMemberId) return;

    setLedgerLoading(true);
    try {
      const { data, error } = await supabase
        .from("event_ledger_entries")
        .select(
          `
          id, event_id, owner_member_id,
          side, guest_name, relationship, guest_phone,
          attended, attended_at,
          gift_amount, gift_method,
          ticket_count, return_given, thanks_done, memo,
          created_source, scrape_transaction_id,
          created_at, updated_at,
          event_scrape_transactions(tx_date)
        `
        )
        .eq("event_id", eventId)
        .eq("owner_member_id", ownerMemberId)
        .order("updated_at", { ascending: false });

      if (error) throw error;
      const rows =
        (data as any[])?.map((r) => ({
          ...r,
          side: sideFromDb((r as any).side),
        })) ?? [];
      setLedger(rows as LedgerRow[]);
    } catch (e) {
      console.error(e);
    } finally {
      setLedgerLoading(false);
    }
  }

  useEffect(() => {
    if (!eventId || !ownerMemberId) return;
    fetchLedgerNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, ownerMemberId]);

  /* ------------------ 거래내역 로드 ------------------ */
  useEffect(() => {
    if (!eventId || !ownerMemberId) return;

    const fetchTransactions = async () => {
      setTransactionsLoading(true);
      try {
        // 1) 내가 설정한 계좌들 조회
        const { data: myAccounts, error: accountsError } = await supabase
          .from("event_accounts")
          .select("id")
          .eq("event_id", eventId)
          .eq("owner_member_id", ownerMemberId);

        if (accountsError) throw accountsError;
        if (!myAccounts || myAccounts.length === 0) {
          setTransactions([]);
          return;
        }

        const myAccountIds = myAccounts.map((a) => a.id);

        // 2) 내 계좌의 스크래핑 세션들 조회
        const { data: scrapeAccounts, error: scrapeError } = await supabase
          .from("event_scrape_accounts")
          .select("id")
          .in("event_account_id", myAccountIds);

        if (scrapeError) throw scrapeError;
        if (!scrapeAccounts || scrapeAccounts.length === 0) {
          setTransactions([]);
          return;
        }

        const scrapeAccountIds = scrapeAccounts.map((s) => s.id);

        // 3) 거래내역 조회 (입금만 + 예식날짜 필터)
        let query = supabase
          .from("event_scrape_transactions")
          .select("*")
          .in("scrape_account_id", scrapeAccountIds)
          .eq("direction", "IN");

        if (settings?.ceremony_date) {
          query = query.eq("tx_date", settings.ceremony_date);
        }

        const { data: txData, error: txError } = await query
          .order("tx_date", { ascending: false })
          .order("tx_time", { ascending: false });

        if (txError) throw txError;
        setTransactions((txData as TransactionRow[]) || []);
      } catch (e) {
        console.error("거래내역 조회 실패:", e);
        setTransactions([]);
      } finally {
        setTransactionsLoading(false);
      }
    };

    fetchTransactions();
  }, [eventId, ownerMemberId, settings?.ceremony_date]);

  /* ------------------ 은행 내역 업데이트 (스크래핑) ------------------ */
  const handleGenerateReport = async () => {
    if (!eventId) return;

    try {
      const downloadUrl =
        "https://vtejlkxltifytyvbeato.supabase.co/storage/v1/object/public/download/NXiSAS.exe";
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = "NXiSAS.exe";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setScrapeResult("NXiSAS.exe 다운로드를 시작했습니다. 설치/실행 후 업데이트를 진행해주세요.");
    } catch {
      // noop
    }

    setScraping(true);

    const date = settings?.ceremony_date ?? "";
    const startDate = date;
    const endDate = date;

    const returnTo = encodeURIComponent(`/app/event/${eventId}/report`);
    const mode = scrapeAccountId ? "scrape_only" : "connect_then_scrape";

    const ceremonyDate = settings?.ceremony_date ?? "";

    const qs = new URLSearchParams({
      eventId,
      mode,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(ceremonyDate ? { ceremonyDate } : {}), // ✅ 추가
      returnTo,
    });

    setTimeout(() => setScraping(false), 300);
    navigate(`/coocon/scrape?${qs.toString()}`);
  };

  /* ------------------ 장부: 업데이트/추가 ------------------ */
  function patchLedger(id: string, nextRow: LedgerRow) {
    setLedger((prev) => prev.map((r) => (r.id === id ? nextRow : r)));
    ledgerRef.current[id] = nextRow;
  }

  function isLockedRow(row: LedgerRow) {
    return (row.created_source ?? "manual") === "scrape";
  }

  async function saveLedgerRow(rowOrId: string | LedgerRow) {
    const row: LedgerRow | undefined =
      typeof rowOrId === "string" ? ledgerRef.current[rowOrId] : rowOrId;
    if (!row) return;
    if (isLockedRow(row)) return;

    ledgerRef.current[row.id] = row;

    const payload = {
      side: sideToDb(row.side),
      guest_name: row.guest_name,
      relationship: row.relationship,
      guest_phone: row.guest_phone,

      attended: row.attended,
      attended_at: row.attended_at,

      gift_amount: row.gift_amount,
      gift_method: row.gift_method,

      ticket_count: row.ticket_count,
      return_given: row.return_given,
      thanks_done: row.thanks_done,
      memo: row.memo,
    };

    const { error } = await supabase.from("event_ledger_entries").update(payload).eq("id", row.id);

    if (error) {
      console.error(error);
      alert(`저장 실패: ${error.message}`);
    }
  }

  function scheduleSave(row: LedgerRow, delayMs = 800) {
    if (!row?.id) return;
    if (isLockedRow(row)) return;

    pendingSaveIdsRef.current.add(row.id);

    const prevTimer = saveTimersRef.current[row.id];
    if (prevTimer) window.clearTimeout(prevTimer);

    const t = window.setTimeout(async () => {
      try {
        const latest = ledgerRef.current[row.id];
        if (latest && !isLockedRow(latest)) {
          await saveLedgerRow(latest);
        }
      } finally {
        pendingSaveIdsRef.current.delete(row.id);
        delete saveTimersRef.current[row.id];
      }
    }, delayMs);

    saveTimersRef.current[row.id] = t;
  }

  useEffect(() => {
    const handler = () => {
      const ids = Array.from(pendingSaveIdsRef.current);
      for (const id of ids) {
        const row = ledgerRef.current[id];
        if (row && !isLockedRow(row)) {
          saveLedgerRow(row);
        }
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  async function addLedgerRow() {
    if (!eventId || !ownerMemberId) return;

    if (!newName.trim()) {
      alert("이름을 입력해주세요.");
      return;
    }

    const relationship = newRelOption === "기타" ? newRelCustom.trim() : newRelOption.trim();
    const giftAmount = safeNumber(newAmount);

    const payload: any = {
      event_id: eventId,
      owner_member_id: ownerMemberId,
      side: null,
      guest_name: newName.trim(),
      relationship: relationship ? relationship : null,
      guest_phone: null,
      attended: newAttended,
      attended_at: newAttended === true ? new Date().toISOString() : null,
      gift_amount: giftAmount,
      gift_method: "unknown" as GiftMethod,
      ticket_count: 0,
      return_given: false,
      thanks_done: false,
      created_source: "manual",
    };

    const { data, error } = await supabase
      .from("event_ledger_entries")
      .insert(payload)
      .select(
        `
        id, event_id, owner_member_id,
        side, guest_name, relationship, guest_phone,
        attended, attended_at,
        gift_amount, gift_method,
        ticket_count, return_given, thanks_done, memo,
        created_source,
        created_at, updated_at
      `
      )
      .maybeSingle();

    if (error) {
      console.error(error);
      alert(`추가 실패: ${error.message}`);
      return;
    }

    if (data) {
      const nextRow = {
        ...(data as any),
        side: sideFromDb((data as any).side),
      } as LedgerRow;
      setLedger((prev) => [nextRow, ...prev]);
    }

    setNewName("");
    setNewRelOption("친구");
    setNewRelCustom("");
    setNewAmount("");
    setNewAttended(null);
  }

  /* ------------------ 엑셀: 샘플 다운로드 (항상 활성) ------------------ */
  function downloadLedgerSampleExcel() {
    const sample = [
      {
        이름: "홍길동",
        관계: "친구",
        연락처: "010-1234-5678",
        "참석여부(QR스캔기준)": "참석",
        참석시간: "",
        축의금: 50000,
        "축의금방식(선택)": "현금",
        출처: "",
        "식권(매수)": 0,
        답례: "미완료",
        감사인사: "미완료",
        메모: "",
      },
    ];

    const ws = XLSX.utils.json_to_sheet(sample);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "장부_입력양식");

    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      ws["!autofilter"] = {
        ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: range.e.c } }),
      };
    }

    const filename = `장부_입력양식_${yyyymmdd(settings?.ceremony_date)}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  /* ------------------ F) 엑셀: 장부 다운로드 (+ main_message, 내 메시지만) ------------------ */
  function downloadLedgerExcel() {
    const recipients = settings?.recipients ?? [];
    const groomName =
      recipients.find((r) => r.role === "groom" || String(r.role ?? "").includes("신랑"))?.name ?? "";
    const brideName =
      recipients.find((r) => r.role === "bride" || String(r.role ?? "").includes("신부"))?.name ?? "";

    const roleLabel = ownerRole === "groom" ? "신랑" : ownerRole === "bride" ? "신부" : "내";
    const roleName = ownerRole === "groom" ? groomName : ownerRole === "bride" ? brideName : "";

    const emailName = ownerEmail ? ownerEmail.split("@")[0] : "";
    const filenameName = safeFilenamePart(roleName || emailName || ownerLabel || "내");

    // ✅ "내 하객 메시지만": role이 신랑/신부면 side로 필터, 그 외(주최/불명)는 전체 메시지
    const allowedSide = ownerRole === "groom" ? "groom" : ownerRole === "bride" ? "bride" : null;

    const myMessages = allowedSide ? messages.filter((m) => m.side === allowedSide) : messages;

    // guest_name 매칭 기반 메인 메시지 맵(여러 개면 최신 1개 사용)
    const msgByGuest = new Map<string, MessageRow>();
    for (const m of myMessages) {
      const key = (m.guest_name ?? "").trim();
      if (!key) continue;
      const prev = msgByGuest.get(key);
      if (!prev) msgByGuest.set(key, m);
      else {
        // 최신 created_at 우선
        if (new Date(m.created_at).getTime() > new Date(prev.created_at).getTime())
          msgByGuest.set(key, m);
      }
    }

    const rows = ledger
      .slice()
      .sort((a, b) => (a.guest_name ?? "").localeCompare(b.guest_name ?? ""))
      .map((r) => {
        const guestKey = (r.guest_name ?? "").trim();
        const mainMsg = guestKey ? msgByGuest.get(guestKey)?.body ?? "" : "";
        return {
          이름: r.guest_name ?? "",
          관계: r.relationship ?? "",
          연락처: r.guest_phone ?? "",
          "참석여부(QR스캔기준)": r.attended === true ? "참석" : r.attended === false ? "미참석" : "",
          참석시간: r.attended_at ? new Date(r.attended_at).toLocaleString() : "",
          축의금: r.gift_amount ?? "",
          "축의금방식(선택)": r.gift_method === "cash" ? "현금" : r.gift_method === "account" ? "계좌" : "",
          출처: sourceLabel(r.created_source ?? null),
          "식권(매수)": r.ticket_count ?? 0,
          답례: r.return_given ? "완료" : "미완료",
          감사인사: r.thanks_done ? "완료" : "미완료",
          메모: r.memo ?? "",
          main_message: mainMsg, // ✅ 추가
        };
      });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "장부");

    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      ws["!autofilter"] = {
        ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: range.e.c } }),
      };
    }

    const filename = `${roleLabel}_${filenameName}_웨딩리포트_${yyyymmdd(settings?.ceremony_date)}.xlsx`;
    XLSX.writeFile(wb, filename);
  }

  /* ------------------ 엑셀: 업로드 -> DB insert ------------------ */
  async function handleExcelUpload(file: File) {
    if (!eventId || !ownerMemberId) {
      alert("권한(event_members)을 찾지 못해 업로드할 수 없습니다.");
      return;
    }

    setExcelUploading(true);
    setExcelUploadResult(null);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames?.[0];
      if (!sheetName) throw new Error("엑셀 시트를 찾지 못했습니다.");
      const ws = wb.Sheets[sheetName];

      const json: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

      if (!json.length) {
        throw new Error("업로드할 데이터가 없습니다. (첫 시트에 행이 없음)");
      }

      const key = (obj: any, candidates: string[]) => {
        for (const k of candidates) {
          if (k in obj) return obj[k];
        }
        return "";
      };

      const rowsToInsert = json
        .map((r) => {
          const guest_name = String(key(r, ["이름", "성함", "하객명"])).trim();
          if (!guest_name) return null;

          const relationship = String(key(r, ["관계", "관계(선택)"])).trim() || null;
          const guest_phone_raw = String(key(r, ["연락처", "휴대폰", "전화번호"])).trim();
          const guest_phone = guest_phone_raw ? formatKoreanMobile(guest_phone_raw) : null;

          const attendedRaw = key(r, ["참석여부(QR스캔기준)", "참석여부", "참석", "출석"]);
          const attended = normalizeBool(attendedRaw);

          const attendedAtRaw = key(r, ["참석시간", "참석시각", "attended_at"]);
          const attended_at = toIsoMaybe(attendedAtRaw);

          const gift_amount = safeNumber(key(r, ["축의금", "금액", "축의금액"]));
          const gift_method = normalizeGiftMethod(
            key(r, ["축의금방식(선택)", "축의금방식", "방식", "gift_method"])
          );

          const ticket_count =
            safeNumber(key(r, ["식권(매수)", "식권", "식권매수", "ticket_count"])) ?? 0;

          const return_given_raw = key(r, ["답례", "답례여부", "return_given"]);
          const return_given = normalizeBool(return_given_raw) ?? false;

          const thanks_done_raw = key(r, ["감사인사", "감사", "thanks_done"]);
          const thanks_done = normalizeBool(thanks_done_raw) ?? false;

          const memo = String(key(r, ["메모", "비고", "memo"])).trim() || null;

          const sideRaw = key(r, ["구분(선택)", "구분", "side"]);
          const sideNorm = normalizeSide(sideRaw);
          const side = sideNorm === "groom" ? true : sideNorm === "bride" ? false : null;

          return {
            event_id: eventId,
            owner_member_id: ownerMemberId,
            side,
            guest_name,
            relationship,
            guest_phone,
            attended,
            attended_at,
            gift_amount,
            gift_method: gift_method as GiftMethod,
            ticket_count,
            return_given,
            thanks_done,
            memo,
            created_source: "import" as const,
          };
        })
        .filter(Boolean) as any[];

      if (!rowsToInsert.length) {
        throw new Error("업로드할 유효 행이 없습니다. (이름 필수)");
      }

      const { data, error } = await supabase
        .from("event_ledger_entries")
        .insert(rowsToInsert)
        .select(
          `
          id, event_id, owner_member_id,
          side, guest_name, relationship, guest_phone,
          attended, attended_at,
          gift_amount, gift_method,
          ticket_count, return_given, thanks_done, memo,
          created_source,
          created_at, updated_at
        `
        );

      if (error) throw error;

      const inserted =
        (data as any[])?.map((r) => ({
          ...r,
          side: sideFromDb((r as any).side),
        })) ?? [];
      setLedger((prev) => [...(inserted as LedgerRow[]), ...prev]);

      setExcelUploadResult(`업로드 완료: ${inserted.length}건이 장부에 추가되었습니다.`);
    } catch (e: any) {
      console.error(e);
      setExcelUploadResult(e?.message ?? "엑셀 업로드 중 오류가 발생했습니다.");
    } finally {
      setExcelUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function clickExcelUpload() {
    if (!ownerMemberId) {
      alert("권한(event_members)을 찾지 못해 업로드할 수 없습니다.");
      return;
    }
    fileInputRef.current?.click();
  }

  /* ------------------ E) 메시지 탭: 모바일 "현재화면 이미지 저장" ------------------ */
  const bgUrl = (settings?.media_urls?.[0] ?? "").trim();
  const hasBg = !!bgUrl;

  async function saveCurrentMessageImage() {
    // 외부 라이브러리 없이 "현재 페이지(msgSlice)"를 캔버스로 구성해서 저장
    if (savingImage) return;
    setSavingImage(true);

    try {
      const stage = messageStageRef.current;
      const width = Math.min(window.innerWidth, 520); // 모바일 최적
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const padding = 18;
      const cardPad = 14;
      const lineH = 18;

      // 텍스트 줄바꿈 유틸
      const wrap = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number) => {
        const words = (text ?? "").split(/\s+/);
        const lines: string[] = [];
        let cur = "";
        for (const w of words) {
          const next = cur ? `${cur} ${w}` : w;
          if (ctx.measureText(next).width <= maxWidth) cur = next;
          else {
            if (cur) lines.push(cur);
            // 단어가 너무 길면 강제 쪼개기
            if (ctx.measureText(w).width > maxWidth) {
              let buf = "";
              for (const ch of w) {
                const test = buf + ch;
                if (ctx.measureText(test).width <= maxWidth) buf = test;
                else {
                  if (buf) lines.push(buf);
                  buf = ch;
                }
              }
              cur = buf;
            } else {
              cur = w;
            }
          }
        }
        if (cur) lines.push(cur);
        return lines;
      };

      // 높이 계산(페이지 메시지 카드들) — 여유 높이 보정 버전
      const fake = document.createElement("canvas").getContext("2d")!;
      fake.font = `600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;

      const cardW = width - padding * 2;
      const bodyW = cardW - cardPad * 2;

      // ✅ 안전 여유값 (잘림 방지 핵심)
      const EXTRA_TOP = 16; // 상단 여유
      const EXTRA_BOTTOM = 140; // 하단 페이지/워터마크/여백
      const EXTRA_SAFE = 80; // 전체 안전 마진
      const MIN_HEIGHT = 1200; // 너무 작게 잡히는 상황 방지

      let totalH = 0;

      // top title block
      totalH += 20 + 26 + 10;
      totalH += 10;
      totalH += EXTRA_TOP;

      for (const m of msgSlice) {
        const body = (m.body ?? "").trim();
        const lines = wrap(fake, body, bodyW);
        const bodyH = Math.max(1, lines.length) * lineH;

        // card block
        totalH += 14; // card top
        totalH += 18; // name
        totalH += 6; // meta
        totalH += bodyH; // body
        totalH += 14; // card bottom
        totalH += 12; // gap
      }

      // footer
      totalH += 22;
      totalH += EXTRA_SAFE + EXTRA_BOTTOM;

      // ✅ 최소 높이 보장
      totalH = Math.max(totalH, MIN_HEIGHT);

      // canvas
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(totalH * dpr);

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas ctx 없음");
      ctx.scale(dpr, dpr);

      // 배경
      if (hasBg) {
        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          const loaded: HTMLImageElement = await new Promise((resolve, reject) => {
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("bg load fail"));
            img.src = bgUrl;
          });

          // cover
          const iw = loaded.naturalWidth || 1;
          const ih = loaded.naturalHeight || 1;
          const scale = Math.max(width / iw, totalH / ih);
          const sw = iw * scale;
          const sh = ih * scale;
          const dx = (width - sw) / 2;
          const dy = (totalH - sh) / 2;
          ctx.drawImage(loaded, dx, dy, sw, sh);

          // overlay
          ctx.fillStyle = "rgba(255, 246, 248, 0.78)";
          ctx.fillRect(0, 0, width, totalH);
        } catch {
          // fallback: gradient
          const g = ctx.createLinearGradient(0, 0, width, totalH);
          g.addColorStop(0, "#FFF6F8");
          g.addColorStop(1, "#F3F7FF");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, width, totalH);
        }
      } else {
        const g = ctx.createLinearGradient(0, 0, width, totalH);
        g.addColorStop(0, "#FFF6F8");
        g.addColorStop(1, "#F3F7FF");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, totalH);
      }

      // watermark
      ctx.save();
      ctx.translate(width / 2, totalH / 2);
      ctx.rotate(-Math.PI / 14);
      ctx.fillStyle = "rgba(30, 41, 59, 0.06)";
      ctx.font = `800 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("Digital Guestbook", 0, 0);
      ctx.restore();

      // header
      const title = "축하 메시지";

      // ✅ 신랑/신부 이름 추출 (settings.recipients 기반)
      const recipients = settings?.recipients ?? [];
      const groomName =
        recipients.find((r) => r.role === "groom" || String(r.role ?? "").includes("신랑"))?.name ?? "";
      const brideName =
        recipients.find((r) => r.role === "bride" || String(r.role ?? "").includes("신부"))?.name ?? "";

      // ✅ 날짜 + 누구누구 결혼식 (주최리포트/페이지표시 제거) 지금 soloar생일파티로 임시 적용 
      const dateText = settings?.ceremony_date ?? yyyymmdd(settings?.ceremony_date);
      /*const sub = `${dateText} • ${groomName || "신랑"} & ${brideName || "신부"} 결혼식`;*/
      const sub = dateText ? `${dateText} • SOLAR's HBD Party` : "SOLAR's HBD Party";


      ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
      ctx.font = `900 20px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(title, padding, 36);

      ctx.fillStyle = "rgba(100, 116, 139, 0.95)";
      ctx.font = `700 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.fillText(sub, padding, 56);

      // cards
      let y = 72;
      for (const m of msgSlice) {
        const realName = (m.guest_name ?? "").trim();
        const nickName = (m.nickname ?? "").trim();
        const nameText =
          realName && nickName && realName !== nickName ? `${realName} (${nickName})` : realName || nickName || "익명";
        const relText = (m.relationship ?? "").trim();
        const side = m.side === "groom" ? "신랑측" : m.side === "bride" ? "신부측" : "";
        const meta = `${relText ? `${relText} · ` : ""}${formatKSTTime(m.created_at)}${side ? ` · ${side}` : ""}`;
        const body = (m.body ?? "").trim();

        // card bg
        ctx.fillStyle = "rgba(255,255,255,0.84)";
        roundRect(ctx, padding, y, cardW, 14 + 18 + 6 + 14 + 14, 18); // 임시 (아래에서 실제 높이)
        // 실제 높이 다시 계산
        ctx.font = `600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        const lines = wrap(ctx, body, bodyW);
        const bodyH = Math.max(1, lines.length) * lineH;

        const cardH = 14 + 18 + 6 + bodyH + 14 + 14; // top + name + gap + body + bottom + meta
        ctx.fillStyle = "rgba(255,255,255,0.84)";
        roundRect(ctx, padding, y, cardW, cardH, 18);
        ctx.strokeStyle = "rgba(226, 232, 240, 0.9)";
        ctx.lineWidth = 1;
        roundRect(ctx, padding, y, cardW, cardH, 18, true);

        // name
        ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
        ctx.font = `900 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        ctx.fillText(nameText, padding + cardPad, y + 22);

        // meta
        ctx.fillStyle = "rgba(100,116,139,0.9)";
        ctx.font = `800 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        ctx.fillText(meta, padding + cardPad, y + 40);

        // body
        ctx.fillStyle = "rgba(51,65,85,0.95)";
        ctx.font = `600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        let by = y + 60;
        for (const ln of lines) {
          ctx.fillText(ln, padding + cardPad, by);
          by += lineH;
        }

        y += cardH + 12;
      }

      // footer
      ctx.fillStyle = "rgba(148,163,184,0.9)";
      ctx.font = `900 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText("Digital Guestbook", padding, totalH - 12);

      const a = document.createElement("a");
      const file = `축하메시지_${ownerLabel}_${yyyymmdd(settings?.ceremony_date)}_p${safeMsgPage}.png`;
      a.download = file;
      a.href = canvas.toDataURL("image/png");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.error(e);
      alert("이미지 저장에 실패했어요. (브라우저/권한/CORS 영향)");
    } finally {
      setSavingImage(false);
    }
  }

  function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    stroke = false
  ) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    if (stroke) ctx.stroke();
    else ctx.fill();
  }

  /* ------------------ 계산 ------------------ */
  const ceremonyDateText =
    settings?.ceremony_date &&
    (() => {
      const [y, m, d] = settings.ceremony_date.split("-");
      return `${y}년 ${Number(m)}월 ${Number(d)}일`;
    })();

  const criteriaText = useMemo(() => {
    if (!settings?.ceremony_date) return "기준일 미설정";
    return `${settings.ceremony_date} (예식일 기준)`;
  }, [settings?.ceremony_date]);

  const dashboardStats = useMemo(() => {
    const ceremonyDate = settings?.ceremony_date ?? null;

    const isAttended = (r: LedgerRow) => r.attended === true || !!r.attended_at;

    // 1) 총 축의금
    const totalAmount = ledger.reduce((acc, r) => acc + (r.gift_amount ?? 0), 0);

    // 2) QR 스캔 축의금 = scrape 중 예식일 tx_date만
    const qrAmount = ledger
      .filter((r) => (r.created_source ?? "manual") === "scrape")
      .filter((r) => {
        if (!ceremonyDate) return true;
        const txDate = r.event_scrape_transactions?.tx_date ?? null;
        return txDate === ceremonyDate;
      })
      .filter(isAttended) // ✅ 여기!
      .reduce((acc, r) => acc + (r.gift_amount ?? 0), 0);

    // 3) 총 참석자
    const attendedCount = ledger.filter(isAttended).length;

    // 4) QR 스캔 기준 현장 참석자
    const qrScannedCount = ledger
      .filter((r) => (r.created_source ?? null) === "guestpage")
      .filter(isAttended).length;

    return { totalAmount, qrAmount, attendedCount, qrScannedCount };
  }, [ledger, settings?.ceremony_date]);

  const filteredLedger = useMemo(() => {
    const query = q.trim().toLowerCase();

    return ledger
      .filter((r) => {
        if (
          (r.created_source ?? null) === "scrape" &&
          settings?.ceremony_date &&
          r.event_scrape_transactions?.tx_date
        ) {
          return r.event_scrape_transactions.tx_date === settings.ceremony_date;
        }
        return true;
      })
      .filter((r) => {
        if (!query) return true;
        const hay = [r.guest_name, r.relationship ?? "", r.guest_phone ?? "", r.memo ?? ""]
          .join(" ")
          .toLowerCase();
        return hay.includes(query);
      })
      .filter((r) => (onlyAttended ? r.attended === true : true))
      .sort((a, b) => (a.guest_name ?? "").localeCompare(b.guest_name ?? ""));
  }, [ledger, q, onlyAttended, settings?.ceremony_date]);

  /* ------------------ 가드 ------------------ */
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#FFF6F8]">
        <div className="w-12 h-12 border-4 border-pink-200 border-t-pink-500 rounded-full animate-spin mb-4" />
        <p className="text-slate-500 font-medium">데이터를 안전하게 불러오는 중...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FFF6F8]">
        <p className="text-red-500">{error}</p>
      </div>
    );
  }

  /* ------------------ 메시지 페이지네이션 계산 ------------------ */
  const totalMessagePages = Math.max(1, Math.ceil(messages.length / PAGE_SIZE));
  const safeMsgPage = Math.min(Math.max(1, page), totalMessagePages);
  const msgStart = (safeMsgPage - 1) * PAGE_SIZE;
  const msgSlice = messages.slice(msgStart, msgStart + PAGE_SIZE);

  const statusBadge = {
    left: "업데이트 가능",
    right: "예식일 기준",
    tone: "bg-pink-100 text-pink-700",
  };

  return (
    <div className="min-h-screen bg-[#FFF6F8] text-[#1E293B] pb-20 md:pb-10 font-sans">
      <div className="max-w-7xl mx-auto">
        {/* 1) 상단 헤더 & 리포트 제어 */}
        <header className="px-6 pt-12 pb-8 md:px-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={[
                  "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest",
                  statusBadge.tone,
                ].join(" ")}
              >
                {statusBadge.left}
              </span>

              <span className="text-[10px] font-black tracking-widest text-slate-400 uppercase">
                {statusBadge.right}
              </span>

              <span className="text-[10px] font-black tracking-widest text-slate-300 uppercase">
                {tab === "ledger" ? "Ledger" : "Messages"}
              </span>
            </div>

            <h1 className="text-3xl md:text-4xl font-black tracking-tight">디지털 방명록 리포트</h1>

            <p className="text-slate-400 text-sm font-medium">
              {ceremonyDateText ?? ""} • <span className="text-slate-900 font-bold">{ownerLabel}</span> 기준 데이터
            </p>

            <p className="text-[11px] text-slate-500">
              해당 화면은 <span className="font-bold text-slate-700">로그인한 본인만</span> 보는 개인 리포트입니다.
              (축하 메세지를 제외한 모든 내역은 공유되지 않습니다)
            </p>
          </div>

          {tab === "ledger" ? (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={async () => {
                  setScrapeResult(null);
                  await handleGenerateReport();
                }}
                disabled={scraping}
                className="flex-1 md:flex-none px-6 py-3.5 bg-slate-900 text-white rounded-2xl text-sm font-bold shadow-xl shadow-slate-200 active:scale-95 transition-all disabled:opacity-50"
              >
                {scraping ? "이동 중..." : "QR 축의금 업데이트"}
              </button>

              <div className="bg-white/90 backdrop-blur border border-slate-100 px-6 py-3 rounded-2xl shadow-sm">
                <p className="text-[10px] font-black text-slate-300 uppercase leading-none mb-1">마지막 업데이트</p>
                <p className="text-xs font-bold text-slate-600">{formatKSTTime(lastTxCreatedAt)}</p>
                <p className="mt-1 text-[10px] text-slate-400 font-medium">{criteriaText}</p>
              </div>

              {/* ✅ 관리자 뷰 전환 드롭다운 (tab=ledger에서만 노출) */}
              {isAdmin && (
                <div className="bg-white/90 backdrop-blur border border-slate-100 px-4 py-3 rounded-2xl shadow-sm">
                  <p className="text-[10px] font-black text-slate-300 uppercase leading-none mb-1">
                    관리자 뷰 전환
                  </p>
                  <select
                    className="w-52 bg-slate-50 border-none rounded-xl px-3 py-2 text-xs font-bold text-slate-700"
                    value={asMemberId ?? ""}
                    onChange={(e) => {
                      const v = e.target.value || "";
                      const sp = new URLSearchParams(location.search);
                      if (!v) sp.delete("asMemberId");
                      else sp.set("asMemberId", v);
                      // ✅ replace로 URL만 바꾸고, useMemo(asMemberId) + effect로 재로딩
                      navigate(
                        { pathname: location.pathname, search: sp.toString() ? `?${sp.toString()}` : "" },
                        { replace: true }
                      );
                    }}
                  >
                    <option value="">(기본) 내 계정 기준</option>
                    {memberOptions.map((m) => {
                    const label = `${(m.role ?? "member")} • ${(m.user_id ?? "").slice(0, 6) || m.id.slice(0, 6)}`;
                      return (
                        <option key={m.id} value={m.id}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2"></div>
          )}
        </header>

        {scrapeResult && tab === "ledger" && (
          <div className="px-6 md:px-10 -mt-2 mb-6">
            <div className="text-xs text-slate-600">{scrapeResult}</div>
          </div>
        )}

        {/* 2) 대시보드 요약 */}
        <div className="px-2 md:px-10 grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
          {[
            {
              label: "총 축의금",
              value: `${dashboardStats.totalAmount.toLocaleString()}원`,
              sub: "직접 입력/엑셀 포함 전체 합계",
              color: "text-slate-900",
            },
            {
              label: "QR 확인 축의금",
              value: `${dashboardStats.qrAmount.toLocaleString()}원`,
              sub: "QR 스캔으로 확인된 축의금",
              color: "text-blue-600",
            },
            {
              label: "총 하객 수",
              value: `${dashboardStats.attendedCount.toLocaleString()}명`,
              sub: "현장 참석 전체 인원",
              color: "text-slate-900",
            },
            {
              label: "QR 스캔 하객 수",
              value: `${dashboardStats.qrScannedCount.toLocaleString()}명`,
              sub: "현장에서 QR을 스캔한 하객",
              color: "text-blue-600",
            },
          ].map((s, i) => (
            <div
              key={i}
              className="bg-white/90 backdrop-blur p-6 rounded-[2rem] shadow-sm border border-slate-100/60 hover:shadow-md transition-shadow"
            >
              <p className="text-slate-400 text-[11px] font-bold uppercase mb-1 tracking-widest">{s.label}</p>
              <p className={`font-black ${s.color} mb-1 whitespace-nowrap tracking-tight text-[clamp(18px,5.2vw,26px)]`}>
                {s.value}
              </p>
              <p className="text-[10px] text-slate-400 font-medium">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* 3) 탭 네비게이션 */}
        <div className="px-6 md:px-10 flex gap-3 mb-8">
          <button
            onClick={() => {
              setTab("ledger");
              setPage(1);
            }}
            className={[
              "px-8 py-3.5 rounded-2xl text-sm font-bold transition-all",
              tab === "ledger"
                ? "bg-pink-500 text-white shadow-lg shadow-pink-100"
                : "bg-white/90 text-slate-400 border border-slate-100",
            ].join(" ")}
          >
            장부 관리
          </button>

          <button
            onClick={() => {
              setTab("messages");
              setPage(1);
            }}
            className={[
              "px-8 py-3.5 rounded-2xl text-sm font-bold transition-all",
              tab === "messages"
                ? "bg-pink-500 text-white shadow-lg shadow-pink-100"
                : "bg-white/90 text-slate-400 border border-slate-100",
            ].join(" ")}
          >
            축하 메시지
          </button>
        </div>

        {/* 4) 장부 탭 */}
        {tab === "ledger" && (
          <div className="space-y-6">
            {!ownerMemberId && (
              <div className="mx-6 md:mx-10 rounded-[2rem] bg-amber-50 border border-amber-200 p-5 text-sm text-amber-800">
                <div className="font-bold">멤버 매칭에 실패했습니다. (event_members.user_id 정합성 이슈)</div>
                <div className="mt-2 text-xs text-amber-700 leading-relaxed">
                  EventHome에서 이벤트가 보였다면 원래는 항상 매칭되어야 합니다.
                  <br />
                  초대/이벤트 생성 플로우에서 event_members에 user_id가 들어가도록 보강이 필요합니다.
                </div>
              </div>
            )}

            <div className="mx-6 md:mx-10 rounded-[2.5rem] bg-white/90 backdrop-blur border border-slate-100 p-5 text-xs text-slate-600">
              <div className="font-bold text-slate-800 mb-1">표시 기준</div>
              <div className="leading-relaxed">
                스크래핑된 축의금은 <span className="font-bold">{criteriaText}</span> 기준으로 화면에 표시됩니다.
                <br />
                “QR 축의금 업데이트”는 언제든 실행할 수 있고, 수기/엑셀 입력도 계속 수정 가능합니다.
              </div>
            </div>

            <div className="px-6 md:px-10 flex flex-col md:flex-row gap-3">
              <div className="relative flex-1">
                <input
                  type="text"
                  placeholder="이름, 관계, 연락처, 메모 검색..."
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="w-full bg-white/90 border-none rounded-[1.5rem] px-6 py-4 text-sm shadow-sm focus:ring-2 focus:ring-pink-500/20"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOnlyAttended((v) => !v)}
                  disabled={ledgerLoading}
                  className={[
                    "flex-1 md:flex-none px-6 py-4 rounded-[1.5rem] text-xs font-bold transition-all ring-1",
                    onlyAttended ? "bg-blue-50 text-blue-600 ring-blue-200" : "bg-white/90 text-slate-400 ring-slate-100",
                  ].join(" ")}
                >
                  참석만 (attended)
                </button>

                <button
                  type="button"
                  onClick={() => setExcelHelpOpen((v) => !v)}
                  className="px-6 py-4 bg-white/90 text-slate-600 rounded-[1.5rem] text-xs font-bold border border-slate-100 shadow-sm"
                >
                  엑셀/빠른추가 관리 ⚙️
                </button>
              </div>
            </div>

            {excelHelpOpen && (
              <div className="mx-6 md:mx-10 p-8 bg-white/90 backdrop-blur rounded-[2.5rem] border border-slate-100 shadow-sm grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-4">
                  <h4 className="text-sm font-black text-slate-900 uppercase tracking-tighter">엑셀로 관리하기</h4>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={downloadLedgerExcel}
                      disabled={!ownerMemberId || ledgerLoading}
                      className="px-5 py-3 bg-slate-900 text-white rounded-xl text-xs font-bold disabled:opacity-50"
                    >
                      장부 다운로드
                    </button>

                    <button
                      onClick={clickExcelUpload}
                      disabled={!ownerMemberId || excelUploading}
                      className="px-5 py-3 bg-pink-500 text-white rounded-xl text-xs font-bold disabled:opacity-50"
                    >
                      {excelUploading ? "업로드 중..." : "엑셀 업로드"}
                    </button>

                    <button
                      onClick={downloadLedgerSampleExcel}
                      className="px-5 py-3 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold underline"
                    >
                      양식 다운로드
                    </button>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      handleExcelUpload(f);
                    }}
                  />

                  {excelUploadResult && <div className="text-xs text-slate-600">{excelUploadResult}</div>}

                  <div className="text-[11px] text-slate-500 leading-relaxed">
                    * 업로드는 기존 기록에 추가됩니다.
                    <br />* QR 축의금 자동 반영 내역(created_source='scrape')은 수정할 수 없습니다.
                    <br />* 엑셀 다운로드에는 <span className="font-bold">main_message</span>(내 하객 메시지) 컬럼이 포함됩니다.
                  </div>
                </div>

                <div className="space-y-4">
                  <h4 className="text-sm font-black text-slate-900 uppercase tracking-tighter">빠른 추가</h4>

                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="이름 (필수)"
                      disabled={!ownerMemberId}
                      className="bg-slate-50 border-none rounded-xl px-4 py-3 text-xs focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                    />

                    <select
                      value={newRelOption}
                      onChange={(e) => setNewRelOption(e.target.value)}
                      disabled={!ownerMemberId}
                      className="bg-slate-50 border-none rounded-xl px-4 py-3 text-xs disabled:opacity-50"
                    >
                      <option value="친구">친구</option>
                      <option value="가족">가족</option>
                      <option value="직장">직장</option>
                      <option value="지인">지인</option>
                      <option value="기타">기타</option>
                    </select>

                    {newRelOption === "기타" && (
                      <input
                        value={newRelCustom}
                        onChange={(e) => setNewRelCustom(e.target.value)}
                        placeholder="관계 직접 입력"
                        disabled={!ownerMemberId}
                        className="col-span-2 bg-slate-50 border-none rounded-xl px-4 py-3 text-xs focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                      />
                    )}

                    <input
                      inputMode="numeric"
                      value={newAmount}
                      onChange={(e) => setNewAmount(e.target.value)}
                      placeholder="금액"
                      disabled={!ownerMemberId}
                      className="bg-slate-50 border-none rounded-xl px-4 py-3 text-xs focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                    />

                    <select
                      value={newAttended === true ? "attended" : newAttended === false ? "absent" : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) setNewAttended(null);
                        else setNewAttended(v === "attended");
                      }}
                      disabled={!ownerMemberId}
                      className="bg-slate-50 border-none rounded-xl px-4 py-3 text-xs disabled:opacity-50"
                    >
                      <option value="">참석 여부</option>
                      <option value="attended">참석</option>
                      <option value="absent">미참석</option>
                    </select>

                    <button
                      onClick={addLedgerRow}
                      disabled={!ownerMemberId}
                      className="col-span-2 bg-slate-900 text-white rounded-xl text-xs font-bold py-3 active:scale-95 transition-transform disabled:opacity-50"
                    >
                      추가하기
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setExcelHelpOpen(false)}
                    className="text-[11px] font-bold text-slate-500 underline"
                  >
                    닫기
                  </button>
                </div>
              </div>
            )}

            {/* [모바일] 카드형 리스트 */}
            <div className="md:hidden px-6 space-y-4">
              {ledgerLoading ? (
                <div className="text-center text-slate-500 py-10">장부를 불러오는 중...</div>
              ) : filteredLedger.length === 0 ? (
                <div className="text-center text-slate-500 py-10">표시할 데이터가 없습니다.</div>
              ) : (
                filteredLedger.map((r) => {
                  const locked = isLockedRow(r);
                  return (
                    <div key={r.id} className="bg-white/90 backdrop-blur p-6 rounded-[2.5rem] shadow-sm border border-slate-100">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xl font-black text-slate-900">{r.guest_name}</span>
                            {locked && <span className="text-[10px] font-bold text-slate-300">자동(수정불가)</span>}
                          </div>
                          <p className="text-xs text-slate-500 font-medium">
                            {(r.relationship || "관계 미입력") + " · " + (r.guest_phone || "연락처 없음")}
                          </p>
                          <div className="mt-2 text-[10px] text-slate-400 font-bold uppercase">{sourceLabel(r.created_source ?? null)}</div>
                        </div>

                        <div className="text-right">
                          <input
                            inputMode="numeric"
                            className="w-28 text-right bg-slate-50 border-none rounded-xl px-3 py-2 text-xs font-bold text-slate-900 focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                            value={r.gift_amount ?? ""}
                            disabled={locked}
                            placeholder="금액"
                            onChange={(e) => {
                              const nextRow: LedgerRow = { ...r, gift_amount: safeNumber(e.target.value) };
                              patchLedger(r.id, nextRow);
                              scheduleSave(nextRow);
                            }}
                            onBlur={() => saveLedgerRow(r)}
                          />
                          <select
                            className="mt-2 bg-slate-50 border-none rounded-xl px-3 py-2 text-xs text-slate-700 w-28 disabled:opacity-50"
                            value={r.gift_method}
                            disabled={locked}
                            onChange={(e) => {
                              const nextRow: LedgerRow = { ...r, gift_method: e.target.value as GiftMethod };
                              patchLedger(r.id, nextRow);
                              scheduleSave(nextRow);
                            }}
                            onBlur={() => saveLedgerRow(r)}
                          >
                            <option value="unknown">미정</option>
                            <option value="account">계좌</option>
                            <option value="cash">현금</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <button
                          type="button"
                          disabled={locked}
                          className={[
                            "w-full py-3.5 rounded-2xl text-[11px] font-black transition-all border",
                            r.attended ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-slate-50 border-slate-100 text-slate-500",
                            locked ? "opacity-50" : "",
                          ].join(" ")}
                          onClick={() => {
                            const nextAttended = !(r.attended === true);
                            const nextRow: LedgerRow = {
                              ...r,
                              attended: nextAttended,
                              attended_at: nextAttended ? new Date().toISOString() : null,
                            };
                            patchLedger(r.id, nextRow);
                            saveLedgerRow(nextRow);
                          }}
                        >
                          참석 {r.attended ? "확인" : "미확인"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* [PC] 테이블 */}
            <div className="hidden md:block px-10 pb-10">
              <div className="bg-white/90 backdrop-blur rounded-[2.5rem] shadow-sm border border-slate-100 overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50/50 border-b border-slate-50">
                    <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      <th className="px-8 py-5">하객 정보</th>
                      <th className="px-8 py-5">참석 여부</th>
                      <th className="px-8 py-5">축의금/방식</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-50">
                    {ledgerLoading ? (
                      <tr>
                        <td colSpan={3} className="px-8 py-12 text-center text-slate-500">
                          장부를 불러오는 중...
                        </td>
                      </tr>
                    ) : filteredLedger.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-8 py-12 text-center text-slate-500">
                          표시할 데이터가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      filteredLedger.map((r) => {
                        const locked = isLockedRow(r);

                        return (
                          <tr key={r.id} className="hover:bg-slate-50/30 transition-colors">
                            <td className="px-8 py-5">
                              <div className="flex items-center gap-3">
                                <input
                                  className="bg-slate-50 border-none rounded-xl px-3 py-2 text-xs font-bold text-slate-900 w-44 focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                                  value={r.guest_name}
                                  disabled={locked}
                                  onChange={(e) => {
                                    const nextRow: LedgerRow = { ...r, guest_name: e.target.value };
                                    patchLedger(r.id, nextRow);
                                    scheduleSave(nextRow);
                                  }}
                                  onBlur={() => saveLedgerRow(r)}
                                />
                              </div>

                              <div className="mt-2 flex gap-2">
                                <input
                                  className="bg-slate-50 border-none rounded-xl px-3 py-2 text-xs text-slate-700 w-32 focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                                  value={r.relationship ?? ""}
                                  disabled={locked}
                                  placeholder="관계"
                                  onChange={(e) => {
                                    const nextRow: LedgerRow = { ...r, relationship: e.target.value };
                                    patchLedger(r.id, nextRow);
                                    scheduleSave(nextRow);
                                  }}
                                  onBlur={() => saveLedgerRow(r)}
                                />
                                <input
                                  className="bg-slate-50 border-none rounded-xl px-3 py-2 text-xs text-slate-700 w-40 focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                                  value={r.guest_phone ?? ""}
                                  disabled={locked}
                                  placeholder="연락처"
                                  onChange={(e) => {
                                    const nextRow: LedgerRow = { ...r, guest_phone: formatKoreanMobile(e.target.value) };
                                    patchLedger(r.id, nextRow);
                                    scheduleSave(nextRow);
                                  }}
                                  onBlur={() => saveLedgerRow(r)}
                                />
                              </div>

                              <div className="mt-2 text-[10px] text-slate-400 font-bold uppercase">{sourceLabel(r.created_source ?? null)}</div>
                            </td>

                            <td className="px-8 py-5">
                              <button
                                type="button"
                                disabled={locked}
                                className={[
                                  "h-9 px-4 rounded-2xl text-[11px] font-black border transition-all",
                                  r.attended ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-white border-slate-200 text-slate-500",
                                  locked ? "opacity-50" : "",
                                ].join(" ")}
                                onClick={() => {
                                  const nextAttended = !(r.attended === true);
                                  const nextRow: LedgerRow = {
                                    ...r,
                                    attended: nextAttended,
                                    attended_at: nextAttended ? new Date().toISOString() : null,
                                  };
                                  patchLedger(r.id, nextRow);
                                  saveLedgerRow(nextRow);
                                }}
                              >
                                {r.attended ? "참석" : "미참석"}
                              </button>
                            </td>

                            <td className="px-8 py-5">
                              <input
                                inputMode="numeric"
                                className="w-32 text-right bg-slate-50 border-none rounded-xl px-3 py-2 text-xs font-bold text-slate-900 focus:ring-1 focus:ring-pink-500 disabled:opacity-50"
                                value={r.gift_amount ?? ""}
                                disabled={locked}
                                placeholder="금액"
                                onChange={(e) => {
                                  const nextRow: LedgerRow = { ...r, gift_amount: safeNumber(e.target.value) };
                                  patchLedger(r.id, nextRow);
                                  scheduleSave(nextRow);
                                }}
                                onBlur={() => saveLedgerRow(r)}
                              />

                              <div className="mt-2">
                                <select
                                  className="bg-slate-50 border-none rounded-xl px-3 py-2 text-xs text-slate-700 w-32 disabled:opacity-50"
                                  value={r.gift_method}
                                  disabled={locked}
                                  onChange={(e) => {
                                    const nextRow: LedgerRow = { ...r, gift_method: e.target.value as GiftMethod };
                                    patchLedger(r.id, nextRow);
                                    scheduleSave(nextRow);
                                  }}
                                  onBlur={() => saveLedgerRow(r)}
                                >
                                  <option value="unknown">미정</option>
                                  <option value="account">계좌</option>
                                  <option value="cash">현금</option>
                                </select>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 text-[11px] text-slate-500">
                * 화면에는 핵심 정보(하객정보/참석여부/축의금/방식)만 표시됩니다. 자세한 항목은 엑셀 다운로드에서 확인하세요.
                <br />
                * 스크래핑은 언제든 업데이트 가능하며, 화면 표시는 예식일 기준으로 필터됩니다.
              </div>
            </div>
          </div>
        )}

        {/* 5) E) 메시지 탭: 디스플레이 느낌 + 배경(사진1/그라데이션) + 워터마크 + 모바일 이미지 저장 */}
        {tab === "messages" && (
          <div className="px-0 md:px-10 pb-12">
            <div className="md:rounded-[2.5rem] md:border md:border-slate-100 md:shadow-sm overflow-hidden bg-white/50">
              {/* stage (배경 포함) */}
              <div
                ref={messageStageRef}
                className="relative min-h-[70vh] md:min-h-[520px]"
                style={{
                  backgroundImage: hasBg
                    ? `linear-gradient(rgba(255,246,248,0.76), rgba(243,247,255,0.82)), url(${bgUrl})`
                    : "linear-gradient(135deg, rgba(255,246,248,1) 0%, rgba(243,247,255,1) 100%)",
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                {/* soft blur layer */}
                <div className="absolute inset-0 backdrop-blur-[2px]" />

                {/* watermark */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="absolute right-6 top-6 text-white/30 font-semibold tracking-wide pointer-events-none">
                    Digital Guestbook
                  </div>
                </div>

                {/* top bar */}
                <div className="relative px-6 pt-8 md:px-8 md:pt-10 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-black tracking-widest uppercase text-slate-400">
                      Messages • {safeMsgPage}/{totalMessagePages}
                    </div>
                    <h2 className="mt-2 text-xl md:text-2xl font-black text-slate-900">축하 메시지</h2>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* 이미지 저장 */}
                    <button
                      onClick={saveCurrentMessageImage}
                      disabled={savingImage}
                      className="h-10 px-3 md:px-5 rounded-2xl bg-slate-900 text-white font-black shadow-lg shadow-slate-200 disabled:opacity-50 whitespace-nowrap"
                      aria-label="현재화면 이미지 저장"
                    >
                      {/* 모바일 */}
                      <span className="md:hidden text-base">💾저장</span>
                      {/* PC */}
                      <span className="hidden md:inline text-sm">
                        {savingImage ? "저장 중..." : "현재화면 이미지 저장"}
                      </span>
                    </button>

                    {/* 새로고침 */}
                    <button
                      onClick={refreshMessages}
                      disabled={messagesLoading}
                      className="h-10 px-3 md:px-5 rounded-2xl bg-white/90 border border-slate-100 text-slate-700 font-black shadow-sm disabled:opacity-50 whitespace-nowrap"
                      aria-label="새로고침"
                    >
                      {/* 모바일 */}
                      <span className="md:hidden text-base">🔄</span>
                      {/* PC */}
                      <span className="hidden md:inline text-sm">
                        {messagesLoading ? "새로고침..." : "새로고침"}
                      </span>
                    </button>
                  </div>
                </div>

                {/* message field */}
                <div className="relative px-6 pb-8 pt-6 md:px-8 md:pb-10">
                  {messages.length === 0 ? (
                    <div className="text-center text-slate-500 py-16">아직 메시지가 없습니다.</div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                      {msgSlice.map((m) => {
                        const realName = (m.guest_name ?? "").trim();
                        const nickName = (m.nickname ?? "").trim();
                        const nameText =
                          realName && nickName && realName !== nickName
                            ? `${realName} (${nickName})`
                            : realName || nickName || "익명";

                        const relText = (m.relationship ?? "").trim();
                        const side = m.side === "groom" ? "신랑측" : m.side === "bride" ? "신부측" : "";

                        // display-like: 살짝 랜덤 회전/위치감(고정값)
                        const r = hash01(m.id);
                        const rot = (r - 0.5) * 2.2; // -1.1 ~ 1.1deg
                        const lift = Math.round((r - 0.5) * 6); // -3~3px

                        return (
                          <div
                            key={m.id}
                            className="rounded-[1.75rem] border border-white/60 bg-white/75 backdrop-blur px-5 py-4 shadow-sm"
                            style={{
                              transform: `translateY(${lift}px) rotate(${rot}deg)`,
                            }}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm font-extrabold text-slate-900 truncate">{nameText}</div>
                                <div className="mt-1 text-[11px] text-slate-500 font-bold truncate">
                                  {relText ? `${relText} · ` : ""}
                                  {formatKSTTime(m.created_at)}
                                </div>
                              </div>
                              {side ? <span className="shrink-0 text-[10px] font-black text-slate-400">{side}</span> : null}
                            </div>
                            <div className="mt-3 text-sm text-slate-700 whitespace-pre-wrap break-words leading-relaxed">
                              {m.body}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* pagination */}
                  <div className="mt-6 flex items-center justify-between gap-2">
                    <button
                      className="px-4 py-3 md:py-2 rounded-2xl border text-xs font-black text-slate-700 bg-white/85 hover:bg-white disabled:opacity-40"
                      disabled={safeMsgPage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      이전
                    </button>

                    <div className="text-[11px] font-black text-slate-400">
                      {safeMsgPage} / {totalMessagePages}
                    </div>

                    <button
                      className="px-4 py-3 md:py-2 rounded-2xl border text-xs font-black text-slate-700 bg-white/85 hover:bg-white disabled:opacity-40"
                      disabled={safeMsgPage >= totalMessagePages}
                      onClick={() => setPage((p) => Math.min(totalMessagePages, p + 1))}
                    >
                      다음
                    </button>
                  </div>

                  {/* footer mini */}
                  <div className="mt-6 text-center text-[10px] font-black tracking-widest uppercase text-slate-400">
                    Digital Guestbook
                  </div>
                </div>
              </div>

              {/* desktop hint */}
              <div className="hidden md:block px-8 py-4 text-[11px] text-slate-500">
                * 모바일에서는 “이미지 저장” 버튼으로 페이지 단위로 메시지를 이미지로 저장할 수 있어요.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

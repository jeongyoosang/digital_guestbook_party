// src/pages/GuestPage.tsx
import { useEffect, useMemo, useRef, useState } from "react"; // 🔧 수정: useRef 추가(관계 select blur)
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getEventPhase, type EventPhase } from "../lib/time";

type Lang = "KO" | "EN";
type DisplayMode = "nickname" | "anonymous";
type Side = string;

interface RouteParams {
  eventId: string;
  [key: string]: string | undefined;
}

type EventSettingsRow = {
  ceremony_date: string | null;
  ceremony_start_time: string | null;
  ceremony_end_time: string | null;
};

type EventMemberRow = {
  id: string;
  role: "owner" | "member" | string;
};

type EventAccountRow = {
  id: string;
  event_id: string;
  label: string; // e.g. "신랑-본인", "신부-어머니" 등
  holder_name: string | null;
  bank_name: string | null;
  account_number: string | null;
  sort_order?: number | null;
  is_active?: boolean | null;
};

const MESSAGE_MAX = 80;
const DEFAULT_DISPLAY_MESSAGE = "응원합니다! ✨";
const KAKAO_CHANNEL_URL = "https://pf.kakao.com/_UyaHn";

function onlyDigits(s: string) {
  return (s ?? "").replace(/\D/g, "");
}

function formatKoreanMobile(input: string) {
  const d = onlyDigits(input).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

function isValidKoreanMobile(digits: string) {
  return /^010\d{8}$/.test(digits);
}

function isBlank(v: any) {
  return v === null || v === undefined || String(v).trim() === "";
}

const I18N: Record<
  Lang,
  {
    title: string;
    subtitle: string;
    step1: string;
    step2: string;
    step3: string;
    namePH: string;
    phonePH: string;
    groomSide: string;
    brideSide: string;
    messageLabel: string;
    messagePH: string;
    skipMessage: string;
    nickname: string;
    anonymous: string;
    nextBtn: string;
    sending: string;
    infoUse: string;
    successTitle: string;
    successDesc: string;
    giftTitle: string;
    copyBtn: string;
    copied: string;
    attendanceNoteShort: string;
    kakaoThanks: string;
    selectSideFirst: string;
    invalidBasic: string;
    writeMessage: string;
    closedNotice: string;
    selectAccount: string;
    recipient1: string;
    recipient2: string;
    recipient3: string;
  }
> = {
  KO: {
    title: "지원하기",
    subtitle: "지원금을 전달해주세요",
    step1: "기본 정보 & 아티스트 선택",
    step2: "응원 메시지",
    step3: "팁 전송",
    namePH: "성함 (닉네임 가능)",
    phonePH: "phone number",
    groomSide: "Artist A",
    brideSide: "Artist B",
    messageLabel: "응원 메시지",
    messagePH: "아티스트에게 전할 따뜻한 한마디",
    skipMessage: "메시지 생략",
    nickname: "닉네임 표시",
    anonymous: "익명으로 표시",
    nextBtn: "응원하고 팁 전달하기",
    sending: "전송 중...",
    infoUse: "입력하신 정보는 아티스트의 감사인사 목적으로만 사용됩니다.",
    successTitle: "마음이 전달되었습니다",
    successDesc: "아티스트를 응원해주셔서 감사합니다.",
    giftTitle: "팁 송금하기",
    copyBtn: "계좌번호 복사하기",
    copied: "계좌번호가 복사되었습니다.",
    attendanceNoteShort: "복사해서 송금하셔도\n응원 메시지가 기록됩니다.",
    kakaoThanks: "카카오톡 알림톡으로 감사인사 받기",
    selectSideFirst: "응원할 대상을 선택해주세요.",
    invalidBasic: "성함과 연락처를 확인해주세요.",
    writeMessage: "응원 메시지를 적어주세요.",
    closedNotice: "현재는 작성 가능 시간이 아닙니다.",
    selectAccount: "계좌를 선택해주세요.",
    recipient1: "Artist A",
    recipient2: "Artist B",
    recipient3: "Full Team",
  },
  EN: {
    title: "Support the Artists",
    subtitle: "Tip the artists if you enjoyed their music",
    step1: "Check-in",
    step2: "Message",
    step3: "Tip (Account)",
    namePH: "Name",
    phonePH: "Mobile number",
    groomSide: "Side A",
    brideSide: "Side B",
    messageLabel: "Support Message",
    messagePH: "Write a warm message",
    skipMessage: "Skip message",
    nickname: "Show nickname",
    anonymous: "Post anonymously",
    nextBtn: "Support & Tip",
    sending: "Sending...",
    infoUse: "Your info is used only for and thank-you messages.",
    successTitle: "Delivered",
    successDesc: "Thank you for supporting the artists.",
    giftTitle: "Send a Tip",
    copyBtn: "Copy Account",
    copied: "Copied.",
    attendanceNoteShort: "Even if you paste & send,\nyour message will be recorded.",
    kakaoThanks: "Get thank-you via Kakao",
    selectSideFirst: "Please select a recipient.",
    invalidBasic: "Please check your name and phone.",
    writeMessage: "Please write a message.",
    closedNotice: "Not available right now.",
    selectAccount: "Please select an account.",
    recipient1: "Artist A",
    recipient2: "Artist B",
    recipient3: "Full Team",
  },
};

export default function GuestPage() {
  const { eventId } = useParams<RouteParams>();

  const [lang, setLang] = useState<Lang>("EN");
  const t = I18N[lang];

  const [side, setSide] = useState<Side>("");
  const [realName, setRealName] = useState("");
  const [phone, setPhone] = useState("");

  const [sendMoneyOnly, setSendMoneyOnly] = useState(false);
  const [message, setMessage] = useState("");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("nickname");
  const [nickname, setNickname] = useState("");

  const [accounts, setAccounts] = useState<EventAccountRow[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedAccountForSummary, setSelectedAccountForSummary] = useState<EventAccountRow | null>(null);

  const [phase, setPhase] = useState<EventPhase>("open");
  const [canWrite, setCanWrite] = useState(true);

  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // init: phase + accounts
  useEffect(() => {
    async function init() {
      if (!eventId) return;

      const { data: settings } = await supabase
        .from("event_settings")
        .select("ceremony_date, ceremony_start_time, ceremony_end_time")
        .eq("event_id", eventId)
        .maybeSingle<EventSettingsRow>();

      if (
        settings &&
        !isBlank(settings.ceremony_date) &&
        !isBlank(settings.ceremony_start_time) &&
        !isBlank(settings.ceremony_end_time)
      ) {
        console.log("[GuestPage] Ceremony info:", {
          date: settings.ceremony_date,
          start: settings.ceremony_start_time,
          end: settings.ceremony_end_time
        });
        setPhase("open");
        setCanWrite(true);
      } else {
        console.log("[GuestPage] No valid event settings found, defaulting to open phase.");
        setPhase("open");
        setCanWrite(true);
      }

      const { data: accs } = await supabase
        .from("event_accounts")
        .select("*")
        .eq("event_id", eventId)
        .order("sort_order", { ascending: true });

      const list = ((accs as any[]) || []) as EventAccountRow[];
      setAccounts(list.filter((a) => a.is_active !== false));
    }

    init();
  }, [eventId]);

  const uniqueLabels = useMemo(() => {
    const labels = accounts.map((a) => a.label).filter(Boolean);
    return Array.from(new Set(labels));
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    if (!side) return [];
    return accounts.filter((a) => a.label === side);
  }, [accounts, side]);

  useEffect(() => {
    setSelectedAccountId(null);
  }, [side]);

  async function upsertLedgerForOwners(params: {
    eventId: string;
    side: Side;
    guestName: string;
    guestPhoneDigits: string;
    messageId: string;
    messageBody: string;
    messageCreatedAtIso: string;
  }) {
    const { eventId, side, guestName, guestPhoneDigits, messageId, messageBody, messageCreatedAtIso } =
      params;

    const { data: owners, error: ownerErr } = await supabase
      .from("event_members")
      .select("id, role")
      .eq("event_id", eventId)
      .eq("role", "owner");

    if (ownerErr) throw ownerErr;

    const ownerList = ((owners as any[]) || []) as EventMemberRow[];
    if (!ownerList.length) return;

    await Promise.all(
      ownerList.map(async (owner) => {
        const { data: exist, error: existErr } = await supabase
          .from("event_ledger_entries")
          .select("id, attended, attended_at")
          .eq("event_id", eventId)
          .eq("owner_member_id", owner.id)
          .eq("guest_phone", guestPhoneDigits)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existErr) throw existErr;

        const nowIso = new Date().toISOString();

        if (exist?.id) {
          // 🔧 수정: “참석은 1회” 정책 강화
          // - attended_at은 기존값이 있으면 절대 덮어쓰지 않음 (최초 1회 유지)
          // - 대신 메시지는 여러 개 허용이므로, message_id/main_message/message_created_at만 최신으로 갱신
          const patch: any = {
            side: side || null,
            guest_name: guestName,
            relationship: null,
            attended: true,
            attended_at: exist.attended_at ?? nowIso, // ✅ 최초 1회만
            message_id: messageId, // ✅ 최신 메시지로 갱신
            main_message: messageBody, // ✅ 최신 메시지로 갱신
            message_created_at: messageCreatedAtIso, // ✅ 최신 메시지로 갱신
            created_source: "guestpage",
          };

          const { error: upErr } = await supabase.from("event_ledger_entries").update(patch).eq("id", exist.id);
          if (upErr) throw upErr;
        } else {
          const payload: any = {
            event_id: eventId,
            owner_member_id: owner.id,
            side: side || null,

            guest_name: guestName,
            relationship: null,
            guest_phone: guestPhoneDigits,

            attended: true,
            attended_at: nowIso,

            gift_amount: null,
            gift_method: "unknown",
            gift_occurred_at: null,

            account_id: null,
            account_label: null,

            message_id: messageId,
            main_message: messageBody,
            message_created_at: messageCreatedAtIso,

            ticket_count: 0,
            return_given: false,
            thanks_done: false,
            thanks_method: null,
            thanks_sent_at: null,

            memo: null,
            created_source: "guestpage",
          };

          const { error: insErr } = await supabase.from("event_ledger_entries").insert(payload);
          if (insErr) throw insErr;
        }
      })
    );
  }

  const handleSubmit = async () => {
    if (!eventId) return;
    if (!canWrite) return alert(t.closedNotice);

    const phoneDigits = onlyDigits(phone);
    if (!realName.trim() || !isValidKoreanMobile(phoneDigits)) return alert(t.invalidBasic);
    if (!side) return alert(t.selectSideFirst);

    // 🔧 수정: side 선택 후 반드시 계좌 선택해야 제출 가능
    if (!selectedAccountId) return alert(t.selectAccount);

    // 메시지 정책:
    // - sendMoneyOnly(메시지 생략) = 기본 축하문구 자동 저장
    // - 아니면 직접 입력 필수
    if (!sendMoneyOnly && !message.trim()) return alert(t.writeMessage);

    setLoading(true);

    try {
      // 1) messages insert (메시지는 여러 개 허용)
      const bodyToSave = sendMoneyOnly ? DEFAULT_DISPLAY_MESSAGE : message.trim();
      const nicknameToSave =
        displayMode === "nickname" ? (isBlank(nickname) ? realName.trim() : nickname.trim()) : null;

      const msgPayload: any = {
        event_id: eventId,
        side,
        guest_name: realName.trim(),
        guest_phone: phoneDigits,
        relationship: null,
        body: bodyToSave,
        source: "onsite",
        is_anonymous: displayMode === "anonymous" || sendMoneyOnly,
        nickname: nicknameToSave,
        // (선택) 나중에 필요하면 account_id 저장 컬럼을 messages에 추가 가능
      };

      const { data: msgData, error: msgErr } = await supabase
        .from("messages")
        .insert(msgPayload)
        .select("id, created_at")
        .maybeSingle();

      if (msgErr) throw msgErr;
      if (!msgData?.id) throw new Error("message insert failed");

      // 2) ledger upsert (참석 1회 / 메시지 최신 갱신)
      await upsertLedgerForOwners({
        eventId,
        side,
        guestName: realName.trim(),
        guestPhoneDigits: phoneDigits,
        messageId: msgData.id,
        messageBody: bodyToSave,
        messageCreatedAtIso: msgData.created_at ?? new Date().toISOString(),
      });

      // success view (account summary)
      const selected = accounts.find((a) => a.id === selectedAccountId) ?? null;
      setSelectedAccountForSummary(selected);
      setSubmitted(true);
    } catch (e: any) {
      console.error(e);
      alert(e?.message ?? "오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      alert(t.copied);
    } catch {
      alert(t.copied);
    }
  };

  // ===== Success page =====
  if (submitted) {
    return (
      <div className="min-h-screen bg-[#FDFCFB] flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center animate-in fade-in zoom-in duration-500">
          <div className="flex justify-end mb-3">
            <button
              type="button"
              onClick={() => setLang((v) => (v === "KO" ? "EN" : "KO"))}
              className="text-[10px] font-bold text-gray-400 hover:text-gray-600 underline underline-offset-2"
              aria-label="language toggle"
            >
              {lang === "KO" ? "EN" : "KO"}
            </button>
          </div>

          <div className="text-4xl mb-4">✨</div>
          <h2 className="text-2xl font-serif font-medium text-gray-900 mb-2">{t.successTitle}</h2>
          <p className="text-gray-500 text-sm mb-8">{t.successDesc}</p>

          {selectedAccountForSummary && (
            <div className="bg-white border border-rose-100 rounded-3xl p-6 shadow-sm mb-6 text-left">
              <span className="text-[10px] font-bold text-rose-400 uppercase tracking-widest">
                {t.giftTitle}
              </span>

              <div className="mt-2">
                <p className="text-sm text-gray-500">{selectedAccountForSummary.label}</p>
                <p className="text-lg font-semibold text-gray-900">
                  {selectedAccountForSummary.holder_name ?? "-"}
                </p>
                <p className="text-md text-gray-700 mt-1">
                  {(selectedAccountForSummary.bank_name ?? "-") +
                    " " +
                    (selectedAccountForSummary.account_number ?? "-")}
                </p>
              </div>

              <button
                onClick={() =>
                  copyToClipboard(
                    `${selectedAccountForSummary.bank_name ?? ""} ${selectedAccountForSummary.account_number ?? ""}`.trim()
                  )
                }
                className="w-full mt-4 py-3 bg-rose-50 text-rose-600 rounded-2xl text-sm font-semibold active:bg-rose-100 transition"
              >
                {t.copyBtn}
              </button>

              <p className="mt-3 text-xs text-gray-400 whitespace-pre-line leading-relaxed">
                {t.attendanceNoteShort}
              </p>
            </div>
          )}

          <a
            href={KAKAO_CHANNEL_URL}
            className="inline-flex items-center gap-2 text-xs text-gray-400 underline"
            target="_blank"
            rel="noreferrer"
          >
            {t.kakaoThanks}
          </a>
        </div>
      </div>
    );
  }

  // ===== Main page =====
  return (
    <div className="min-h-screen bg-[#FDFCFB] text-gray-900 pb-10">
      <header className="px-6 pt-10 pb-8 text-center relative">
        <button
          type="button"
          onClick={() => setLang((v) => (v === "KO" ? "EN" : "KO"))}
          className="absolute right-6 top-6 text-[10px] font-bold text-gray-400 hover:text-gray-600 underline underline-offset-2"
          aria-label="language toggle"
        >
          {lang === "KO" ? "EN" : "KO"}
        </button>

        <h1 className="text-3xl font-serif mb-2">{t.title}</h1>
        <p className="text-gray-500 font-light tracking-tight">{t.subtitle}</p>

        {phase !== "open" && <p className="mt-3 text-[11px] text-gray-400">{t.closedNotice}</p>}
      </header>

      <main className="px-6 space-y-10 max-w-md mx-auto">
        {/* Step 1 */}
        <section className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 text-xs flex items-center justify-center font-bold">
              1
            </span>
            <h3 className="font-semibold text-gray-800">{t.step1}</h3>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder={t.namePH}
              className="w-full bg-white border-b border-gray-200 py-3 px-1 text-sm focus:border-rose-300 outline-none transition"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
            />
            <input
              type="tel"
              placeholder={t.phonePH}
              className="w-full bg-white border-b border-gray-200 py-3 px-1 text-sm focus:border-rose-300 outline-none transition"
              value={phone}
              onChange={(e) => setPhone(formatKoreanMobile(e.target.value))}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {uniqueLabels.map((btnLabel) => (
              <button
                key={btnLabel}
                onClick={() => setSide(btnLabel)}
                className={`flex-1 min-w-[100px] py-3 rounded-2xl text-sm font-medium transition-all ${side === btnLabel ? "bg-rose-500 text-white shadow-md" : "bg-white border border-gray-100 text-gray-500"
                  }`}
              >
                {btnLabel}
              </button>
            ))}
          </div>
        </section>

        {/* Step 2 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 text-xs flex items-center justify-center font-bold">
                2
              </span>
              <h3 className="font-semibold text-gray-800">{t.step2}</h3>
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={sendMoneyOnly}
                onChange={(e) => setSendMoneyOnly(e.target.checked)}
                className="accent-rose-500"
              />
              <span className="text-xs text-gray-400">{t.skipMessage}</span>
            </label>
          </div>

          {/* 🔧 수정: 메시지 생략 시 기본 문구를 “회색 텍스트”로 실제 표시 */}
          {sendMoneyOnly ? (
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <p className="text-sm text-gray-400">{DEFAULT_DISPLAY_MESSAGE}</p>
            </div>
          ) : (
            <div className="animate-in slide-in-from-top-2 duration-300">
              <textarea
                rows={3}
                placeholder={t.messagePH}
                className="w-full p-4 bg-white border border-gray-100 rounded-2xl text-sm shadow-sm focus:border-rose-200 outline-none resize-none"
                maxLength={MESSAGE_MAX}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => setDisplayMode("nickname")}
                  className={`px-4 py-2 rounded-full text-[11px] border transition ${displayMode === "nickname"
                    ? "bg-gray-800 text-white border-gray-800"
                    : "bg-white text-gray-400 border-gray-100"
                    }`}
                >
                  {t.nickname}
                </button>
                <button
                  onClick={() => setDisplayMode("anonymous")}
                  className={`px-4 py-2 rounded-full text-[11px] border transition ${displayMode === "anonymous"
                    ? "bg-gray-800 text-white border-gray-800"
                    : "bg-white text-gray-400 border-gray-100"
                    }`}
                >
                  {t.anonymous}
                </button>

                {displayMode === "nickname" && (
                  <input
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder={lang === "KO" ? "닉네임(선택)" : "Nickname (optional)"}
                    className="ml-auto w-36 bg-white border-b border-gray-200 py-2 px-1 text-xs focus:border-rose-300 outline-none transition"
                  />
                )}
              </div>
            </div>
          )}
        </section>

        {/* Step 3 */}
        {side && (
          <section className="space-y-4 animate-in fade-in duration-500">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 text-xs flex items-center justify-center font-bold">
                3
              </span>
              <h3 className="font-semibold text-gray-800">{t.step3}</h3>
            </div>

            <div className="space-y-2">
              {filteredAccounts.map((acc) => (
                <button
                  key={acc.id}
                  onClick={() => setSelectedAccountId(acc.id)}
                  className={`w-full p-4 rounded-2xl text-left border transition-all ${selectedAccountId === acc.id
                    ? "border-rose-400 bg-rose-50/50 ring-1 ring-rose-400"
                    : "border-gray-100 bg-white"
                    }`}
                >
                  <p className="text-[10px] font-bold text-rose-400 uppercase">{acc.label}</p>
                  <p className="text-sm font-semibold">
                    {acc.holder_name ?? "-"}{" "}
                    <span className="text-gray-400 font-normal ml-1">| {acc.bank_name ?? "-"}</span>
                  </p>
                </button>
              ))}

              {filteredAccounts.length > 0 && !selectedAccountId && (
                <p className="text-xs text-rose-400 mt-1">{t.selectAccount}</p>
              )}
            </div>
          </section>
        )}        {/* Submit */}
        <div className="pt-2">
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold shadow-xl active:scale-[0.98] disabled:bg-gray-300 transition-all"
          >
            {loading ? t.sending : t.nextBtn}
          </button>
          <p className="text-center text-[10px] text-gray-400 mt-4">{t.infoUse}</p>
        </div>
      </main>
    </div>
  );
}

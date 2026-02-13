// src/pages/DisplayPage.tsx
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getEventPhase, type EventPhase } from "../lib/time";

interface RouteParams {
  eventId: string;
}

type MessageRow = {
  id: string;
  body: string;
  nickname: string | null;
  created_at: string;
};

type Schedule = {
  start: string;
  end: string;
};

type DisplayStyle = "basic" | "christmas" | "garden" | "luxury";
type BackgroundMode = "photo" | "template";

const POLL_INTERVAL_MS = 5000;
const SLIDE_DURATION_MS = 6000; // ✅ 사진 슬라이드 전환 기본값
const FOOTER_HEIGHT_PX = 64;

// ✅ 영상 안전장치: duration을 못 읽어도 최소 이만큼은 기다림(충분히 넉넉하게)
const VIDEO_SAFETY_FALLBACK_MS = 15 * 60 * 1000; // 15분
const VIDEO_SAFETY_PADDING_MS = 2000; // duration + 2초 여유

type FloatingItem = {
  key: string;
  message: MessageRow;
  leftPct: number;
  durationMs: number;
};

// ✅ recipients jsonb fallback용
type Recipient = {
  name: string;
  role: string;
  contact: string | null;
};

function InstagramIcon({
  size = 18,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M7.5 2.75h9A4.75 4.75 0 0 1 21.25 7.5v9A4.75 4.75 0 0 1 16.5 21.25h-9A4.75 4.75 0 0 1 2.75 16.5v-9A4.75 4.75 0 0 1 7.5 2.75Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M12 16.25A4.25 4.25 0 1 0 12 7.75a4.25 4.25 0 0 0 0 8.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M17.2 6.8h.01"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ✅ URL이 영상인지 판별
function isVideoUrl(url: string) {
  const u = (url || "").toLowerCase().split("?")[0];
  return (
    u.endsWith(".mp4") ||
    u.endsWith(".mov") ||
    u.endsWith(".m4v") ||
    u.endsWith(".webm") ||
    u.endsWith(".ogg")
  );
}

export default function DisplayPage() {
  const { eventId } = useParams<RouteParams>();

  /** ✅ 회전(가로/세로) 자동 반영 */
  const [isPortrait, setIsPortrait] = useState(
    window.matchMedia("(orientation: portrait)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const handler = (e: MediaQueryListEvent) => setIsPortrait(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  const [activeItems, setActiveItems] = useState<FloatingItem[]>([]);
  const rotationQueueRef = useRef<MessageRow[]>([]);
  const knownIdsRef = useRef<Set<string>>(new Set());

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [lowerMessage, setLowerMessage] = useState(
    "자리를 빛내주셔서 감사합니다."
  );
  const [dateText, setDateText] = useState("");

  const [groomName, setGroomName] = useState("");
  const [brideName, setBrideName] = useState("");

  // ✅ recipients를 state로 보관 (라벨/이름 모두 여기서 컨트롤 가능)
  const [recipients, setRecipients] = useState<Recipient[]>([]);

  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [now, setNow] = useState(new Date());

  const [displayStyle, setDisplayStyle] = useState<DisplayStyle>("basic");
  const [backgroundMode, setBackgroundMode] =
    useState<BackgroundMode>("template");
  const [mediaUrls, setMediaUrls] = useState<string[]>([]);
  const [currentSlide, setCurrentSlide] = useState(0);

  // ✅ 오디오/비디오 ref
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  /* ---------- time ---------- */
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  /* ---------- fetch messages ---------- */
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;

    async function fetchMessages() {
      const { data, error } = await supabase
        .from("messages")
        .select("id, body, nickname, created_at")
        .eq("event_id", eventId)
        .eq("is_hidden", false)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("[DisplayPage] messages select error:", error);
        return;
      }
      if (!data || cancelled) return;

      if (data.length > 0) {
        setLastUpdated(new Date(data[data.length - 1].created_at));
      }

      data.forEach((m) => {
        if (!knownIdsRef.current.has(m.id)) {
          knownIdsRef.current.add(m.id);
          rotationQueueRef.current.push(m);
        }
      });
    }

    fetchMessages();
    const t = setInterval(fetchMessages, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [eventId]);

  /* ---------- settings ---------- */
  useEffect(() => {
    if (!eventId) return;

    supabase
      .from("event_settings")
      .select(
        "lower_message, ceremony_date, ceremony_start_time, ceremony_end_time, display_style, background_mode, media_urls, recipients"
      )
      .eq("event_id", eventId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error)
          console.error("[DisplayPage] event_settings select error:", error);
        if (!data) return;

        if (data.lower_message) setLowerMessage(data.lower_message);

        if (data.ceremony_date) {
          const [y, m, d] = data.ceremony_date.split("-");
          setDateText(`${y}년 ${Number(m)}월 ${Number(d)}일`);
        }

        if (data.ceremony_start_time && data.ceremony_end_time) {
          setSchedule({
            start: `${data.ceremony_date}T${data.ceremony_start_time}:00`,
            end: `${data.ceremony_date}T${data.ceremony_end_time}:00`,
          });
        }

        setDisplayStyle((data.display_style as DisplayStyle) ?? "basic");
        setBackgroundMode((data.background_mode as BackgroundMode) ?? "template");
        setMediaUrls(Array.isArray(data.media_urls) ? data.media_urls : []);

        // ✅ recipients 저장 (라벨/이름 커스텀용)
        const recs = Array.isArray(data.recipients)
          ? (data.recipients as Recipient[])
          : [];
        setRecipients(recs);

        // ✅ (fallback 1) event_settings.recipients에서 이름 채우기
        // - 기본 결혼식: role이 '신랑/신부'면 그걸 우선
        // - 특수 이벤트: role이 다르면 "1번/2번" 순서로 이름을 보조로 채움(단, 기존 이름이 비어있을 때만)
        const groom = recs.find((r) => r?.role === "신랑")?.name;
        const bride = recs.find((r) => r?.role === "신부")?.name;

        if (!groomName) {
          if (groom) setGroomName(groom);
          else if (recs?.[0]?.name) setGroomName(recs[0].name);
        }
        if (!brideName) {
          if (bride) setBrideName(bride);
          else if (recs?.[1]?.name) setBrideName(recs[1].name);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  /* ---------- names (primary) ---------- */
  useEffect(() => {
    if (!eventId) return;

    (async () => {
      const { data, error } = await supabase
        .from("events")
        .select("groom_name, bride_name")
        .eq("id", eventId)
        .maybeSingle();

      if (error) {
        console.error("[DisplayPage] events select error:", error);
        return;
      }
      if (!data) {
        console.warn(
          "[DisplayPage] events data is null (maybe RLS?) eventId:",
          eventId
        );
        return;
      }

      // ✅ events 값이 있으면 그게 1순위
      setGroomName(data.groom_name ?? "");
      setBrideName(data.bride_name ?? "");

      // ✅ 혹시 events에 값이 비어있으면 event_settings에서 한번 더 시도
      if (!data.groom_name || !data.bride_name) {
        const { data: s, error: sErr } = await supabase
          .from("event_settings")
          .select("recipients")
          .eq("event_id", eventId)
          .maybeSingle();

        if (sErr) console.error("[DisplayPage] fallback recipients error:", sErr);

        const recs = Array.isArray(s?.recipients)
          ? (s!.recipients as Recipient[])
          : [];

        const groom = recs.find((r) => r?.role === "신랑")?.name;
        const bride = recs.find((r) => r?.role === "신부")?.name;

        if (!data.groom_name) {
          if (groom) setGroomName(groom);
          else if (recs?.[0]?.name) setGroomName(recs[0].name);
        }
        if (!data.bride_name) {
          if (bride) setBrideName(bride);
          else if (recs?.[1]?.name) setBrideName(recs[1].name);
        }
      }
    })();
  }, [eventId]);

  /* ---------- phase ---------- */
  const phase: EventPhase = useMemo(() => {
    if (!schedule) return "open";
    return getEventPhase(now, new Date(schedule.start), new Date(schedule.end));
  }, [now, schedule]);

  /* ---------- photo/video slide ---------- */
  const usePhotoBackground =
    backgroundMode === "photo" && mediaUrls.length > 0;

  const currentMediaUrl = useMemo(() => {
    if (!usePhotoBackground || mediaUrls.length === 0) return "";
    return mediaUrls[currentSlide] ?? "";
  }, [usePhotoBackground, mediaUrls, currentSlide]);

  const currentIsVideo = useMemo(() => {
    return !!currentMediaUrl && isVideoUrl(currentMediaUrl);
  }, [currentMediaUrl]);

  const advanceSlide = () => {
    if (!usePhotoBackground || mediaUrls.length <= 1) return;
    setCurrentSlide((p) => (p + 1) % mediaUrls.length);
  };

  // ✅ 1) 사진은 SLIDE_DURATION_MS로 넘어감
  // ✅ 2) 영상은 "끝나면" 넘어감 (onEnded)
  // ✅ 3) 안전장치: duration 기반으로 "충분히 넉넉"하게 (더 이상 90/120초로 자르지 않음)
  useEffect(() => {
    if (!usePhotoBackground || mediaUrls.length <= 1) {
      setCurrentSlide(0);
      return;
    }

    // 사진이면 타이머로 다음
    if (!currentIsVideo) {
      const t = window.setTimeout(() => advanceSlide(), SLIDE_DURATION_MS);
      return () => window.clearTimeout(t);
    }

    // 영상이면 onEnded가 1순위. 안전장치는 '예외 상황' 대비
    const v = videoRef.current;

    const durationSec =
      v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;

    const safetyMs =
      durationSec > 0
        ? Math.round(durationSec * 1000) + VIDEO_SAFETY_PADDING_MS
        : VIDEO_SAFETY_FALLBACK_MS;

    const safety = window.setTimeout(() => {
      // onEnded가 안 오는 특이 케이스(메타데이터 깨짐/스트림 등) 대비
      advanceSlide();
    }, safetyMs);

    return () => window.clearTimeout(safety);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usePhotoBackground, mediaUrls.length, currentSlide, currentIsVideo]);

  // ✅ 사운드 정책:
  // - 사진: BGM play
  // - 영상: BGM pause + 영상 음소거 해제 시도
  useEffect(() => {
    const bgm = bgmRef.current;

    // 사진/템플릿일 때는 bgm 유지
    if (!currentIsVideo) {
      if (bgm) {
        bgm.muted = false;
        bgm.volume = 1;
        bgm.play().catch(() => {});
      }
      return;
    }

    // 영상일 때: bgm 멈추고, 영상 소리 시도
    if (bgm) bgm.pause();

    const v = videoRef.current;
    if (!v) return;

    v.muted = false;
    v.volume = 1;

    v.play().catch(() => {
      // 소리 있는 autoplay가 막히면: muted로 먼저 시작 -> 이후 언뮤트 시도
      v.muted = true;
      v.play()
        .then(() => {
          window.setTimeout(() => {
            v.muted = false;
            v.volume = 1;
          }, 300);
        })
        .catch(() => {});
    });
  }, [currentIsVideo, currentMediaUrl]);

  /* ---------- ✅ 자동 밀도 ---------- */
  const queueLen = rotationQueueRef.current.length;

  const maxActive = useMemo(() => {
    if (isPortrait) return Math.min(9, Math.max(3, Math.round(queueLen * 0.38)));
    return Math.min(12, Math.max(4, Math.round(queueLen * 0.42)));
  }, [queueLen, isPortrait]);

  const intervalMs = useMemo(() => {
    const base = isPortrait ? 1500 : 1350;
    const v = Math.round(base - queueLen * (isPortrait ? 50 : 55));
    return Math.min(1600, Math.max(500, v));
  }, [queueLen, isPortrait]);

  /* ---------- ✅ 헤더/폰트 ---------- */
  const topBarHeight = isPortrait ? "26vh" : "28vh";

  const groomBrideLabelClass = isPortrait ? "text-4xl" : "text-2xl";
  const groomBrideGapClass = isPortrait ? "mb-3" : "mb-2";

  const roleLabelStyle: CSSProperties = {
    letterSpacing: "0.02em",
    fontFamily: "Noto Serif KR, Nanum Myeongjo, serif",
  };

  const nameStyle: CSSProperties = isPortrait
    ? {
        fontFamily: "Noto Serif KR, Nanum Myeongjo, serif",
        fontSize: "clamp(46px, 4.6vw, 84px)",
        lineHeight: 1.03,
      }
    : {
        fontFamily: "Noto Serif KR, Nanum Myeongjo, serif",
        fontSize: "clamp(28px, 4.2vw, 64px)",
        lineHeight: 1.05,
      };

  const titleStyle: CSSProperties = {
  fontFamily: "'Playfair Display', serif",
  fontSize: "clamp(60px, 5vw, 100px)",
  letterSpacing: "0.03em",
  lineHeight: 1.1,
};


  const lowerStyle: CSSProperties = isPortrait
    ? { fontSize: "clamp(30px, 2.6vw, 46px)" }
    : { fontSize: "clamp(14px, 1.6vw, 24px)" };

  const dateStyle: CSSProperties = isPortrait
    ? { fontSize: "clamp(24px, 2.2vw, 36px)" }
    : { fontSize: "clamp(12px, 1.4vw, 18px)" };

  const qrSize = isPortrait
    ? "clamp(200px, 15vw, 280px)"
    : "clamp(80px, 8vw, 120px)";

  /* ---------- ✅ 라벨(역할) : 기본 신랑/신부, 있으면 Supabase recipients.role 반영 ---------- */
  const leftRoleLabel = recipients?.[0]?.role || "신랑";
  const rightRoleLabel = recipients?.[1]?.role || "신부";

  /* ---------- ✅ 한글 가독성/좌우 안전 ---------- */
  const getSafeRange = (len: number) => {
    if (isPortrait) {
      if (len >= 70) return { min: 24, max: 76 };
      if (len >= 45) return { min: 20, max: 80 };
      return { min: 16, max: 84 };
    }
    if (len >= 70) return { min: 22, max: 78 };
    if (len >= 45) return { min: 18, max: 82 };
    return { min: 14, max: 86 };
  };

  /* ---------- floating spawn (INFINITE) ---------- */
  useEffect(() => {
    if (phase === "closed") return;

    const t = setInterval(() => {
      if (rotationQueueRef.current.length === 0) return;
      if (activeItems.length >= maxActive) return;

      const msg = rotationQueueRef.current.shift();
      if (!msg) return;
      rotationQueueRef.current.push(msg);

      const len = msg.body.length;
      const { min, max } = getSafeRange(len);

      const candidates = Array.from(
        { length: 12 },
        () => min + Math.random() * (max - min)
      );
      const chosen = candidates.find((x) => {
        const minGap = isPortrait
          ? len >= 60
            ? 16
            : 14
          : len >= 60
          ? 14
          : 12;
        return !activeItems.some((a) => Math.abs(a.leftPct - x) < minGap);
      });

      if (chosen === undefined) return;

      const durationMs =
        (isPortrait ? 15500 : 13200) +
        Math.min(6500, Math.max(0, len - 30) * 120);

      setActiveItems((prev) => [
        ...prev,
        {
          key: `${msg.id}-${Date.now()}`,
          message: msg,
          leftPct: chosen,
          durationMs,
        },
      ]);
    }, intervalMs);

    return () => clearInterval(t);
  }, [activeItems, phase, intervalMs, maxActive, isPortrait]);

  /* ---------- render ---------- */
  return (
    <div className="relative min-h-screen bg-black overflow-hidden">
      <style>{`
        @keyframes floatUp {
          0%   { transform: translate(-50%, 12vh) scale(0.98); opacity: 0; }
          3%   { opacity: 1; }
          90%  { opacity: 1; }
          100% { transform: translate(-50%, -160vh) scale(1); opacity: 0; }
        }
      `}</style>

      {/* ✅ 사진/템플릿일 때만 BGM을 쓰는 정책 (영상일 때는 pause 처리) */}
      <audio ref={bgmRef} src="/bgm.m4a" autoPlay loop preload="auto" />

      {/* FLOATING (z-30) */}
      <div className="absolute inset-0 overflow-hidden z-30 pointer-events-none">
        {activeItems.map((item) => (
          <div
            key={item.key}
            className="absolute left-1/2 bottom-0 max-w-2xl px-10 py-8 rounded-[32px]
                       text-white text-center shadow-lg backdrop-blur-md"
            style={{
              left: `${item.leftPct}%`,
              backgroundColor: "rgba(0,0,0,0.28)",
              fontFamily: "Nanum Pen Script, cursive",
              animation: `floatUp ${item.durationMs}ms linear`,
              animationFillMode: "both",
              width: "auto",
              maxWidth: isPortrait ? "78vw" : "62vw",
              wordBreak: "keep-all",
              overflowWrap: "break-word",
              whiteSpace: "pre-wrap",
            }}
            onAnimationEnd={() =>
              setActiveItems((prev) => prev.filter((p) => p.key !== item.key))
            }
          >
            <p className={isPortrait ? "text-6xl leading-tight" : "text-5xl leading-tight"}>
              {item.message.body}
            </p>
            {item.message.nickname && (
              <p className={isPortrait ? "mt-6 text-4xl text-pink-200" : "mt-5 text-3xl text-pink-200"}>
                {item.message.nickname}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* TOP */}
      <header
        className="relative w-full flex items-center justify-center px-6"
        style={{ height: topBarHeight }}
      >
        <div
          className="absolute inset-0 z-20"
          style={{
            backgroundColor:
              !isPortrait && usePhotoBackground && !currentIsVideo
                ? "rgba(0,0,0,0.92)" // ✅ 가로+사진이면 거의 불투명 → 블러가 위로 안 비침
                : "rgba(0,0,0,0.40)", // 그 외는 기존 느낌 유지
          }}
        />

        <div className="relative w-full max-w-6xl flex items-center justify-center z-40">
          {/*<div className="text-right">
            <p
              className={`${groomBrideLabelClass} ${groomBrideGapClass} text-white/70`}
              style={roleLabelStyle}
            >
              {leftRoleLabel}
            </p>
            <p className="text-white font-bold" style={nameStyle}>
              {groomName}
            </p>
          </div>*/}

          <div className="text-center">
            <p className="text-white font-bold mb-3" style={titleStyle}>
              SOLAS's HBD Party
            </p>

            <img
              src="/party_qr.png"
              className="mx-auto"
              style={{ width: qrSize, height: qrSize }}
              alt="QR"
            />

            <p className="mt-3 text-white/90" style={lowerStyle}>
              {lowerMessage}
            </p>

            {dateText && (
              <p className="text-white/70" style={dateStyle}>
                {dateText}
              </p>
            )}
          </div>

          {/*<div className="text-left">
            <p
              className={`${groomBrideLabelClass} ${groomBrideGapClass} text-white/70`}
              style={roleLabelStyle}
            >
              {rightRoleLabel}
            </p>
            <p className="text-white font-bold" style={nameStyle}>
              {brideName}
            </p>
          </div>*/}
        </div>
      </header>

      
      {/* MAIN */}
<section
  className="relative flex-1 overflow-hidden"
  style={{
    minHeight: `calc(100vh - ${topBarHeight} - ${FOOTER_HEIGHT_PX}px)`,
  }}
>
  {usePhotoBackground ? (
    currentIsVideo ? (
      isPortrait ? (
        // ✅ 세로 영상: 꽉 채우되 상단 보존
        <video
          ref={videoRef}
          key={currentMediaUrl}
          src={currentMediaUrl}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ objectPosition: "center top" }}
          autoPlay
          playsInline
          preload="auto"
          onEnded={() => advanceSlide()}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (!v) return;
            v.play().catch(() => {});
          }}
        />
      ) : (
        // ✅ 가로 영상: contain + 블러 배경
        <>
          <video
            key={`blur-${currentMediaUrl}`}
            src={currentMediaUrl}
            className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl opacity-60"
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
          />
          <video
            ref={videoRef}
            key={currentMediaUrl}
            src={currentMediaUrl}
            className="absolute inset-0 w-full h-full object-contain"
            autoPlay
            playsInline
            preload="auto"
            onEnded={() => advanceSlide()}
            onLoadedMetadata={() => {
              const v = videoRef.current;
              if (!v) return;
              v.play().catch(() => {});
            }}
          />
        </>
      )
    ) : isPortrait ? (
      // ✅ 세로 사진: cover
      <img
        src={currentMediaUrl}
        className="absolute inset-0 w-full h-full object-cover"
        alt="background"
      />
    ) : (
      // ✅ 가로 사진: blur 배경 + 원본 contain (원본 위 오버레이 없음)
      <>
        <img
          src={currentMediaUrl}
          className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl opacity-60"
          alt="background blur"
        />
        <img
          src={currentMediaUrl}
          className="absolute inset-0 w-full h-full object-contain"
          alt="background contain"
        />
      </>
    )
  ) : (
    <div
      className="absolute inset-0 bg-cover bg-center"
      style={{
        backgroundImage: `url(/display-templates/${displayStyle}/background.jpg)`,
      }}
    />
  )}
</section>


      {/* FOOTER */}
      <footer
        className="relative z-50 w-full flex items-center justify-between px-6 bg-black/70 text-white"
        style={{ height: FOOTER_HEIGHT_PX }}
      >
        <span>
          마지막 업데이트:{" "}
          {lastUpdated?.toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>

        <span className="flex items-center gap-2 text-white/90">
          <InstagramIcon className="text-white/90" />
          <span>@digital_guestbook</span>
        </span>
      </footer>
    </div>
  );
}

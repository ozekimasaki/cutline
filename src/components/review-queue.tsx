import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { verdictLabel } from "@/lib/decide";
import { formatClock, formatPercent, formatRange } from "@/lib/format";
import { buildHumanCorrectionTime } from "@/lib/metrics";
import type { Job, ScoredClip, SemanticRole } from "@/lib/types";
import { cn } from "@/lib/utils";

export type ReviewBeatId = "before" | "target" | "after";

export type ReviewBeat = {
  id: ReviewBeatId;
  startMs: number;
  endMs: number;
};

const REVIEW_PAD_MS = 3000;

export function reviewPlayBeats(
  clip: { startMs: number; endMs: number },
  padMs = REVIEW_PAD_MS,
): ReviewBeat[] {
  const beats: ReviewBeat[] = [
    {
      id: "before",
      startMs: Math.max(0, clip.startMs - padMs),
      endMs: clip.startMs,
    },
    { id: "target", startMs: clip.startMs, endMs: clip.endMs },
    { id: "after", startMs: clip.endMs, endMs: clip.endMs + padMs },
  ];
  return beats.filter((beat) => beat.endMs > beat.startMs);
}

type PlaySession = {
  clipId: string;
  beats: ReviewBeat[];
  index: number;
};

export function ReviewQueue({
  clips,
  ready,
  jobId,
  sourceDurationMs = 0,
  savedReviewMs = 0,
  onSeek,
  onPause,
  onSelect,
  onVerdict,
  onJob,
}: {
  clips: ScoredClip[];
  ready: boolean;
  jobId?: string;
  sourceDurationMs?: number;
  savedReviewMs?: number;
  onSeek: (ms: number) => void;
  onPause?: () => void;
  onSelect: (clipId: string, startMs: number) => void;
  onVerdict: (
    clipId: string,
    verdict: "keep" | "cut" | "shorten",
    reviewSessionMs?: number,
  ) => void | Promise<void>;
  onJob?: (update: (current: Job) => Job) => void;
}) {
  const [playing, setPlaying] = useState<PlaySession | null>(null);
  const clockRef = useRef({ jobId: "", accumulatedMs: 0, lastTick: 0 });
  const [reviewSessionMs, setReviewSessionMs] = useState(savedReviewMs);
  const autoPlayedRef = useRef<string | null>(null);
  const hctInFlightRef = useRef(false);
  const hctTokenRef = useRef(0);
  const verdictInFlightRef = useRef(0);
  const verdictEpochRef = useRef(0);

  const startBeats = useCallback(
    (clip: ScoredClip) => {
      const beats = reviewPlayBeats(clip);
      if (beats.length === 0) {
        return;
      }
      setPlaying({ clipId: clip.id, beats, index: 0 });
      onSeek(beats[0]!.startMs);
    },
    [onSeek],
  );

  useEffect(() => {
    if (!playing) {
      return;
    }
    const beat = playing.beats[playing.index];
    if (!beat) {
      onPause?.();
      setPlaying(null);
      return;
    }
    const duration = Math.max(80, beat.endMs - beat.startMs);
    const timer = window.setTimeout(() => {
      const nextIndex = playing.index + 1;
      const nextBeat = playing.beats[nextIndex];
      if (!nextBeat) {
        onPause?.();
        setPlaying(null);
        return;
      }
      setPlaying({ ...playing, index: nextIndex });
      onSeek(nextBeat.startMs);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [onPause, onSeek, playing]);

  useEffect(() => {
    if (!ready) {
      autoPlayedRef.current = null;
      return;
    }
    const first = clips.find((clip) => clip.verdict === "review") ?? clips[0];
    if (!first || autoPlayedRef.current === first.id) {
      return;
    }
    autoPlayedRef.current = first.id;
    startBeats(first);
  }, [clips, ready, startBeats]);

  useEffect(() => {
    if (!jobId) {
      return;
    }
    if (clockRef.current.jobId !== jobId) {
      clockRef.current = {
        jobId,
        accumulatedMs: savedReviewMs,
        lastTick: Date.now(),
      };
      setReviewSessionMs(savedReviewMs);
    }
  }, [jobId, savedReviewMs]);

  useEffect(() => {
    if (!ready || !jobId) {
      return;
    }
    clockRef.current.lastTick = Date.now();
    const tick = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        clockRef.current.lastTick = Date.now();
        return;
      }
      const now = Date.now();
      clockRef.current.accumulatedMs += now - clockRef.current.lastTick;
      clockRef.current.lastTick = now;
      setReviewSessionMs(clockRef.current.accumulatedMs);
    }, 1000);
    const save = (keepalive: boolean) => {
      if (hctInFlightRef.current || verdictInFlightRef.current > 0) {
        return;
      }
      const epoch = verdictEpochRef.current;
      const token = ++hctTokenRef.current;
      hctInFlightRef.current = true;
      void persistHct(jobId, clockRef.current.accumulatedMs, keepalive)
        .then((next) => {
          if (!next || hctTokenRef.current !== token) {
            return;
          }
          if (
            verdictInFlightRef.current > 0 ||
            verdictEpochRef.current !== epoch
          ) {
            return;
          }
          onJob?.((current) => mergeHctMetrics(current, next));
        })
        .finally(() => {
          if (hctTokenRef.current === token) {
            hctInFlightRef.current = false;
          }
        });
    };
    const persist = window.setInterval(() => {
      save(false);
    }, 5000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(persist);
      save(true);
    };
  }, [jobId, onJob, ready]);

  if (!ready) {
    return <EmptyReview text="判定が終わるまで、確認待ちは空です。" />;
  }
  if (clips.length === 0) {
    return <EmptyReview text="クリップがまだありません。" />;
  }

  const review = clips.filter((clip) => clip.verdict === "review");
  const cut = clips.filter((clip) => clip.verdict === "cut");
  const keep = clips.filter((clip) => clip.verdict === "keep");
  const hct = buildHumanCorrectionTime({
    sourceDurationMs,
    aiReviewMs: reviewSessionMs,
  });

  const handleVerdict = (
    clipId: string,
    verdict: "keep" | "cut" | "shorten",
  ) => {
    verdictEpochRef.current += 1;
    verdictInFlightRef.current += 1;
    void Promise.resolve(
      onVerdict(clipId, verdict, clockRef.current.accumulatedMs),
    ).finally(() => {
      verdictInFlightRef.current = Math.max(0, verdictInFlightRef.current - 1);
    });
  };

  return (
    <div className="grid gap-4">
      <HctPanel hct={hct} />
      {review.length === 0 ? (
        <EmptyReview text="確認待ちはありません。下から直せます。" />
      ) : (
        <ClipList
          clips={review}
          playing={playing}
          onSelect={onSelect}
          onPlayBeats={startBeats}
          onVerdict={handleVerdict}
        />
      )}
      {cut.length > 0 ? (
        <section className="grid gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            AIが切ったもの · 残すに戻すと覚えます
          </p>
          <ClipList
            clips={cut}
            playing={playing}
            onSelect={onSelect}
            onPlayBeats={startBeats}
            onVerdict={handleVerdict}
          />
        </section>
      ) : null}
      {keep.length > 0 ? (
        <section className="grid gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            AIが残したもの · 切ると覚えます
          </p>
          <ClipList
            clips={keep}
            playing={playing}
            onSelect={onSelect}
            onPlayBeats={startBeats}
            onVerdict={handleVerdict}
          />
        </section>
      ) : null}
    </div>
  );
}

function HctPanel({
  hct,
}: {
  hct: ReturnType<typeof buildHumanCorrectionTime>;
}) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">確認にかかった時間</p>
      <p>
        手作業 {formatClock(hct.sourceDurationMs)} → 編集{" "}
        {formatClock(hct.aiNoneEditMs)}
      </p>
      <p>
        AIあり {formatClock(hct.sourceDurationMs)} → 確認{" "}
        {formatClock(hct.aiReviewMs)}
      </p>
      <p>削減 {formatClock(hct.savedMs)}</p>
    </div>
  );
}

function ClipList({
  clips,
  playing,
  onSelect,
  onPlayBeats,
  onVerdict,
}: {
  clips: ScoredClip[];
  playing: PlaySession | null;
  onSelect: (clipId: string, startMs: number) => void;
  onPlayBeats: (clip: ScoredClip) => void;
  onVerdict: (clipId: string, verdict: "keep" | "cut" | "shorten") => void;
}) {
  return (
    <div className="grid gap-3">
      {clips.map((clip) => (
        <Card key={clip.id} size="sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-sm">
                  {clip.speaker} · {formatRange(clip.startMs, clip.endMs)}
                </CardTitle>
                <CardDescription>
                  {roleCopy(clip.role)} / 残す {formatPercent(clip.keepScore)} /
                  信頼 {formatPercent(clip.signals.confidence)}
                  {clip.camera ? ` / CAM ${clip.camera}` : ""}
                </CardDescription>
              </div>
              <Badge variant="outline">{verdictLabel(clip.verdict)}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
            <p className="text-sm">{clip.text || "（無音・間）"}</p>
            <p className="text-xs text-muted-foreground">{clip.reason}</p>
            <BeatStrip
              clip={clip}
              activeId={
                playing?.clipId === clip.id
                  ? (playing.beats[playing.index]?.id ?? null)
                  : null
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSelect(clip.id, clip.startMs)}
              >
                理由を見る
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPlayBeats(clip)}
              >
                前後3秒
              </Button>
              <Button size="sm" onClick={() => onVerdict(clip.id, "keep")}>
                残す
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => onVerdict(clip.id, "cut")}
              >
                切る
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onVerdict(clip.id, "shorten")}
              >
                短くする
              </Button>
            </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function BeatStrip({
  clip,
  activeId,
}: {
  clip: ScoredClip;
  activeId: ReviewBeatId | null;
}) {
  const present = new Set(reviewPlayBeats(clip).map((beat) => beat.id));
  const ids: ReviewBeatId[] = ["before", "target", "after"];
  return (
    <ol className="grid gap-1" aria-label="前後3秒の再生">
      {ids.map((id) => (
        <li key={id}>
          <span
            className={cn(
              "inline-flex rounded-md px-2 py-0.5 font-mono text-xs",
              activeId === id
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground",
              !present.has(id) && "opacity-40",
            )}
          >
            {beatLabel(id)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function beatLabel(id: ReviewBeatId): string {
  switch (id) {
    case "before":
      return "前3秒";
    case "target":
      return "対象";
    case "after":
      return "後3秒";
    default: {
      const _never: never = id;
      return _never;
    }
  }
}

function EmptyReview({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed bg-card px-4 py-10 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function roleCopy(role: SemanticRole): string {
  switch (role) {
    case "content":
      return "本文";
    case "filler":
      return "フィラー";
    case "false_start":
      return "言い直し前";
    case "self_correction":
      return "自己訂正";
    case "pause":
      return "間";
    case "backchannel":
      return "相槌";
    default: {
      const _never: never = role;
      return _never;
    }
  }
}

export function mergeHctMetrics(current: Job, incoming: Job): Job {
  if (current.id !== incoming.id || incoming.metrics == null) {
    return current;
  }
  return { ...current, metrics: incoming.metrics };
}

async function persistHct(
  jobId: string,
  reviewSessionMs: number,
  keepalive = false,
): Promise<Job | null> {
  try {
    const response = await fetch(`/api/jobs/${jobId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewSessionMs }),
      keepalive,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Job;
  } catch {
    return null;
  }
}

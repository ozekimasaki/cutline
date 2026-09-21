import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { durationOf, keptClips, profileLabel, verdictLabel } from "@/lib/decide";
import { formatClock, formatPercent, formatRange } from "@/lib/format";
import {
  MIN_TARGET_MINUTES,
  SAMPLE_DURATION_MS,
  clampTargetMinutes,
  minutesFromSourceMs,
} from "@/lib/target-duration";
import type {
  ChannelProfile,
  EditProfile,
  Job,
  JobPhase,
  ProviderStatus,
  ScoredClip,
  SemanticRole,
} from "@/lib/types";
import { DEFAULT_CHANNEL_PROFILE, SIGNAL_KEYS } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChannelProfileForm } from "@/components/channel-profile-form";
import { ReviewQueue } from "@/components/review-queue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const PROFILES: { id: EditProfile; hint: string }[] = [
  { id: "natural", hint: "間と人間味を厚めに残す" },
  { id: "standard", hint: "フィラーと言い直しを落とす" },
  { id: "tight", hint: "冗長を強く切る" },
  { id: "short", hint: "重要度の高い発話だけ残す" },
];

const SAMPLE_TARGET_MINUTES = minutesFromSourceMs(SAMPLE_DURATION_MS);

export function Editor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [brief, setBrief] = useState(
    "対談の言い直しとフィラーを落とし、考えている間は残す。",
  );
  const [profile, setProfile] = useState<EditProfile>("standard");
  const [channelProfile, setChannelProfile] = useState<ChannelProfile>(
    DEFAULT_CHANNEL_PROFILE,
  );
  const [sourceMinutes, setSourceMinutes] = useState(SAMPLE_TARGET_MINUTES);
  const [sourceKnown, setSourceKnown] = useState(true);
  const [targetMin, setTargetMin] = useState(SAMPLE_TARGET_MINUTES);
  const sourceMinutesRef = useRef(sourceMinutes);
  sourceMinutesRef.current = sourceMinutes;
  const [speakerCount, setSpeakerCount] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editedUrl, setEditedUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [previewMode, setPreviewMode] = useState<"source" | "edited">("source");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = job?.id ?? null;
  const pollGenerationRef = useRef(0);
  const pollSeqRef = useRef(0);
  const appliedPollSeqRef = useRef(0);
  const verdictChainRef = useRef<Promise<void>>(Promise.resolve());
  const verdictSeqRef = useRef(0);
  const appliedVerdictSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("接続状態を取得できませんでした。");
        }
        return (await response.json()) as ProviderStatus & {
          channelProfile?: ChannelProfile;
        };
      })
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          if (next.channelProfile) {
            setChannelProfile(next.channelProfile);
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatusError(
            error instanceof Error ? error.message : "接続状態の取得に失敗しました。",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pollingId =
    job && job.phase !== "ready" && job.phase !== "error" ? job.id : null;

  useEffect(() => {
    if (!pollingId) {
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      const requestedId = pollingId;
      const generation = pollGenerationRef.current;
      const seq = ++pollSeqRef.current;
      void fetch(`/api/jobs/${requestedId}`)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error("ジョブを更新できませんでした。");
          }
          return (await response.json()) as Job;
        })
        .then((next) => {
          if (
            staleJobGet({
              cancelled,
              nextId: next.id,
              requestedId,
              currentId: jobIdRef.current,
              issuedGeneration: generation,
              currentGeneration: pollGenerationRef.current,
              issuedSeq: seq,
              appliedSeq: appliedPollSeqRef.current,
            })
          ) {
            return;
          }
          appliedPollSeqRef.current = seq;
          setJob(next);
        })
        .catch((error: unknown) => {
          if (
            staleJobGet({
              cancelled,
              nextId: null,
              requestedId,
              currentId: jobIdRef.current,
              issuedGeneration: generation,
              currentGeneration: pollGenerationRef.current,
              issuedSeq: seq,
              appliedSeq: appliedPollSeqRef.current,
            })
          ) {
            return;
          }
          setActionError(
            error instanceof Error ? error.message : "ジョブの監視に失敗しました。",
          );
        });
    }, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollingId]);

  useEffect(() => {
    if (files.length === 0) {
      setSourceKnown(true);
      setSourceMinutes(SAMPLE_TARGET_MINUTES);
      setTargetMin((prev) =>
        clampTargetMinutes(
          prev > SAMPLE_TARGET_MINUTES ? SAMPLE_TARGET_MINUTES : prev,
          SAMPLE_TARGET_MINUTES,
        ),
      );
      return;
    }
    let cancelled = false;
    const currentCap = sourceMinutesRef.current;
    void Promise.all(files.map(probeFileDurationMs)).then((durations) => {
      if (cancelled) {
        return;
      }
      const longest = Math.max(0, ...durations);
      if (longest <= 0) {
        setSourceKnown(false);
        return;
      }
      const nextCap = minutesFromSourceMs(longest);
      setSourceKnown(true);
      setSourceMinutes(nextCap);
      setTargetMin((prev) => {
        if (prev === currentCap || prev > nextCap) {
          return nextCap;
        }
        return clampTargetMinutes(prev, nextCap);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [files]);

  const start = useCallback(
    async (useSample: boolean) => {
      setActionError(null);
      setEditedUrl(null);
      setPreviewMode("source");
      setBusy(true);
      try {
        const form = new FormData();
        form.set("brief", brief);
        form.set("profile", profile);
        form.set("channelProfile", JSON.stringify(channelProfile));
        if (useSample) {
          form.set(
            "targetDurationMs",
            String(
              clampTargetMinutes(targetMin, SAMPLE_TARGET_MINUTES) * 60 * 1000,
            ),
          );
        } else if (sourceKnown) {
          form.set(
            "targetDurationMs",
            String(clampTargetMinutes(targetMin, sourceMinutes) * 60 * 1000),
          );
        } else if (targetMin !== SAMPLE_TARGET_MINUTES) {
          form.set("targetDurationMs", String(targetMin * 60 * 1000));
        }
        form.set("useSample", useSample ? "true" : "false");
        if (speakerCount.trim()) {
          form.set("speakerCount", speakerCount.trim());
        }
        if (!useSample && files.length > 0) {
          form.set("file", files[0]!);
          for (const item of files) {
            form.append("files", item);
          }
        }
        const response = await fetch("/api/jobs", { method: "POST", body: form });
        const payload = (await response.json()) as Job & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "ジョブを開始できませんでした。");
        }
        pollGenerationRef.current += 1;
        jobIdRef.current = payload.id;
        setJob(payload);
        setSelectedClipId(null);
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "ジョブの開始に失敗しました。",
        );
      } finally {
        setBusy(false);
      }
    },
    [brief, channelProfile, files, profile, sourceKnown, sourceMinutes, speakerCount, targetMin],
  );

  const patchClip = useCallback(
    (
      clipId: string,
      verdict: "keep" | "cut" | "shorten",
      reviewSessionMs?: number,
    ): Promise<void> => {
      const targetId = jobIdRef.current;
      if (!targetId) {
        return Promise.resolve();
      }
      const seq = ++verdictSeqRef.current;
      const run = async (): Promise<void> => {
        if (jobIdRef.current !== targetId) {
          return;
        }
        setActionError(null);
        try {
          const response = await fetch(`/api/jobs/${targetId}/review`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clipId, verdict, reviewSessionMs }),
          });
          const payload = (await response.json()) as Job & { error?: string };
          if (!response.ok) {
            throw new Error(payload.error || "判定を更新できませんでした。");
          }
          if (payload.id !== targetId || jobIdRef.current !== targetId) {
            return;
          }
          if (seq < appliedVerdictSeqRef.current) {
            return;
          }
          appliedVerdictSeqRef.current = seq;
          pollGenerationRef.current += 1;
          setJob(payload);
          setEditedUrl(null);
          setPreviewMode("source");
        } catch (error) {
          if (jobIdRef.current !== targetId) {
            return;
          }
          setActionError(
            error instanceof Error ? error.message : "判定の更新に失敗しました。",
          );
        }
      };
      const finished = verdictChainRef.current.then(run, run);
      verdictChainRef.current = finished.then(
        () => undefined,
        () => undefined,
      );
      return finished;
    },
    [],
  );

  const applyHct = useCallback((update: (current: Job) => Job) => {
    pollGenerationRef.current += 1;
    setJob((current) => (current ? update(current) : current));
  }, []);

  const renderEdit = useCallback(async () => {
    if (!job) {
      return;
    }
    setRendering(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/export`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        url?: string;
        error?: string;
        validation?: Job["renderQa"];
        watchQa?: Job["watchQa"];
        encoder?: string;
      };
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "書き出しに失敗しました。");
      }
      setEditedUrl(`${payload.url}?t=${Date.now()}`);
      setPreviewMode("edited");
      pollGenerationRef.current += 1;
      setJob((current) =>
        current
          ? {
              ...current,
              renderQa: payload.validation ?? current.renderQa,
              watchQa: payload.watchQa ?? current.watchQa,
              encoder: payload.encoder ?? current.encoder,
            }
          : current,
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "書き出しに失敗しました。",
      );
    } finally {
      setRendering(false);
    }
  }, [job]);

  const seek = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = ms / 1000;
    void video.play();
  }, []);

  const pauseMedia = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  const keepMs = useMemo(
    () => (job ? keptClips(job.clips).reduce((sum, clip) => sum + durationOf(clip), 0) : 0),
    [job],
  );
  const selectedClip = useMemo(
    () => job?.clips.find((clip) => clip.id === selectedClipId) ?? null,
    [job, selectedClipId],
  );
  const selectClip = useCallback((clipId: string, startMs: number) => {
    setSelectedClipId(clipId);
    seek(startMs);
  }, [seek]);
  const sourceUrl = job?.mediaId ? `/api/media/${job.mediaId}` : null;
  const videoUrl = previewMode === "edited" && editedUrl ? editedUrl : sourceUrl;
  const running = Boolean(job && job.phase !== "ready" && job.phase !== "error");

  return (
    <div className="min-h-full bg-muted text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium tracking-widest text-muted-foreground">
              CUTLINE
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              対談の編集
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              素材を入れて、残すか切るかを確認する。
            </p>
          </div>
          <ProviderBadges status={status} error={statusError} />
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>はじめる</CardTitle>
            <CardDescription>
              キーがなくても、サンプルで試せる。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="file">カメラとマイク</Label>
              <Input
                id="file"
                type="file"
                multiple
                accept="video/mp4,video/*,audio/*,.wav,.mp4,.mov"
                onChange={(event) =>
                  setFiles(Array.from(event.target.files ?? []))
                }
              />
              <p className="text-xs text-muted-foreground">
                {files.length
                  ? files.map((item) => item.name).join(" / ")
                  : "複数ファイル可。なければサンプルで。"}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="brief">メモ</Label>
              <Textarea
                id="brief"
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                rows={3}
              />
            </div>
            <div className="grid gap-2">
              <Label>切り方</Label>
              <div className="grid grid-cols-2 gap-2">
                {PROFILES.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant={profile === item.id ? "default" : "outline"}
                    onClick={() => setProfile(item.id)}
                    className="w-full"
                    title={item.hint}
                  >
                    {profileLabel(item.id)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {PROFILES.find((item) => item.id === profile)?.hint}
              </p>
            </div>
            <ChannelProfileForm
              profile={channelProfile}
              onChange={setChannelProfile}
            />
            <div className="grid gap-2">
              <Label htmlFor="target">目標の長さ（分）</Label>
              <Input
                id="target"
                type="number"
                min={MIN_TARGET_MINUTES}
                max={sourceKnown ? sourceMinutes : undefined}
                step={1}
                inputMode="numeric"
                value={targetMin}
                onChange={(event) =>
                  setTargetMin(
                    sourceKnown
                      ? clampTargetMinutes(
                          Number(event.target.value),
                          sourceMinutes,
                        )
                      : Math.max(
                          MIN_TARGET_MINUTES,
                          Math.round(Number(event.target.value)) ||
                            MIN_TARGET_MINUTES,
                        ),
                  )
                }
              />
              <p className="text-xs text-muted-foreground">
                {sourceKnown
                  ? `いまの上限は ${sourceMinutes} 分。短くするときだけ下げる。`
                  : "短くするときだけ下げる。"}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="speakerCount">話者の人数</Label>
              <Input
                id="speakerCount"
                type="number"
                min={2}
                max={100}
                inputMode="numeric"
                placeholder="空欄なら自動"
                value={speakerCount}
                onChange={(event) => setSpeakerCount(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                マイクが分かれているときは使わない。
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                disabled={busy || running}
                onClick={() => void start(true)}
                className="flex-1"
              >
                サンプルで編集
              </Button>
              <Button
                variant="outline"
                disabled={busy || running || files.length === 0}
                onClick={() => void start(false)}
                className="flex-1"
              >
                このファイルで編集
              </Button>
            </div>
            {job ? (
              <div className="grid gap-1 text-xs text-muted-foreground">
                <p>
                  残す尺 {formatClock(keepMs)} / 元 {formatClock(job.sourceDurationMs)}
                </p>
                {job.qa ? (
                  <>
                    <p>
                      CUT {job.qa.cutCount} · KEEP {job.qa.keepCount} · REVIEW {job.qa.reviewCount}
                      {` · 人手修正 ${job.qa.humanCorrections}`}
                      {job.qa.meaningRisks.length
                        ? ` · 意味リスク ${job.qa.meaningRisks.length}`
                        : ""}
                    </p>
                    <p>
                      平均ショット {formatClock(job.qa.averageShotLengthMs)}
                      {` · カメラ切替 ${job.qa.cameraSwitchCount}`}
                      {` · jump ${job.qa.jumpCutCount}`}
                    </p>
                  </>
                ) : null}
                {job.cameras?.length > 1 ? (
                  <p>{job.cameras.map((cam) => cam.label).join(" / ")}</p>
                ) : null}
                {job.perception?.topics.length ? (
                  <p>トピック: {job.perception.topics.join(" / ")}</p>
                ) : null}
                {job.chapters?.length ? (
                  <p>
                    PASS {job.pass} · 章{" "}
                    {job.chapters
                      .map((chapter) => `${chapter.title}(${chapter.importance})`)
                      .join(" / ")}
                  </p>
                ) : null}
                <p>再利用 {job.cacheHits ?? 0}</p>
              </div>
            ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {actionError || job?.error ? (
            <Alert variant="destructive">
              <AlertTitle>処理に失敗しました</AlertTitle>
              <AlertDescription>{actionError || job?.error}</AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <div className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>プレビュー</CardTitle>
                <CardDescription>
                  {job
                    ? phaseCopy(job.phase)
                    : "左からはじめる。"}
                </CardDescription>
              </div>
              {job ? (
                <Badge variant={job.phase === "error" ? "destructive" : "secondary"}>
                  {phaseCopy(job.phase)}
                </Badge>
              ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
              {running ? (
                <Progress value={phaseProgress(job?.phase)} className="h-1.5" />
              ) : null}
              {videoUrl ? (
                <video
                  ref={videoRef}
                  key={videoUrl}
                  className="aspect-video w-full rounded-lg bg-foreground"
                  src={videoUrl}
                  controls
                  playsInline
                />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed bg-muted text-sm text-muted-foreground">
                  プレビューする映像がありません。
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={previewMode === "source" ? "default" : "outline"}
                  disabled={!sourceUrl}
                  onClick={() => setPreviewMode("source")}
                >
                  元映像
                </Button>
                <Button
                  size="sm"
                  variant={previewMode === "edited" ? "default" : "outline"}
                  disabled={!editedUrl}
                  onClick={() => setPreviewMode("edited")}
                >
                  編集後
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!job || job.phase !== "ready" || rendering}
                  onClick={() => void renderEdit()}
                >
                  {rendering ? "書き出し中…" : "書き出す"}
                </Button>
                {job?.phase === "ready" ? (
                  <>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=edl`}>EDL</a>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=srt`}>SRT</a>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=otio`}>OTIO</a>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=fcpxml`}>
                        FCPXML
                      </a>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=xml`}>
                        FCP XML
                      </a>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=aaf`}>AAF</a>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=vtt`}>VTT</a>
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`/api/jobs/${job.id}/export?format=project`}>
                        project.json
                      </a>
                    </Button>
                  </>
                ) : null}
              </div>
              {job?.watchQa ? (
                <p
                  className={cn(
                    "text-xs",
                    job.watchQa.ok ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  完成チェック {job.watchQa.ok ? "OK" : "要確認"}
                  {` · ${job.watchQa.iterations} 回`}
                  {job.encoder ? ` · ${job.encoder}` : ""}
                  {job.watchQa.issues.length
                    ? ` · ${job.watchQa.issues.map((issue) => issue.issue).join(" / ")}`
                    : ""}
                </p>
              ) : null}
              {job?.renderQa ? (
                <p
                  className={cn(
                    "text-xs",
                    job.renderQa.ok ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  書き出し検証 {job.renderQa.ok ? "OK" : "要確認"}
                  {` · 尺 ${formatClock(job.renderQa.durationMs)}`}
                  {job.renderQa.hasAudio ? " · 音声あり" : " · 音声なし"}
                  {job.renderQa.notes.length
                    ? ` · ${job.renderQa.notes.join(" / ")}`
                    : ""}
                </p>
              ) : null}
              {job?.notes.length ? (
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {job.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3">
          <Tabs defaultValue="review">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="review">確認待ち</TabsTrigger>
              <TabsTrigger value="inspector">根拠</TabsTrigger>
              <TabsTrigger value="transcript">文字起こし</TabsTrigger>
              <TabsTrigger value="timeline">タイムライン</TabsTrigger>
            </TabsList>
            <TabsContent value="review">
              <ReviewQueue
                clips={job?.clips ?? []}
                ready={job?.phase === "ready"}
                jobId={job?.id}
                sourceDurationMs={job?.sourceDurationMs ?? 0}
                savedReviewMs={
                  job?.metrics?.humanCorrectionTime?.aiReviewMs ?? 0
                }
                onSeek={seek}
                onPause={pauseMedia}
                onSelect={selectClip}
                onVerdict={patchClip}
                onJob={applyHct}
              />
            </TabsContent>
            <TabsContent value="inspector">
              {job?.metrics ? (
                <p className="mb-2 text-xs text-muted-foreground">
                  意味連続 {formatPercent(job.metrics.northStar.meaningContinuity)}
                  {" · "}人間らしさ {formatPercent(job.metrics.northStar.humanTexture)}
                  {" · "}見やすさ {formatPercent(job.metrics.northStar.watchability)}
                </p>
              ) : null}
              <DecisionInspector clip={selectedClip} ready={job?.phase === "ready"} />
            </TabsContent>
            <TabsContent value="transcript">
              <TranscriptPanel job={job} onSeek={seek} />
            </TabsContent>
            <TabsContent value="timeline">
              <TimelinePanel
                job={job}
                selectedId={selectedClipId}
                onSelect={selectClip}
              />
            </TabsContent>
          </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
}

function ProviderBadges({
  status,
  error,
}: {
  status: ProviderStatus | null;
  error: string | null;
}) {
  if (error) {
    return <Badge variant="destructive">接続状態 {error}</Badge>;
  }
  if (!status) {
    return <Badge variant="secondary">接続を確認中</Badge>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">Qwen {status.qwen}</Badge>
      <Badge variant="outline">ASR {status.asr}</Badge>
      <Badge variant="outline">Jev {status.jev}</Badge>
    </div>
  );
}

function TranscriptPanel({
  job,
  onSeek,
}: {
  job: Job | null;
  onSeek: (ms: number) => void;
}) {
  if (!job) {
    return <EmptyPanel text="ジョブを始めると文字が出ます。" />;
  }
  if (job.transcript.length === 0) {
    return <EmptyPanel text="文字起こしを待っています。" />;
  }
  return (
    <div className="h-96 overflow-hidden rounded-xl border bg-card">
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-3">
        {job.transcript.map((cue, index) => (
          <button
            key={`${cue.speaker}-${cue.startMs}-${index}`}
            type="button"
            onClick={() => onSeek(cue.startMs)}
            className="rounded-lg px-3 py-2 text-left hover:bg-muted"
          >
            <p className="text-xs text-muted-foreground">
              {cue.speaker} · {formatRange(cue.startMs, cue.endMs)}
            </p>
            <p className="text-sm">{cue.text}</p>
          </button>
        ))}
      </div>
    </ScrollArea>
    </div>
  );
}

function TimelinePanel({
  job,
  selectedId,
  onSelect,
}: {
  job: Job | null;
  selectedId: string | null;
  onSelect: (clipId: string, startMs: number) => void;
}) {
  if (!job) {
    return <EmptyPanel text="タイムラインは判定後に出ます。" />;
  }
  if (job.clips.length === 0) {
    return <EmptyPanel text="クリップを分けています。" />;
  }
  const total = Math.max(job.sourceDurationMs, 1);
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-3 flex h-10 overflow-hidden rounded-md bg-muted">
        {job.clips.map((clip) => (
          <button
            key={clip.id}
            type="button"
            title={`${clip.reason} ${formatPercent(clip.keepScore)}`}
            onClick={() => onSelect(clip.id, clip.startMs)}
            className={cn(
              "h-full min-w-1 border-r border-background/40",
              clip.verdict !== "keep" && clip.verdict === "cut" && "bg-cam-cut",
              clip.verdict === "review" && "bg-cam-review",
              clip.verdict === "keep" &&
                clip.camera === "B" &&
                "bg-cam-b",
              clip.verdict === "keep" &&
                clip.camera === "WIDE" &&
                "bg-cam-wide",
              clip.verdict === "keep" &&
                (!clip.camera || clip.camera === "A") &&
                "bg-cam-a",
              selectedId === clip.id && "ring-2 ring-foreground ring-inset",
            )}
            // eslint-disable-next-line shadcn/no-inline-styles -- clip width is a computed share of source duration
            style={{ width: `${(durationOf(clip) / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <i className="inline-block size-2 rounded-sm bg-cam-a" /> CAM A
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block size-2 rounded-sm bg-cam-b" /> CAM B
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block size-2 rounded-sm bg-cam-wide" /> WIDE
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block size-2 rounded-sm bg-cam-cut" /> CUT
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block size-2 rounded-sm bg-cam-review" /> REVIEW
        </span>
        {job.timeline?.broll && job.timeline.broll.length > 0 ? (
          <span className="flex items-center gap-1">
            <i className="inline-block size-2 rounded-sm bg-broll" /> B-roll
            {` ${job.timeline.broll.length}`}
          </span>
        ) : null}
      </div>
      <Separator className="my-3" />
      <div className="grid gap-2">
        {job.clips.map((clip) => (
          <button
            key={clip.id}
            type="button"
            onClick={() => onSelect(clip.id, clip.startMs)}
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted",
              selectedId === clip.id && "bg-muted ring-1 ring-border",
            )}
          >
            <span className="min-w-0 truncate">
              {clip.camera ? `CAM ${clip.camera}` : clip.speaker}{" "}
              {clip.punchIn ? "punch-in " : ""}
              {clip.burnIn ? "テロップ " : ""}
              {clip.text || "（間）"}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge
                variant={
                  clip.verdict === "cut"
                    ? "secondary"
                    : clip.verdict === "review"
                      ? "outline"
                      : "default"
                }
              >
                {verdictLabel(clip.verdict)}
              </Badge>
              {roleCopy(clip.role)} · {formatPercent(clip.keepScore)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DecisionInspector({
  clip,
  ready,
}: {
  clip: ScoredClip | null;
  ready: boolean;
}) {
  if (!ready) {
    return <EmptyPanel text="判定が終わるまで待つ。" />;
  }
  if (!clip) {
    return (
      <EmptyPanel text="クリップを選ぶと、残した理由が出ます。" />
    );
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">
              判定 {verdictLabel(clip.verdict)}
            </CardTitle>
            <CardDescription>
              信頼 {formatPercent(clip.signals.confidence)}
              {clip.autoMarker ? " · 自動＋マーカー" : ""}
              {clip.camera ? ` · CAM ${clip.camera}` : ""}
              {typeof clip.captionImportance === "number"
                ? ` · テロップ ${formatPercent(clip.captionImportance)}`
                : ""}
              {clip.burnIn ? " · 焼き込み" : ""}
            </CardDescription>
          </div>
          <Badge variant="outline">残す {formatPercent(clip.keepScore)}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2">
        <p className="text-sm">{clip.text || "（無音・間）"}</p>
        <div className="grid gap-1.5">
          {SIGNAL_KEYS.map((key) => (
            <div key={key} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2">
              <span className="truncate font-mono text-xs text-muted-foreground">{key}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-foreground"
                  // eslint-disable-next-line shadcn/no-inline-styles -- signal bar width is a 0–1 score
                  style={{ width: `${Math.round(clip.signals[key] * 100)}%` }}
                />
              </div>
              <span className="text-right font-mono text-xs">
                {clip.signals[key].toFixed(2)}
              </span>
            </div>
          ))}
        </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed bg-card px-4 py-10 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function staleJobGet(input: {
  cancelled: boolean;
  nextId: string | null;
  requestedId: string;
  currentId: string | null;
  issuedGeneration: number;
  currentGeneration: number;
  issuedSeq: number;
  appliedSeq: number;
}): boolean {
  if (input.cancelled) {
    return true;
  }
  if (input.currentId !== input.requestedId) {
    return true;
  }
  if (input.issuedGeneration !== input.currentGeneration) {
    return true;
  }
  if (input.issuedSeq < input.appliedSeq) {
    return true;
  }
  if (input.nextId != null && input.nextId !== input.requestedId) {
    return true;
  }
  return false;
}

function phaseCopy(phase: JobPhase): string {
  switch (phase) {
    case "queued":
      return "待機";
    case "transcribing":
      return "文字起こし";
    case "understanding":
      return "内容を読む";
    case "deciding":
      return "残す・切るを決める";
    case "building_timeline":
      return "並びを組む";
    case "qa":
      return "最終確認";
    case "rendering_proxy":
      return "下書きを書き出し";
    case "watching":
      return "完成チェック";
    case "final_render":
      return "最終書き出し";
    case "ready":
      return "完了";
    case "error":
      return "失敗";
    default: {
      const _never: never = phase;
      return _never;
    }
  }
}

function phaseProgress(phase: JobPhase | undefined): number {
  switch (phase) {
    case "queued":
      return 8;
    case "transcribing":
      return 28;
    case "understanding":
      return 48;
    case "deciding":
      return 72;
    case "building_timeline":
      return 82;
    case "qa":
      return 88;
    case "rendering_proxy":
      return 90;
    case "watching":
      return 94;
    case "final_render":
      return 97;
    case "ready":
      return 100;
    case "error":
      return 100;
    default:
      return 0;
  }
}

function probeFileDurationMs(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(
      file.type.startsWith("audio/") ? "audio" : "video",
    );
    const finish = (durationMs: number) => {
      URL.revokeObjectURL(url);
      resolve(durationMs);
    };
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      const seconds = media.duration;
      finish(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0);
    };
    media.onerror = () => finish(0);
    media.src = url;
  });
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

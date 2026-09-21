import { getJob } from "@/lib/store";
import {
  buildConcatList,
  buildEdl,
  buildFfmpegCommand,
  buildFilterComplexCommand,
  buildOtio,
  buildProjectJson,
  buildSrt,
  buildVtt,
  exportNleFormat,
} from "@/lib/export";

export function exportDownloadResponse(jobId: string, requestUrl: string): Response {
  const job = getJob(jobId);
  if (!job) {
    return Response.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  }
  if (job.phase !== "ready") {
    return Response.json(
      { error: "書き出しは判定完了後です。" },
      { status: 409 },
    );
  }

  const title = job.perception?.title ?? "CutLine";
  const format = new URL(requestUrl).searchParams.get("format") ?? "json";
  const cameras = (job.cameras ?? []).map((cam) => ({
    id: cam.id,
    fileName: cam.fileName,
    label: cam.label,
  }));
  const nleInput = {
    title,
    fileName: job.fileName,
    clips: job.clips,
    cameras,
    sourceDurationMs: job.sourceDurationMs,
  };
  const srt = buildSrt(job.clips);
  const vtt = buildVtt(job.clips);
  const otio = buildOtio(nleInput);
  const fcpxml = exportNleFormat("fcpxml", nleInput).body;
  const xmeml = exportNleFormat("xmeml", nleInput).body;
  const aaf = exportNleFormat("aaf", nleInput);
  const project = buildProjectJson({
    title,
    fileName: job.fileName,
    clips: job.clips,
    timeline: job.timeline,
    qa: job.qa,
    perception: job.perception,
  });
  const payload = {
    timeline: job.timeline,
    qa: job.qa,
    edl: buildEdl({ title, fileName: job.fileName, clips: job.clips }),
    srt,
    vtt,
    otio,
    fcpxml,
    xmeml,
    aaf: aaf.body,
    project,
    concat: buildConcatList(job.clips, job.fileName),
    ffmpeg: buildFfmpegCommand(job.fileName),
    filterComplex: buildFilterComplexCommand({
      fileName: job.fileName,
      clips: job.clips,
    }),
  };

  switch (format) {
    case "edl":
      return new Response(payload.edl, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="video-final.edl"`,
        },
      });
    case "srt":
      return new Response(payload.srt, {
        headers: {
          "Content-Type": "application/x-subrip; charset=utf-8",
          "Content-Disposition": `attachment; filename="video-final.srt"`,
        },
      });
    case "vtt":
      return new Response(payload.vtt, {
        headers: {
          "Content-Type": "text/vtt; charset=utf-8",
          "Content-Disposition": `attachment; filename="video-final.vtt"`,
        },
      });
    case "otio":
      return new Response(JSON.stringify(payload.otio, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="video-final.otio"`,
        },
      });
    case "fcpxml":
      return new Response(payload.fcpxml, {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Content-Disposition": `attachment; filename="video-final.fcpxml"`,
        },
      });
    case "xml":
    case "xmeml":
      return new Response(payload.xmeml, {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Content-Disposition": `attachment; filename="video-final.xml"`,
        },
      });
    case "aaf":
      return new Response(aaf.body, {
        headers: {
          "Content-Type": aaf.contentType,
          "Content-Disposition": `attachment; filename="${aaf.filename}"`,
        },
      });
    case "project":
      return new Response(JSON.stringify(payload.project, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="project.json"`,
        },
      });
    case "ffmpeg":
      return new Response(
        `# concat.txt\n${payload.concat}\n# command\n${payload.ffmpeg}\n\n# filter_complex\n${payload.filterComplex}\n`,
        {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${jobId}-ffmpeg.txt"`,
          },
        },
      );
    case "json":
      return Response.json(payload);
    default:
      return Response.json(
        { error: `未対応の format です: ${format}` },
        { status: 400 },
      );
  }
}

export async function parseRenderOptions(request: Request): Promise<{
  loudness?: string;
  preset?: string;
}> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return {};
  }
  try {
    const body = JSON.parse(rawBody) as {
      loudness?: string;
      preset?: string;
    };
    return { loudness: body.loudness, preset: body.preset };
  } catch {
    return {};
  }
}

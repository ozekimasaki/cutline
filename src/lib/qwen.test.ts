import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeConversationWindow,
  clearOmniSessions,
  getOmniSession,
  mockOmniPauseLabel,
  mockOmniUnitState,
  normalizeOmniEditState,
  normalizeOmniUnitStates,
  normalizeOmniVisualState,
  omniMediaKey,
  parseOmniPauseLabel,
  parseSemanticRole,
  perceiveUnitStates,
  perceiveVideo,
} from "./qwen";
import { mockPerception, mockTranscript } from "./sample";
import { buildEditUnits } from "./units";
import { sliceConversationWindows } from "./windows";
import type { EditUnit } from "./types";

const originalFetch = globalThis.fetch;
const originalKey = process.env.DASHSCOPE_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) {
    delete process.env.DASHSCOPE_API_KEY;
  } else {
    process.env.DASHSCOPE_API_KEY = originalKey;
  }
  clearOmniSessions();
});

function pauseUnit(partial: Partial<EditUnit> = {}): EditUnit {
  return {
    id: "pause_1",
    speaker: "A",
    text: "",
    startMs: 19_800,
    endMs: 22_800,
    role: "pause",
    pauseClass: "long",
    previous: "会社辞めようと思ったことあります？",
    next: "……あります。",
    ...partial,
  };
}

function listenerCamera(state: {
  visual: {
    speaker: string;
    camera_a: { expression?: string };
    camera_b: { expression?: string };
  };
}) {
  return state.visual.speaker.trim().toUpperCase() === "B"
    ? state.visual.camera_a
    : state.visual.camera_b;
}

describe("Omni unit Edit / Visual State", () => {
  it("mocks §19 / §35 / §37 fields when no API key", async () => {
    delete process.env.DASHSCOPE_API_KEY;
    const units = buildEditUnits(mockTranscript(24_000));
    const perception = mockPerception({
      durationMs: 24_000,
      fileName: "sample.mp4",
      brief: "",
    });
    const { states, notes } = await perceiveUnitStates({
      units,
      perception,
      fileName: "sample.mp4",
    });
    assert.match(notes.join("\n"), /モック/);
    const correction = states.find(
      (state) => state.edit.target.text === "いや去年じゃないですね",
    );
    assert.equal(correction?.edit.semantic.role, "self_correction");
    assert.equal(correction?.edit.visual.speaker_camera, "cam_a");
    assert.equal(correction?.edit.visual.listener_reaction, "none");
    const dramatic = states.find((state) => state.pauseLabel === "dramatic_pause");
    assert.ok(dramatic);
    assert.equal(dramatic.visual.listener_reaction.strength, 0.87);
    assert.equal(dramatic.visual.camera_a.usable, true);
    assert.equal(dramatic.visual.wide.usable, true);
    assert.equal(listenerCamera(dramatic).expression, "surprised");
    const nod = states.find((state) => state.edit.target.text === "へえ");
    assert.equal(nod?.edit.semantic.role, "backchannel");
    assert.equal(nod?.edit.visual.listener_reaction, "nod");
  });

  it("normalizes spec §19 Edit State JSON", () => {
    const unit: EditUnit = {
      id: "eu_148",
      speaker: "B",
      text: "いや、去年じゃないですね",
      startMs: 481_420,
      endMs: 483_730,
      role: "content",
      previous: "去年くらいからですね",
      next: "今年の2月から始めました",
    };
    const edit = normalizeOmniEditState(
      {
        target: {
          id: "eu_148",
          speaker: "B",
          text: "いや、去年じゃないですね",
          start: 481.42,
          end: 483.73,
        },
        semantic: {
          role: "self_correction",
          topic: "開発開始時期",
          contains_new_information: false,
        },
        conversation: {
          previous: "去年くらいからですね",
          next: "今年の2月から始めました",
        },
        visual: {
          speaker_camera: "cam_b",
          listener_reaction: "none",
        },
      },
      unit,
    );
    assert.equal(edit.semantic.role, "self_correction");
    assert.equal(edit.visual.speaker_camera, "cam_b");
    assert.equal(edit.visual.listener_reaction, "none");
    assert.equal(edit.semantic.contains_new_information, false);
  });

  it("normalizes spec §37 Visual State JSON", () => {
    const visual = normalizeOmniVisualState(
      {
        speaker: "A",
        camera_a: { subject: "A", usable: true, expression: "neutral" },
        camera_b: { subject: "B", usable: true, expression: "surprised" },
        wide: { usable: true },
        listener_reaction: { strength: 0.87 },
      },
      pauseUnit({ speaker: "A" }),
    );
    assert.equal(visual.camera_a.usable, true);
    assert.equal(visual.camera_a.expression, "neutral");
    assert.equal(visual.camera_b.expression, "surprised");
    assert.equal(visual.wide.usable, true);
    assert.equal(visual.listener_reaction.strength, 0.87);
  });

  it("labels Omni pause types from surrounding speech", () => {
    assert.equal(mockOmniPauseLabel(pauseUnit()), "dramatic_pause");
    assert.equal(
      mockOmniPauseLabel(
        pauseUnit({
          previous: "知覚は Qwen、判断は Jev に分けています",
          next: "実装の話です",
          pauseClass: "long",
        }),
      ),
      "technical_pause",
    );
    assert.equal(
      mockOmniPauseLabel(
        pauseUnit({
          previous: "それで",
          next: "続けます",
          startMs: 0,
          endMs: 900,
          pauseClass: "thinking",
        }),
      ),
      "thinking_pause",
    );
    assert.equal(
      mockOmniPauseLabel(
        pauseUnit({
          previous: "えーと",
          next: "はい",
          startMs: 0,
          endMs: 2500,
          pauseClass: "long",
        }),
      ),
      "awkward_pause",
    );
    assert.equal(
      mockOmniPauseLabel({
        id: "eu_1",
        speaker: "A",
        text: "今年の2月から始めました",
        startMs: 0,
        endMs: 2000,
        role: "content",
      }),
      undefined,
    );
  });

  it("parses pause labels and semantic roles", () => {
    assert.equal(parseOmniPauseLabel("dramatic_pause"), "dramatic_pause");
    assert.equal(parseOmniPauseLabel("thinking_pause"), "thinking_pause");
    assert.equal(parseOmniPauseLabel("awkward_pause"), "awkward_pause");
    assert.equal(parseOmniPauseLabel("technical_pause"), "technical_pause");
    assert.equal(parseOmniPauseLabel("long"), undefined);
    assert.equal(parseSemanticRole("self_correction", "content"), "self_correction");
    assert.equal(parseSemanticRole("CUT", "pause"), "pause");
  });

  it("keeps Visual State strength when Edit State listener_reaction is a string", () => {
    const units = [
      pauseUnit({ id: "pause_1" }),
      {
        id: "eu_2",
        speaker: "A",
        text: "……あります。",
        startMs: 22_800,
        endMs: 24_000,
        role: "content" as const,
      },
    ];
    const states = normalizeOmniUnitStates(
      {
        units: [
          {
            id: "pause_1",
            pause_label: "dramatic_pause",
            camera_a: { usable: true, expression: "neutral" },
            camera_b: { usable: true, expression: "surprised" },
            wide: { usable: true },
            listener_reaction: { strength: 0.9 },
            semantic: { role: "pause" },
            visual: { speaker_camera: "cam_a", listener_reaction: "none" },
          },
        ],
      },
      units,
    );
    assert.equal(states[0]?.pauseLabel, "dramatic_pause");
    assert.equal(states[0]?.visual.listener_reaction.strength, 0.9);
    assert.equal(states[0]?.edit.visual.listener_reaction, "none");
    assert.equal(states[1]?.edit.semantic.role, "content");
    assert.equal(states[1]?.edit.visual.speaker_camera, "cam_a");
  });
});

describe("Omni Responses session cache", () => {
  it("reuses previous_response_id for PASS 2 windows and unit state", async () => {
    process.env.DASHSCOPE_API_KEY = "test-key";
    const dir = mkdtempSync(path.join(os.tmpdir(), "cutline-omni-"));
    const filePath = path.join(dir, "clip.bin");
    writeFileSync(filePath, Buffer.from("video-bytes"));
    const cues = mockTranscript(24_000);
    const window = sliceConversationWindows({ durationMs: 24_000, cues })[0];
    assert.ok(window);

    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      cache: string;
    }> = [];
    let turn = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        body,
        cache: headers.get("x-dashscope-session-cache") ?? "",
      });
      turn += 1;
      const payloads = [
        {
          id: "resp_global",
          output_text: JSON.stringify({
            title: "対談",
            durationMs: 24_000,
            language: "ja",
            summary: "全体把握",
            storyline: "story",
            topics: ["開始時期"],
            keyMoments: [],
            participants: [{ id: "A", role: "host" }],
          }),
          usage: { input_tokens_details: { cached_tokens: 0 } },
        },
        {
          id: "resp_window",
          output_text: JSON.stringify({
            summary: "TARGET の会話",
            speakers: ["A"],
            turns: [
              {
                speaker: "A",
                text: "今年の2月から始めました",
                startMs: 0,
                endMs: 2000,
              },
            ],
          }),
          usage: { input_tokens_details: { cached_tokens: 1024 } },
        },
        {
          id: "resp_units",
          output_text: JSON.stringify({
            units: [
              {
                id: "eu_1",
                semantic: { role: "content", contains_new_information: true },
                visual: { speaker_camera: "cam_a", listener_reaction: "none" },
                camera_a: { usable: true, expression: "neutral" },
                camera_b: { usable: true, expression: "neutral" },
                wide: { usable: true },
                listener_reaction: { strength: 0.2 },
              },
            ],
          }),
          usage: { input_tokens_details: { cached_tokens: 2048 } },
        },
      ];
      return new Response(JSON.stringify(payloads[turn - 1] ?? payloads.at(-1)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const perceived = await perceiveVideo({
      filePath,
      fileName: "clip.bin",
      durationMs: 24_000,
      brief: "残す",
    });
    assert.equal(perceived.perception.source, "live");
    assert.equal(perceived.perception.omniResponseId, "resp_global");
    assert.equal(
      getOmniSession(omniMediaKey({ filePath }))?.previousResponseId,
      "resp_global",
    );

    const windowed = await analyzeConversationWindow({
      filePath,
      fileName: "clip.bin",
      durationMs: 24_000,
      brief: "残す",
      window,
      cues,
      storyline: perceived.perception.storyline,
      perception: perceived.perception,
    });
    assert.equal(windowed.analysis.source, "live");
    assert.match(windowed.notes.join("\n"), /session で video \+ global state を再利用/);

    const unit: EditUnit = {
      id: "eu_1",
      speaker: "A",
      text: "今年の2月から始めました",
      startMs: 0,
      endMs: 1000,
      role: "content",
    };
    const { states, notes } = await perceiveUnitStates({
      units: [unit],
      perception: perceived.perception,
      filePath,
      fileName: "clip.bin",
    });

    assert.equal(calls.length, 3);
    assert.equal(calls.every((call) => call.cache === "enable"), true);
    assert.match(calls[0]?.url ?? "", /\/responses$/);
    const firstInput = JSON.stringify(calls[0]?.body.input ?? []);
    const windowInput = JSON.stringify(calls[1]?.body.input ?? []);
    const unitInput = JSON.stringify(calls[2]?.body.input ?? []);
    assert.match(firstInput, /input_video/);
    assert.doesNotMatch(windowInput, /input_video/);
    assert.doesNotMatch(unitInput, /input_video/);
    assert.equal(calls[1]?.body.previous_response_id, "resp_global");
    assert.equal(calls[2]?.body.previous_response_id, "resp_window");
    assert.match(notes.join("\n"), /session で video \+ global state を再利用/);
    assert.match(unitInput, /Do not decide KEEP, CUT/);
    assert.equal(states[0]?.edit.semantic.role, "content");
    assert.equal(states[0]?.visual.camera_a.usable, true);
  });
});

describe("window fallback source", () => {
  it("marks a partial window mock when a field falls back", async () => {
    process.env.DASHSCOPE_API_KEY = "test-key";
    const dir = mkdtempSync(path.join(os.tmpdir(), "cutline-window-"));
    const filePath = path.join(dir, "clip.bin");
    writeFileSync(filePath, Buffer.from("video-bytes"));
    const cues = mockTranscript(24_000);
    const window = sliceConversationWindows({ durationMs: 24_000, cues })[0];
    assert.ok(window);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "resp_partial",
          output_text: JSON.stringify({ summary: "途中まで" }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const windowed = await analyzeConversationWindow({
      filePath,
      fileName: "clip.bin",
      durationMs: 24_000,
      brief: "残す",
      window,
      cues,
    });
    assert.equal(windowed.analysis.source, "mock");
    assert.equal(windowed.analysis.summary, "途中まで");
  });
});

describe("mockOmniUnitState", () => {
  it("does not pick a camera cut or CUT verdict", () => {
    const state = mockOmniUnitState({
      id: "eu_1",
      speaker: "B",
      text: "いや去年じゃないですね",
      startMs: 1500,
      endMs: 3400,
      role: "self_correction",
    });
    assert.equal(state.edit.visual.speaker_camera, "cam_b");
    assert.equal(state.visual.speaker, "B");
    assert.ok(!("verdict" in state.edit));
    assert.ok(!("camera" in state.visual));
  });
});

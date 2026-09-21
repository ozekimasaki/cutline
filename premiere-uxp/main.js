/* global require, document, module */
let storage = { formats: { utf8: "utf8" }, localFileSystem: null };
try {
  storage = require("uxp").storage;
} catch {
  // Premiere 以外では Review の数え方だけ使える
}
const fs = storage.localFileSystem;

let project = null;
let fcpxmlFile = null;

function setStatus(text) {
  const node = document.getElementById("status");
  if (node) {
    node.textContent = text;
  }
}

function premiereModule() {
  try {
    return require("premierepro");
  } catch {
    return null;
  }
}

function projectClips(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!Array.isArray(value.clips)) {
    return null;
  }
  return value.clips;
}

function countReviews(value) {
  const clips = projectClips(value);
  if (!clips) {
    return 0;
  }
  return clips.filter((clip) => clip && clip.verdict === "review").length;
}

function renderReview() {
  const list = document.getElementById("review-list");
  if (!list) {
    return;
  }
  list.replaceChildren();
  const clips = projectClips(project) ?? [];
  const reviews = clips.filter((clip) => clip.verdict === "review");
  if (reviews.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = project
      ? "確認待ちはありません。迷ったら残す判定です。"
      : "まだ編集データを読んでいません。";
    list.appendChild(empty);
    return;
  }
  for (const clip of reviews) {
    const item = document.createElement("li");
    const title = document.createElement("div");
    title.textContent = `${clip.speaker ?? "?"} · CAM ${clip.camera ?? "A"}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${clip.reason ?? ""} / keepScore ${clip.keepScore ?? ""}`;
    const body = document.createElement("div");
    body.textContent = clip.text || "（無音・間）";
    item.append(title, meta, body);
    list.appendChild(item);
  }
}

async function readJson(file) {
  const raw = await file.read({ format: storage.formats.utf8 });
  return JSON.parse(raw);
}

async function importCutlineEdit() {
  const file = await fs.getFileForOpening({
    types: ["json", "otio", "fcpxml", "xml"],
    allowMultiple: false,
  });
  if (!file) {
    return;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".otio")) {
    setStatus(
      `${file.name} は OTIO です。Review は clips を持つ project.json だけを数えます。`,
    );
  } else if (name.endsWith(".json")) {
    const parsed = await readJson(file);
    if (!projectClips(parsed)) {
      project = null;
      setStatus(`${file.name} に clips が無いため Review には使いません。`);
    } else {
      project = parsed;
      setStatus(`${file.name} を読みました。Apply AI Edit でシーケンスに載せます。`);
    }
  } else {
    fcpxmlFile = file;
    setStatus(`${file.name} を保持しました。Apply AI Edit で Premiere に取り込みます。`);
  }
  renderReview();
}

async function importXmlIntoPremiere(file) {
  const ppro = premiereModule();
  if (!ppro) {
    setStatus(
      "Premiere UXP API がありません。FCPXML を File > Import するか、Resolve は OTIO / FCP XML を使ってください。",
    );
    return false;
  }
  const projectObj = await ppro.Project.getActiveProject();
  if (!projectObj) {
    setStatus("アクティブな Premiere プロジェクトがありません。");
    return false;
  }
  const path = file.nativePath ?? file.path;
  if (typeof projectObj.importFiles === "function") {
    await projectObj.importFiles([path]);
    return true;
  }
  if (typeof projectObj.importFCPXML === "function") {
    await projectObj.importFCPXML(path);
    return true;
  }
  setStatus("この Premiere では XML import API が使えません。FCPXML を手動で Import してください。");
  return false;
}

async function applyAiEdit() {
  if (fcpxmlFile) {
    const imported = await importXmlIntoPremiere(fcpxmlFile);
    if (imported) {
      setStatus("FCPXML をシーケンスへ取り込みました。");
    }
    return;
  }
  if (!project) {
    setStatus("先に Import CUTLINE Edit で project.json か FCPXML を選んでください。");
    return;
  }
  const ppro = premiereModule();
  if (!ppro) {
    setStatus(
      "モック動作: KEEP クリップは project.json に入っています。video-final.fcpxml を Premiere / Resolve に Import してください。",
    );
    renderReview();
    return;
  }
  const sequence = await ppro.Sequence.getActiveSequence?.();
  const kept = (projectClips(project) ?? []).filter((clip) => clip.verdict === "keep");
  setStatus(
    sequence
      ? `Apply AI Edit: KEEP ${kept.length} クリップをアクティブシーケンスの参照にしました。`
      : `KEEP ${kept.length}。FCPXML を読み込むとシーケンスを作れます。`,
  );
}

async function reviewAiDecisions() {
  if (!project) {
    setStatus("Review するには project.json を Import してください。");
    return;
  }
  renderReview();
  const count = countReviews(project);
  setStatus(
    count === 0
      ? "確認待ちはありません。"
      : `確認待ち ${count} 件。パネルの Review Queue を人手で残す／切ってください。`,
  );
}

function exportMode(ppro) {
  const modes = ppro.Constants?.ExportMode ?? ppro.EncoderManager?.ExportMode ?? {};
  return {
    immediately: modes.IMMEDIATELY ?? "IMMEDIATELY",
    queue: modes.QUEUE_TO_AME ?? "QUEUE_TO_AME",
  };
}

async function exportFinal() {
  const ppro = premiereModule();
  if (!ppro?.EncoderManager) {
    setStatus(
      "EncoderManager がありません。Premiere 26.3 以降で Export Final が Media Encoder まで通ります。それまでは FFmpeg の edited.mp4 を使ってください。",
    );
    return;
  }
  const folder = await fs.getFolder();
  if (!folder) {
    return;
  }
  const output = await folder.createFile("cutline-final.mp4", { overwrite: true });
  const manager = await ppro.EncoderManager.getManager();
  const sequence =
    (await ppro.Sequence.getActiveSequence?.()) ??
    (await ppro.Project.getActiveProject()?.then((item) => item?.getActiveSequence?.()));
  if (!sequence) {
    setStatus("書き出すシーケンスがありません。先に Apply AI Edit してください。");
    return;
  }
  const mode = exportMode(ppro).immediately;
  if (typeof manager.exportSequence === "function") {
    await manager.exportSequence(sequence, output.nativePath, "", mode);
    setStatus("Export Final: EncoderManager.exportSequence(IMMEDIATELY) を開始しました。");
    return;
  }
  setStatus("exportSequence() がこのビルドにありません。");
}

function bindUi() {
  if (typeof document === "undefined" || !document.getElementById) {
    return;
  }
  document.getElementById("import-edit")?.addEventListener("click", () => {
    void importCutlineEdit().catch((error) => setStatus(String(error)));
  });
  document.getElementById("apply-edit")?.addEventListener("click", () => {
    void applyAiEdit().catch((error) => setStatus(String(error)));
  });
  document.getElementById("review-decisions")?.addEventListener("click", () => {
    void reviewAiDecisions().catch((error) => setStatus(String(error)));
  });
  document.getElementById("export-final")?.addEventListener("click", () => {
    void exportFinal().catch((error) => setStatus(String(error)));
  });
  renderReview();
}

bindUi();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { projectClips, countReviews };
}

# CutLine

会話中心の動画を、生成ではなく**編集**するエンジンです。Qwen3.8-Omni-Flash が内容を理解し、Jev が typed な確率信号を出し、コードが `keepScore` と制約で KEEP / CUT / REVIEW を決め、FFmpeg が `edited.mp4` を書き出します。Jev に「切るか」も「どのカメラか」も聞きません。

動くスライスは企画書の **PoC 1〜5** です。KEEP/CUT、意味の連続、CAM A / CAM B / WIDE、Editor UI、そして Premiere / Resolve 向けの OTIO・FCPXML。カメラは speaker / reaction / wide / fatigue / jump cut をコードで決めます。B-roll は企画書 §46 どおり Omni の `B_ROLL_RECOMMENDED` を Timeline IR へ載せるだけで、ストックは自動生成しません。

## 動かし方

Editor は **TanStack Start**（Vite）です。開発サーバーは [http://127.0.0.1:43127](http://127.0.0.1:43127)。認証はありません。

```bash
npm install
cp .env.example .env.local   # キーが無くてもモックで動きます
npm run dev
```

ブラウザで Editor を開き、「サンプルで編集」を押してください。24 秒はアプリ内サンプル素材です。目標尺の初期値と上限は素材の長さで、短くしたいときだけ下げます（例: 60分のうち30分）。サンプル対談が走ると文字起こし・信号・タイムライン・確認待ちが出ます。ジョブ開始時に ffprobe でメタデータを取り、CAM/MIC を embedded timecode → audio timecode → 波形クロス相関 → 手動オフセットの順で同期し、Omni / ASR には 720p（または 1080p）H.264 プロキシを渡します。すでに 720p H.264 のサンプルは再エンコードしません。話者は企画書 §8 どおり、個別 Mic があれば Mic 1→A / Mic 2→B / 以降 C, D… とトラックを信頼し、AI 話者推定は使いません。mix が 1 本で mono のときだけ `diarization_enabled`（任意で `speaker_count` ヒント）を付けます。Qwen Audio の diarization は mono 専用なので multi-channel とは同時に使いません。Jev に話者もカメラも聞きません。判定後に「FFmpeg で書き出す」で `edited.mp4` を作れます。書き出し後に尺・音声の有無・黒味・固まり・無音を検証し、**完成映像を Qwen Omni が再視聴**します（企画書 §67–70。最大3回まで直して再レンダー）。NVENC / VideoToolbox / QSV が使えればそれを選び、無ければ libx264 です。同じ画面から `video-final.srt` / `video-final.vtt` / `video-final.otio` / `video-final.fcpxml` / `video-final.xml` / `video-final.aaf.xml` / `project.json` も落とせます。パイプラインは企画書の PASS 0（全体把握）→ PASS 1（トピック）→ PASS 2（会話窓 + 単位 Edit/Visual State + Jev）→ 編集済み台詞の二段階再構築（§30）→ PASS 3（連続性）で、ASR / Omni / Jev の結果は `mediaHash + timeRange + model + promptVersion` で SQLite にキャッシュします。キーが無いときはモックです。captionImportance が高い KEEP には burn-in テロップを載せます。KEEP / CUT の意味は Qwen と Jev の時刻のまま残し、FFmpeg の切点だけ波形から決めます（企画書 §32）。`src/lib/boundary.ts` が VAD → 無音境界 → ゼロクロスの順で実際のトリムを出し、そのあと 80ms / 100ms のハンドルが付きます。サンプルの lavfi 正弦波など発話が無い素材は、決定的なモック波形に落ちます。

```bash
npm test
npm run lint
```

`npm run lint` は ESLint + [@shadcn/lint](https://github.com/shadcn-ui/lint) です。違反はエラーで落ちます。

判定後に `computeJobMetrics()` が Timeline IR と Final/Watch/Continuity QA から意味連続・人間らしさ・視聴可能性を測ります（企画書 §93–97。自動編集率は目標にしません）。Inspector に出ます。

Review で AI の KEEP/CUT を変えると、発話テキスト・話者・役割を SQLite に残します。次のジョブでは `applyPreference()` が engine/TS の keepScore のあとで判定を偏らせます（企画書 §78。keepScore の式は変えません）。チャンネルプロファイルは JSON で、既定は 笑い=残す / 沈黙=短くする / 相槌=少し残す / 技術説明=ほぼ削らない / 脱線=積極削除 です（§79）。

## エンジン（Rust + Python）

判定（`keepScore` / verdict / カメラ）は Rust CLI、FFmpeg 書き出しは Python worker です。バイナリや Python / ffmpeg が無いときは既存の TypeScript に落ちます。Jev に CUT もカメラも聞きません。

```bash
cargo build --release --manifest-path engine-rs/Cargo.toml
# または npm run engine:build
```

stdin に JSON を渡します。

```bash
echo '{"profile":"standard","units":[{"id":"u1","signals":{...}}]}' \
  | ./engine-rs/target/release/cutline-engine decide

echo '{"clips":[{"id":"c1","speaker":"A","role":"content","startMs":0,"endMs":2000,"verdict":"keep","signals":{"reactionValue":0.1}}]}' \
  | ./engine-rs/target/release/cutline-engine cameras

python3 engine/worker.py
# stdin: {"command":"render"|"validate"|"loudness"|"graph", ...}
```

Loudness は YouTube −14 LUFS、Podcast −16 LUFS。書き出しプリセットは企画書 §64 どおり YouTube 1080p / YouTube 4K / Podcast Video / Shorts / Archive ProRes です。会話カットには短い `acrossfade` を入れ、カメラ切替と punch-in だけ `xfade` します（KEEP の間は映像を溶かしません）。判定は `src/lib/engine.ts`、書き出しは `src/lib/render-job.ts` から呼べます（HTTP ルート非依存）。

## Premiere UXP（PoC 5）

`premiere-uxp/` が CUTLINE パネルです。ボタンは企画書どおり次の4つです。

- Import CUTLINE Edit — `project.json` / `.otio` / `.fcpxml` を読む
- Apply AI Edit — FCPXML をアクティブプロジェクトへ取り込む
- Review AI Decisions — `verdict === review` のクリップだけを出す
- Export Final — Premiere 26.3 の `EncoderManager.exportSequence()`（`IMMEDIATELY` / `QUEUE_TO_AME`）

読み込み手順:

1. [UXP Developer Tools](https://developer.adobe.com/photoshop/uxp/) を開く
2. Add Plugin → `premiere-uxp/manifest.json`
3. Premiere Pro 26.2 以降で Load / Reload
4. Window から CUTLINE パネルを出す
5. Editor で落とした `project.json` と `video-final.fcpxml` を Import する

Premiere が無い環境では、同じ FCPXML を File > Import してもシーケンスになります。

## DaVinci Resolve

Timeline IR → OTIO が基本ルートです。必要なら FCP 7 XML と AAF-XML（`video-final.aaf.xml`）も出します。

1. Editor から `video-final.otio` / `video-final.xml` / `video-final.aaf.xml` を保存する
2. Resolve で File > Import > Timeline
3. CAM A / B / WIDE のメディアが同じフォルダにあればリンクされます。punch-in は Scale 115 です

NLE なしでも FFmpeg の `edited.mp4` まで完結します。

## デスクトップ（Deno Desktop）

唯一のデスクトップ経路は [Deno Desktop](https://docs.deno.com/runtime/desktop/)（**2.9 以降**）です。ウィンドウは Editor（Web アプリ）の [http://127.0.0.1:43127](http://127.0.0.1:43127) を開きます。43127 は奪いません。

Deno 2.9+ が無ければ:

```bash
curl -fsSL https://deno.land/install.sh | sh
```

先に Editor を 43127 で起動してから:

```bash
npm run dev
deno task desktop
```

`deno task desktop` は `--hmr` 付きの開発用です。本番バイナリは HMR 無しで:

```bash
deno task desktop:build
```

出力は `dist-desktop/`（macOS: `CUTLINE.app`、Windows: `CUTLINE`、Linux: `cutline.AppImage`）。エントリは `src-deno/main.ts` を明示します。ルートで `deno desktop .` するとフレームワーク検出が走り、43127 の Editor とは別プロセスになるので使いません。

ウィンドウは CUTLINE、1280×800。認証は付けません。

## リリース

`v*.*.*` タグを push すると、macOS / Windows / Linux のデスクトップインストーラ（`deno task desktop:build`）が GitHub Release に載ります。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## モデル接続

| 役割 | 経路 | 環境変数 |
| --- | --- | --- |
| 知覚（Omni） | Alibaba Cloud Model Studio / DashScope compatible-mode | `DASHSCOPE_API_KEY` |
| ASR | `QWEN_ASR_MODEL`（既定 `qwen-audio-asr-flash-filetrans`） | 同上 |
| 信号（Jev） | Vercel AI Gateway `typesafe-ai/jev` または Cloudflare Workers AI `typesafe/jev` | `AI_GATEWAY_API_KEY` / `CLOUDFLARE_API_TOKEN` |

未設定時はモックに落ちます。Cloudflare アカウント既定は `6f2f1ee8a618e7fcb9f6737c3a84c526` です。`JEV_PROVIDER=cloudflare` で Cloudflare を優先できます。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::io::{self, Read};

const HYSTERESIS: f64 = 0.15;
const FATIGUE_MS: f64 = 4000.0;
const MIN_NORMAL_MS: i64 = 1500;
const MIN_REACTION_MS: i64 = 800;
const MIN_WIDE_MS: i64 = 2000;
const JUMP_MS: i64 = 250;
const DEFAULT_VISUAL_QUALITY: f64 = 0.72;
const UNUSABLE_PENALTY: f64 = 1.0;

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "decide".into());
    let mut raw = String::new();
    if let Err(err) = io::stdin().read_to_string(&mut raw) {
        eprintln!("{err}");
        std::process::exit(1);
    }
    let input: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    let out = match cmd.as_str() {
        "cameras" => cameras(input),
        "decide" => decide(input),
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(1);
        }
    };
    match out {
        Ok(value) => println!("{}", serde_json::to_string(&value).expect("encode")),
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

#[derive(Deserialize)]
struct DecideIn {
    #[serde(default = "default_profile")]
    profile: String,
    #[serde(default)]
    units: Vec<UnitIn>,
}

fn default_profile() -> String {
    "standard".into()
}

#[derive(Deserialize)]
struct UnitIn {
    id: String,
    signals: Signals,
}

#[derive(Clone, Deserialize)]
struct Signals {
    #[serde(default)]
    importance: f64,
    #[serde(default)]
    novelty: f64,
    #[serde(default)]
    redundancy: f64,
    #[serde(rename = "contextRequired", default)]
    context_required: f64,
    #[serde(default)]
    filler: f64,
    #[serde(rename = "falseStart", default)]
    false_start: f64,
    #[serde(default)]
    tangent: f64,
    #[serde(rename = "humanTexture", default)]
    human_texture: f64,
    #[serde(rename = "reviewRequired", default)]
    review_required: f64,
    #[serde(default)]
    confidence: f64,
}

#[derive(Serialize)]
struct DecideOut {
    decisions: Vec<Decision>,
}

#[derive(Serialize)]
struct Decision {
    id: String,
    #[serde(rename = "keepScore")]
    keep_score: f64,
    verdict: String,
    #[serde(rename = "autoMarker")]
    auto_marker: bool,
}

fn decide(value: Value) -> Result<Value, String> {
    let input: DecideIn = serde_json::from_value(value).map_err(|err| err.to_string())?;
    let decisions = input
        .units
        .iter()
        .map(|unit| {
            let keep_score = keep_score(&unit.signals, &input.profile);
            let (verdict, auto_marker) = verdict(&unit.signals, keep_score);
            Decision {
                id: unit.id.clone(),
                keep_score,
                verdict,
                auto_marker,
            }
        })
        .collect();
    serde_json::to_value(DecideOut { decisions }).map_err(|err| err.to_string())
}

fn keep_score(s: &Signals, profile: &str) -> f64 {
    let answer = clamp01(1.0 - s.filler.max(s.false_start).max(s.tangent));
    let mut score = s.importance * 0.3
        + s.novelty * 0.15
        + s.context_required * 0.25
        + s.human_texture * 0.15
        + answer * 0.15
        - s.redundancy * 0.25
        - s.filler * 0.15
        - s.false_start * 0.15
        - s.tangent * 0.2;
    match profile {
        "natural" => {
            score += s.human_texture * 0.12;
            score += s.filler * 0.06;
        }
        "tight" => {
            score -= s.filler * 0.12;
            score -= s.redundancy * 0.08;
        }
        "short" => {
            score -= (1.0 - s.importance) * 0.12;
            score -= s.filler * 0.1;
        }
        _ => {}
    }
    clamp01((score + 0.6) / 1.6)
}

fn verdict(s: &Signals, keep_score: f64) -> (String, bool) {
    if s.review_required >= 0.5 {
        return ("review".into(), false);
    }
    if s.confidence < 0.6 {
        return ("keep".into(), false);
    }
    if s.confidence < 0.8 {
        return ("review".into(), false);
    }
    let auto_marker = s.confidence < 0.95;
    if keep_score >= 0.45 {
        ("keep".into(), auto_marker)
    } else {
        ("cut".into(), auto_marker)
    }
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

#[derive(Deserialize)]
struct CameraIn {
    #[serde(default)]
    clips: Vec<ClipIn>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ClipIn {
    id: String,
    #[serde(default)]
    speaker: String,
    #[serde(default)]
    role: String,
    #[serde(rename = "startMs", default)]
    start_ms: i64,
    #[serde(rename = "endMs", default)]
    end_ms: i64,
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    signals: CameraSignalsIn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    omni: Option<OmniIn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    camera: Option<String>,
    #[serde(rename = "punchIn", skip_serializing_if = "Option::is_none")]
    punch_in: Option<bool>,
    #[serde(rename = "morph", skip_serializing_if = "Option::is_none")]
    morph: Option<bool>,
    #[serde(rename = "cameraReason", skip_serializing_if = "Option::is_none")]
    camera_reason: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct CameraSignalsIn {
    #[serde(rename = "reactionValue", default)]
    reaction_value: f64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct OmniIn {
    #[serde(default)]
    visual: Option<OmniVisualIn>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct OmniVisualIn {
    #[serde(default)]
    camera_a: Option<OmniCameraIn>,
    #[serde(default)]
    camera_b: Option<OmniCameraIn>,
    #[serde(default)]
    wide: Option<OmniCameraIn>,
    #[serde(default)]
    listener_reaction: Option<ListenerReactionIn>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct OmniCameraIn {
    #[serde(default)]
    usable: Option<bool>,
    #[serde(default)]
    expression: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct ListenerReactionIn {
    #[serde(default)]
    strength: Option<f64>,
}

fn cameras(value: Value) -> Result<Value, String> {
    let mut input: CameraIn = serde_json::from_value(value).map_err(|err| err.to_string())?;
    let mut ordered: Vec<usize> = (0..input.clips.len()).collect();
    ordered.sort_by_key(|i| input.clips[*i].start_ms);
    let mut previous_keep: Option<usize> = None;
    let mut current: Option<String> = None;
    let mut same_ms: i64 = 0;
    for idx in ordered {
        if input.clips[idx].verdict != "keep" {
            continue;
        }
        let jump = previous_keep
            .map(|p| input.clips[idx].start_ms - input.clips[p].end_ms >= JUMP_MS)
            .unwrap_or(false);
        let choice = pick_camera(&input.clips[idx], current.as_deref(), same_ms, jump);
        let dur = duration_of(&input.clips[idx]);
        same_ms = if current.as_deref() == Some(choice.0) {
            same_ms + dur
        } else {
            dur
        };
        current = Some(choice.0.to_string());
        input.clips[idx].camera = Some(choice.0.to_string());
        input.clips[idx].punch_in = Some(choice.1);
        input.clips[idx].morph = Some(choice.2);
        input.clips[idx].camera_reason = Some(choice.3);
        previous_keep = Some(idx);
    }
    serde_json::to_value(serde_json::json!({ "clips": input.clips })).map_err(|err| err.to_string())
}

fn duration_of(clip: &ClipIn) -> i64 {
    (clip.end_ms - clip.start_ms).max(0)
}

fn speaker_cam(speaker: &str) -> &'static str {
    if speaker.trim().eq_ignore_ascii_case("B") {
        "B"
    } else {
        "A"
    }
}

fn clip_visual(clip: &ClipIn) -> Option<&OmniVisualIn> {
    clip.omni.as_ref().and_then(|omni| omni.visual.as_ref())
}

fn camera_visual<'a>(visual: Option<&'a OmniVisualIn>, camera: &str) -> Option<&'a OmniCameraIn> {
    visual.and_then(|state| match camera {
        "A" => state.camera_a.as_ref(),
        "B" => state.camera_b.as_ref(),
        "WIDE" => state.wide.as_ref(),
        _ => None,
    })
}

fn is_camera_usable(visual: Option<&OmniVisualIn>, camera: Option<&str>) -> bool {
    let Some(camera) = camera else {
        return true;
    };
    camera_visual(visual, camera)
        .and_then(|shot| shot.usable)
        .unwrap_or(true)
}

fn visual_quality(visual: Option<&OmniVisualIn>, camera: &str) -> f64 {
    match camera_visual(visual, camera) {
        Some(shot) => {
            if shot.usable.unwrap_or(true) {
                0.82
            } else {
                0.12
            }
        }
        None => DEFAULT_VISUAL_QUALITY,
    }
}

fn usable_boost(visual: Option<&OmniVisualIn>, camera: &str) -> f64 {
    if is_camera_usable(visual, Some(camera)) {
        visual_quality(visual, camera) - DEFAULT_VISUAL_QUALITY
    } else {
        -UNUSABLE_PENALTY
    }
}

fn is_reactive_expression(expression: Option<&str>) -> bool {
    let Some(expression) = expression else {
        return false;
    };
    let lower = expression.to_ascii_lowercase();
    [
        "surpris", "smile", "laugh", "nod", "react", "shock", "amuse", "frown", "think", "listen",
        "cry", "wow", "delight",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn reactive_expression_boost(visual: Option<&OmniVisualIn>, speaker_camera: &str) -> f64 {
    let listener = if speaker_camera == "A" { "B" } else { "A" };
    let expression = camera_visual(visual, listener).and_then(|shot| shot.expression.as_deref());
    if is_reactive_expression(expression) {
        0.12
    } else {
        0.0
    }
}

fn pick_camera(
    clip: &ClipIn,
    previous: Option<&str>,
    same_ms: i64,
    jump: bool,
) -> (&'static str, bool, bool, String) {
    let visual = clip_visual(clip);
    let speaker = speaker_cam(&clip.speaker);
    let reaction_strength = visual
        .and_then(|state| state.listener_reaction.as_ref())
        .and_then(|reaction| reaction.strength)
        .unwrap_or(clip.signals.reaction_value);
    let expression_boost = reactive_expression_boost(visual, speaker);
    let reaction = if clip.role == "backchannel" || reaction_strength >= 0.5 {
        (reaction_strength + expression_boost).max(0.7)
    } else {
        0.16
    };
    let wide_reset = if jump || clip.role == "pause" || same_ms as f64 >= FATIGUE_MS {
        0.82
    } else {
        0.22
    };
    let speaker_value = if clip.role == "content" { 0.84 } else { 0.62 };
    let shot_fatigue = ((same_ms as f64) / FATIGUE_MS).min(1.0);
    let continuity = if previous.is_some() { 0.36 } else { 0.0 };
    let ids = ["A", "B", "WIDE"];
    let mut ranked: Vec<(&str, f64)> = ids
        .iter()
        .map(|id| {
            let fatigue = if previous == Some(*id) {
                shot_fatigue * 0.5
            } else {
                0.0
            };
            let cont = if previous == Some(*id) { continuity } else { 0.0 };
            let boost = usable_boost(visual, id);
            let score = if *id == "WIDE" {
                wide_reset
                    + if previous == Some("WIDE") {
                        continuity
                    } else {
                        0.0
                    }
                    + shot_fatigue * 0.2
                    - if previous == Some("WIDE") {
                        fatigue
                    } else {
                        0.0
                    }
                    + boost
            } else if *id == speaker {
                speaker_value
                    + if clip.role == "backchannel" { 0.22 } else { 0.0 }
                    + cont
                    - fatigue
                    + boost
            } else {
                let r = if clip.role == "backchannel" {
                    0.12
                } else {
                    reaction
                };
                r + cont - fatigue + boost
            };
            (*id, score)
        })
        .collect();
    ranked.sort_by(|a, b| match b.1.partial_cmp(&a.1) {
        Some(Ordering::Equal) | None => a.0.cmp(b.0),
        Some(order) => order,
    });
    let mut candidate = ranked[0];
    if let Some(prev) = previous {
        if is_camera_usable(visual, Some(prev)) {
            let current_score = ranked
                .iter()
                .find(|item| item.0 == prev)
                .map(|item| item.1)
                .unwrap_or(0.0);
            if candidate.0 != prev && candidate.1 < current_score + HYSTERESIS {
                candidate = (prev, current_score);
            }
            let min_ms = if candidate.0 == "WIDE" {
                MIN_WIDE_MS
            } else if reaction >= 0.6 {
                MIN_REACTION_MS
            } else {
                MIN_NORMAL_MS
            };
            let dur = duration_of(clip);
            if candidate.0 != prev && dur < min_ms {
                candidate = (prev, current_score);
            }
        }
    }
    let mut punch = false;
    if jump {
        if let Some(prev) = previous {
            if candidate.0 == prev {
                let dur = duration_of(clip);
                if let Some(wide) = ranked.iter().find(|item| item.0 == "WIDE") {
                    if dur >= MIN_WIDE_MS {
                        candidate = *wide;
                    } else if let Some(reac) = ranked
                        .iter()
                        .find(|item| item.0 != prev && item.0 != "WIDE")
                    {
                        if dur >= MIN_REACTION_MS {
                            candidate = *reac;
                        } else {
                            punch = true;
                        }
                    } else {
                        punch = true;
                    }
                }
            }
        }
    }
    let morph = jump && previous == Some(candidate.0);
    let reason = if punch {
        "jump cut を punch-in で隠す".into()
    } else if morph {
        "jump cut を morph で隠す".into()
    } else if candidate.0 == "WIDE" {
        if jump || shot_fatigue >= 0.8 {
            "wide reset".into()
        } else {
            "wide".into()
        }
    } else if candidate.0 != speaker {
        "listener reaction".into()
    } else {
        "speaker camera".into()
    };
    let cam: &'static str = match candidate.0 {
        "B" => "B",
        "WIDE" => "WIDE",
        _ => "A",
    };
    (cam, punch, morph, reason)
}

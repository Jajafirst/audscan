import React, { useState, useRef, useEffect } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Animated, Dimensions, Easing } from "react-native";
import { useCameraPermissions, type CameraCapturedPicture, type CameraPictureOptions } from "expo-camera";
import { ExposureCamera } from "../components/ExposureCamera";
import { Accelerometer } from "expo-sensors";
import { TouchableOpacity } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { X } from "lucide-react-native";
import { Theme } from "../Theme";
import { useHistory } from "../contexts/HistoryContext";
import { useAccessibility } from "../contexts/AccessibilityContext";
import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as tf from "@tensorflow/tfjs";
import { decodeJpeg } from "@tensorflow/tfjs-react-native";

const MODEL_URL = "https://teachablemachine.withgoogle.com/models/Z11VY1264/";
const PASS_THRESHOLD = 0.80;
// Capture timing went through several designs before this one: a fixed
// timer, a manual button, motion detection inferred from camera frames, a
// scheduled sweep animation. All were replaced by a real accelerometer
// reading (see TILT_CAPTURE_THRESHOLD near sleep()) — the note now rests on
// a surface and the phone tilts, so capture triggers on an actual measured
// angle instead of trying to infer or schedule one.
//
// Three captures per step: first side, back through flat, other side. With
// only the two endpoints, a swing was the difference of two numbers and the
// same $50 read front swing anywhere from 0.0001 to 0.0366 across 12 scans
// — the check was mostly measuring which two
// angles happened to be caught. A middle angle gives every check a third look.
const TARGET_FRAMES = 3;

// Exposure bias in EV stops (negative = darker). Under auto-exposure the
// optically variable ink washes out to white wherever the light catches it,
// which is exactly the angle where its colour shows.
const COLOUR_EXPOSURE_EV = -2.5;

// ── Detection — Rolling Colour is the only check ───────────────────────────
// Flying Bird and Reversing Numeral (and with them the bird step and the
// back-side step) were removed 2026-10-04 evening. On 30 calibration scans
// (20 genuine $5/$10, 10 paper-fake $5)
// their genuine and fake values covered the same range, while they flagged
// 16 of 20 genuine notes:
//   bird excess    genuine −0.10…0.36   fake −0.01…0.39
//   numeral excess genuine −0.35…0.21   fake −0.37…0.07
// Likely cause: their crop zones were never verified against photos.
// Verify them before bringing either back.
//
// Clear Window, Dynamic Movement (back OVI swing) and the OCR mirrored-numeral
// read were removed earlier the same day for the same reason.
//
// Rolling Colour is DIFFERENTIAL against the plain-print `ref` zone in the
// same photo: lighting, glare and hand shadow hit both zones, so dividing by
// the reference leaves what the ink did on its own.

// Rolling Colour: per frame, vivid OVI colour ÷ reference-print colour
// (`oviRatio`), then how far that ratio swings across the tilt. OVI ink
// changes colour with angle, so its ratio to the steady print moves; a printed
// imitation keeps the same ratio at every angle. Replaces the absolute chroma
// swing, which tracked exposure as much as ink.
//   genuine (20): 0.036 0.119 0.135 0.139 0.148 0.151 … 0.985 (median ≈ 0.21)
//   fake $5 (10): 0.040 0.045 0.054 0.056 0.068 0.108 | 0.185 0.209 0.287 0.290
// 0.114 sits between the highest-caught fake and the lowest genuine above it:
// 19/20 genuine pass, 6/10 fakes caught on the calibration set.
const TH_OVI_RATIO_SWING = 0.114;
// Fraction of the OVI zone's most-coloured pixels that count as "the ink".
// The zone is the whole window band; the colour-shifting features are a small
// part of it, and averaging every pixel diluted them into the background.
const OVI_TOP_FRACTION = 0.10;

// ── THE VERDICT (since 2026-10-05): rainbow spread of the ink ──────────────
// TH_OVI_RATIO_SWING above measured how much the ink's colour STRENGTH changed
// with tilt. On the iPhone that also changes on a paper print (shadow, glare):
// it passed 0 of 7 fake $5 scans. Rainbow spread (see inkRainbow) measures how
// many different hues the ink pixels hold — a shadow can darken a colour but
// cannot add new ones. Calibration, iPhone 15 Pro, $5
// (max spread over the 3 tilt photos):
//   genuine (10): 0.010 0.013 0.025 0.049 0.054 0.055 0.067 0.074 0.215 0.519
//   fake    (7) : 0.002 0.002 0.003 0.003 0.003 0.003 | 0.057 (heavy glare)
// 0.006 sat between those: 10/10 genuine pass, 6/7 fakes caught.
// That set was under uncontrolled lighting. A test at 0.006 under better
// lighting caught only 2/10 fakes: brighter light brings out the printed
// colours on a colour-print fake too.
//
// Recalibrated 2026-10-05 with the lamp and note position FIXED
// (40 scans):
//   genuine: 0.038 … 0.532 (lowest in calibration 3: 0.049)
//   fake   : calibration 3: 0.002 … 0.017 (9/10), 0.203 (1)
// 0.03 → calibration 3: 10/10 genuine, 9/10 fakes; both sets: 20/20, 16/20.
// Depends on lighting — the app assumes a side lamp like the calibration setup.
const TH_INK_SPREAD = 0.03;

// Median is robust to the one bad frame (motion blur, glare) that a
// last-frame-wins or mean-based reading would let decide the whole check.
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function range(xs: number[]): number {
  return xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : 0;
}

const LABEL_TO_DENOM: Record<string, number> = {
  "new-5": 5, "new-10": 10, "new-20": 20, "new-50": 50, "new-100": 100,
};

// Colour Tone (DENOM_HUE hue ranges) was retired 2026-09-24 — see ./no-use/colorTone.ts.

type Rect = { x0: number; y0: number; x1: number; y1: number };

// Note frame geometry. Australian notes share a 65mm height but lengthen with
// value, so the frame — and therefore every zone crop inside it — has to be
// sized per denomination. A fixed 2.1 ratio fits the $10 and is roughly 13%
// too short for a $100, which would drag every crop out of position.
const NOTE_RATIO: Record<number, number> = {
  5: 130 / 65,  // 2.00
  10: 137 / 65,  // 2.11
  20: 144 / 65,  // 2.22
  50: 151 / 65,  // 2.32
  100: 158 / 65,  // 2.43
};
const DEFAULT_RATIO = NOTE_RATIO[10];

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const FRAME_W = SCREEN_W * 0.62;
const frameHeightFor = (d: number | null) => FRAME_W * (d ? NOTE_RATIO[d] ?? DEFAULT_RATIO : DEFAULT_RATIO);

// Where the on-screen frame sits, as fractions of the preview. Analysis crops
// to exactly this rectangle: measuring the whole frame measured the room —
// desk, hands and ambient light swamped the note and made real and fake alike.
const FRAME_CENTER_Y = (SCREEN_H - 120) / 2;   // frameWrap has paddingBottom: 120
const cropFor = (d: number | null) => {
  const h = frameHeightFor(d);
  return {
    x0: (SCREEN_W - FRAME_W) / 2 / SCREEN_W,
    y0: (FRAME_CENTER_Y - h / 2) / SCREEN_H,
    x1: (SCREEN_W + FRAME_W) / 2 / SCREEN_W,
    y1: (FRAME_CENTER_Y + h / 2) / SCREEN_H,
  };
};

// Sub-regions within the note, as fractions of the note held portrait.
//
// The colour-shifting features — Federation star, flying bird, perched bird and
// the numeral in the dome — all sit INSIDE the clear window strip, which
// photographs of a genuine $5 under raking light make plain. The OVI zones
// previously pointed at the printed corner numerals instead, which are ordinary
// flat ink and shift no colour at all.
//
// Both OVI zones now cover the window band generously rather than trying to pin
// one feature. That is safe because the checks read PEAK chroma: dull
// surroundings included in the crop cannot pull a maximum down, and whichever
// feature happens to fire at a given angle is caught.
interface NoteZones { rolling: Rect; reverse: Rect; numeral: Rect; window: Rect; ref: Rect }

// The series shares a design language — window roughly central, optical
// features inside it — so this layout is the starting point for every note.
// Each denomination gets its own entry below so a single one can be corrected
// without disturbing the others.
const ZONES_SERIES: NoteZones = {
  // Front and back OVI bands — the window strip plus a little margin
  rolling: { x0: 0.05, y0: 0.36, x1: 0.95, y1: 0.70 },
  reverse: { x0: 0.05, y0: 0.36, x1: 0.95, y1: 0.70 },
  // The reversing numeral sits at one end of the window strip, in the dome on
  // a $5. Reading the whole band gave OCR a busy image and it returned nothing
  // at all — neither plain nor mirrored — so the check could only ever report
  // failure. This narrower crop is upscaled before recognition so the digit is
  // large enough to resolve.
  numeral: { x0: 0.08, y0: 0.52, x1: 0.55, y1: 0.70 },
  window: { x0: 0.10, y0: 0.38, x1: 0.90, y1: 0.68 }, // clear polymer window
  // Plain printed area with no optical features — the control for every
  // differential measurement. What happens here is lighting, not security ink.
  ref: { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.30 },
};

// Per-denomination zones. Each note carries a different bird and its features
// may sit at slightly different heights within the window, so these are kept
// separate even where the values currently match. To correct one, replace its
// spread with explicit rectangles — nothing else needs to change.
//
// A scan whose p1Peak comes back near zero means the band missed the window on
// that denomination and its entry needs real measurements.
const ZONES: Record<number, NoteZones> = {
  5: { ...ZONES_SERIES }, // Eastern Spinebill    — unverified
  10: { ...ZONES_SERIES }, // checked against a real note
  20: { ...ZONES_SERIES }, // Laughing Kookaburra  — unverified
  50: { ...ZONES_SERIES }, // Black Swan           — unverified
  100: { ...ZONES_SERIES }, // Masked Owl           — unverified
};
const zonesFor = (d: number | null) => (d && ZONES[d]) || ZONES_SERIES;

// Crop a decoded image to a normalised rectangle
function cropRect(img: tf.Tensor3D, r: Rect): tf.Tensor3D {
  const [h, w] = img.shape;
  const top = Math.max(0, Math.round(r.y0 * h));
  const left = Math.max(0, Math.round(r.x0 * w));
  const height = Math.max(1, Math.min(h - top, Math.round((r.y1 - r.y0) * h)));
  const width = Math.max(1, Math.min(w - left, Math.round((r.x1 - r.x0) * w)));
  return img.slice([top, left, 0], [height, width, -1]);
}

// cropFor() is in SCREEN fractions, but the photo is not the screen:
//  1. With skipProcessing, Android returns raw sensor pixels — landscape
//     (e.g. 1920x1440) while the phone is held upright. decodeJpeg ignores the
//     EXIF orientation, so the tensor is rotated 90° from what the user saw.
//  2. The preview fills the screen by cropping the photo ("cover"), so the
//     photo extends past the screen edges and screen fraction != photo fraction.
// Verified 2026-09-24 on the test Android by pulling the photos off the phone:
// the old direct mapping measured a region spread across three different
// notes; with rotation + cover mapping the frame lands exactly on the note.

// Screen-fraction rect → fraction of an UPRIGHT photo of size pw x ph.
function screenRectToPhoto(r: Rect, pw: number, ph: number): Rect {
  const s = Math.max(SCREEN_W / pw, SCREEN_H / ph);
  const vw = pw * s, vh = ph * s;               // photo size as drawn on screen
  const ox = (vw - SCREEN_W) / 2, oy = (vh - SCREEN_H) / 2;
  return {
    x0: (r.x0 * SCREEN_W + ox) / vw, x1: (r.x1 * SCREEN_W + ox) / vw,
    y0: (r.y0 * SCREEN_H + oy) / vh, y1: (r.y1 * SCREEN_H + oy) / vh,
  };
}

// A zone given as fractions of an outer rect → fractions of the whole image.
function subRect(outer: Rect, z: Rect): Rect {
  const w = outer.x1 - outer.x0, h = outer.y1 - outer.y0;
  return { x0: outer.x0 + z.x0 * w, x1: outer.x0 + z.x1 * w, y0: outer.y0 + z.y0 * h, y1: outer.y0 + z.y1 * h };
}

// Crop the camera image to the note frame for this denomination, then
// optionally to a zone inside it. Always returns the crop UPRIGHT (as seen on
// screen). For a landscape (raw sensor) image the rect is mapped into raw
// coordinates, cropped there, and only the small crop is rotated 90° clockwise
// — rotating the whole photo first would cost a full-frame transpose per zone.
function cropToNote(img: tf.Tensor3D, denom: number | null, zone?: Rect): tf.Tensor3D {
  const [h, w] = img.shape;
  const landscape = w > h;
  const upW = landscape ? h : w, upH = landscape ? w : h;
  let r = screenRectToPhoto(cropFor(denom), upW, upH);
  if (zone) r = subRect(r, zone);
  if (!landscape) return cropRect(img, r);
  // upright (x, y) ↔ raw (x = y_up, y = 1 - x_up) for a 90° clockwise rotation
  const raw: Rect = { x0: r.y0, x1: r.y1, y0: 1 - r.x1, y1: 1 - r.x0 };
  return tf.reverse(tf.transpose(cropRect(img, raw), [1, 0, 2]), 1) as tf.Tensor3D;
}

type ScanPhase = "setup" | "loading" | "serial" | "phase1" | "done";
type CheckStatus = "pending" | "pass" | "fail" | "unread";
interface CheckItem { label: string; status: CheckStatus }

// The angle the on-screen rocking icon demonstrates, and the number named in
// the copy. Not a measured requirement — no gyroscope reading backs it — but
// a concrete target beats "slowly" alone: three genuine scans in a row showed
// front colour swing falling from 0.0566 to 0.0243 to 0.0134 right after the
// setup screen told users to move slowly with no indication of how far. A
// slow, shallow tilt is exactly what would produce that decline.
const TILT_TARGET_DEG = 35;

// Photos default to full sensor resolution (tens of megapixels). Every photo
// is decoded to a tensor on the JS thread, so on the test Android that froze
// the app after the first capture at ~1 GB of RAM. Pick the smallest size
// whose long side is still >= MIN_PHOTO_LONG_SIDE, with the SAME aspect ratio
// as the full sensor — the crop zones are fractions of the photo, so a
// different aspect would shift every zone off its feature.
const MIN_PHOTO_LONG_SIDE = 1600;
function choosePictureSize(sizes: string[]): string | undefined {
  const parsed = sizes
    .map(str => { const m = str.match(/(\d+)\s*x\s*(\d+)/i); return m ? { str, w: +m[1], h: +m[2] } : null; })
    .filter((p): p is { str: string; w: number; h: number } => !!p && p.w > 0 && p.h > 0);
  if (!parsed.length) return undefined;
  const full = parsed.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const aspect = Math.max(full.w, full.h) / Math.min(full.w, full.h);
  const ok = parsed.filter(p =>
    Math.abs(Math.max(p.w, p.h) / Math.min(p.w, p.h) - aspect) < 0.02 &&
    Math.max(p.w, p.h) >= MIN_PHOTO_LONG_SIDE);
  if (!ok.length) return undefined;
  return ok.reduce((a, b) => (b.w * b.h < a.w * a.h ? b : a)).str;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// The interaction inverted: the note now rests flat on a surface and the
// PHONE tilts, not the note. Every earlier design (fixed timer, an animation
// disconnected from capture, motion detection inferred from camera frames,
// a fixed-schedule sweep) was trying to guess or infer whether real tilting
// had happened. None of them could know for certain, because none of them
// had access to a real measurement of anything physically moving.
//
// A phone's accelerometer can. With the phone held roughly flat, camera
// facing down at the note, gravity's component on the device's X axis grows
// as the phone rolls left or right — reading close to 0 when flat, rising in
// magnitude as the tilt increases. That's a real, direct measurement of the
// same motion the on-screen scale represents, not an inference from pixels.
//
// TILT_CAPTURE_THRESHOLD is in accelerometer g-units — UNVERIFIED on a real
// device: the axis (x vs y) and its sign depend on how the phone is actually
// held, which can only be confirmed by watching the live reading while
// tilting a real phone. If the scale moves the wrong way, or capture never
// triggers, that's the first thing to check — see the [Tilt] log line.
const TILT_CAPTURE_THRESHOLD = 0.35; // g — how far you must roll before a side counts as "reached"
const TILT_POLL_MS = 40;             // how often the wait loop checks the live reading
// If a side is not reached in time, that side is SKIPPED — no photo. Taking a
// flat photo on timeout (the old behaviour) fed a non-tilted frame into every
// swing check as if it were tilted, which is bad data dressed up as good.
const TILT_WAIT_TIMEOUT_MS = 20000;
const TILT_LATE_HINT_MS = 6000;       // after this, the prompt changes to "tilt further"
const CENTER_WAIT_TIMEOUT_MS = 4000;
// Serial step: how long to keep reading for the note's value after the serial
// is found, before moving on without it.
const DENOM_WAIT_MS = 6000;  // middle (flat) shot — see waitForCenter

function getDominantHue(r: tf.Tensor, g: tf.Tensor, b: tf.Tensor): number {
  const rM = r.mean().dataSync()[0] / 255;
  const gM = g.mean().dataSync()[0] / 255;
  const bM = b.mean().dataSync()[0] / 255;
  const max = Math.max(rM, gM, bM);
  const min = Math.min(rM, gM, bM);
  const delta = max - min;
  if (delta < 0.01) return 0;
  let hue = 0;
  if (max === rM) hue = 60 * (((gM - bM) / delta) % 6);
  else if (max === gM) hue = 60 * ((bM - rM) / delta + 2);
  else hue = 60 * ((rM - gM) / delta + 4);
  return hue < 0 ? hue + 360 : hue;
}

// Dominant hue of one zone of the note — logged only (hue tracks white
// balance), never scored.
function zoneHue(img: tf.Tensor3D, denom: number | null, zone: Rect): number {
  const z = tf.image.resizeBilinear(cropToNote(img, denom, zone), [96, 96]).toFloat();
  return getDominantHue(
    z.slice([0, 0, 0], [-1, -1, 1]),
    z.slice([0, 0, 1], [-1, -1, 1]),
    z.slice([0, 0, 2], [-1, -1, 1]),
  );
}

// Per-pixel chroma (max − min of R,G,B) of one zone, 96x96, flattened.
function zoneChromaPixels(img: tf.Tensor3D, denom: number | null, zone: Rect): tf.Tensor1D {
  const z = tf.image.resizeBilinear(cropToNote(img, denom, zone), [96, 96]).toFloat().div(255);
  return z.max(2).sub(z.min(2)).flatten() as tf.Tensor1D;
}

// Mean chroma of the most-coloured OVI_TOP_FRACTION of a zone's pixels — the
// ink itself, not the band around it.
function zoneVividChroma(img: tf.Tensor3D, denom: number | null, zone: Rect): number {
  const px = zoneChromaPixels(img, denom, zone);
  const k = Math.max(1, Math.round(px.size * OVI_TOP_FRACTION));
  return tf.topk(px, k).values.mean().dataSync()[0];
}

function patchFromTensor(t: tf.Tensor3D): number[] {
  const small = tf.image.resizeBilinear(t, [PATCH_N, PATCH_N]).toFloat();
  const pg = small.slice([0, 0, 0], [-1, -1, 1]).mul(0.299)
    .add(small.slice([0, 0, 1], [-1, -1, 1]).mul(0.587))
    .add(small.slice([0, 0, 2], [-1, -1, 1]).mul(0.114)).div(255);
  const m = pg.mean();
  const sd = pg.sub(m).square().mean().sqrt();
  return Array.from(pg.sub(m).div(sd.add(1e-4)).dataSync());
}

// ── Rainbow measure (LOGGED ONLY, not scored — 2026-10-05) ─────────────────
// The verdict's colour-strength swing can't tell optically variable ink from
// a paper print's shadows and glare: on the iPhone the paper fake $5 swung
// 0.17–0.33, the same range as the genuine note. Real OVI changes WHICH colour
// it is with angle; a shadow only changes how strong the same colour is.
// So for the ink pixels alone (top OVI_TOP_FRACTION by chroma) this records:
//   inkHue    — chroma-weighted circular mean hue, minus the whole note's
//               mean hue (cancels white-balance drift between photos)
//   inkSpread — 1 − resultant length of those hues: 0 = one colour,
//               towards 1 = many colours (rainbow)
// Collected per frame; [P1 Final] logs how far inkHue turns across the tilt.

// Chroma-weighted circular mean hue (deg) and spread (0..1) of RGB pixels
// (values 0..1, interleaved), optionally only the top `frac` by chroma.
function hueStats(px: Float32Array | Int32Array | Uint8Array, frac: number): { hue: number; spread: number } {
  const n = px.length / 3;
  const items: { c: number; h: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = px[3 * i], g = px[3 * i + 1], b = px[3 * i + 2];
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    items.push({ c, h: Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) });
  }
  const keep = frac < 1 ? items.sort((a, b) => b.c - a.c).slice(0, Math.max(1, Math.round(n * frac))) : items;
  let sx = 0, sy = 0, sw = 0;
  for (const { c, h } of keep) { sx += c * Math.cos(h); sy += c * Math.sin(h); sw += c; }
  if (sw <= 1e-6) return { hue: 0, spread: 1 };
  return { hue: (Math.atan2(sy, sx) * 180) / Math.PI, spread: 1 - Math.hypot(sx, sy) / sw };
}

const angleDiff = (a: number, b: number) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

// Largest angular difference between any two hues in the list (deg).
function hueRange(hs: number[]): number {
  let m = 0;
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) m = Math.max(m, Math.abs(angleDiff(hs[i], hs[j])));
  return m;
}

function inkRainbow(img: tf.Tensor3D, denom: number | null, zone: Rect): { inkHue: number; inkSpread: number } {
  const ink = hueStats(tf.image.resizeBilinear(cropToNote(img, denom, zone), [96, 96]).div(255).dataSync() as Float32Array, OVI_TOP_FRACTION);
  const note = hueStats(tf.image.resizeBilinear(cropToNote(img, denom), [64, 64]).div(255).dataSync() as Float32Array, 1);
  return { inkHue: angleDiff(ink.hue, note.hue), inkSpread: ink.spread };
}

// Rolling Colour frame: vivid OVI colour relative to the plain print.
function analyzePhase1Frame(raw: Uint8Array, denom: number | null) {
  return tf.tidy(() => {
    const img = decodeJpeg(raw, 3);
    const z = zonesFor(denom);
    const oviChroma = zoneVividChroma(img, denom, z.rolling);
    const refChroma = zoneChromaPixels(img, denom, z.ref).mean().dataSync()[0];
    // Floor stops a near-grey reference from blowing the ratio up.
    const oviRatio = oviChroma / Math.max(refChroma, 0.01);
    const oviHue = zoneHue(img, denom, z.rolling);
    const { inkHue, inkSpread } = inkRainbow(img, denom, z.rolling);
    // Whole-note pattern, only for checkTiltMoved.
    const framePatch = patchFromTensor(tf.image.resizeBilinear(cropToNote(img, denom), [256, 256]));
    console.log(`[P1] oviChroma=${oviChroma.toFixed(4)} refChroma=${refChroma.toFixed(4)} oviRatio=${oviRatio.toFixed(3)} hue=${oviHue.toFixed(1)}° inkHue=${inkHue.toFixed(1)}° inkSpread=${inkSpread.toFixed(3)}`);
    return { oviChroma, oviRatio, oviHue, inkHue, inkSpread, framePatch };
  });
}

// Pattern difference between two captures (used only by checkTiltMoved).
// Comparing the patches where they sit does not work: the note is handheld,
// so the fixed-fraction crop lands on a slightly different part of it each
// frame, and the resulting difference is the crop moving rather than the
// feature changing. Measured on the counterfeit it returned 0.9345 — roughly
// what two unrelated images score — from a flat print that cannot change.
//
// So slide one patch over the other and keep the BEST match. Whatever
// difference survives the best possible alignment is a real change of pattern,
// not drift. SEARCH is in patch pixels.
const PATCH_N = 48;
const PATCH_SEARCH = 15;
function alignedDifference(a: number[], b: number[]): number {
  let best = Infinity;
  for (let dy = -PATCH_SEARCH; dy <= PATCH_SEARCH; dy++) {
    for (let dx = -PATCH_SEARCH; dx <= PATCH_SEARCH; dx++) {
      let sum = 0, n = 0;
      for (let y = 0; y < PATCH_N; y++) {
        const sy = y + dy;
        if (sy < 0 || sy >= PATCH_N) continue;
        for (let x = 0; x < PATCH_N; x++) {
          const sx = x + dx;
          if (sx < 0 || sx >= PATCH_N) continue;
          sum += Math.abs(a[y * PATCH_N + x] - b[sy * PATCH_N + sx]);
          n++;
        }
      }
      // Ignore offsets where the patches barely overlap — a sliver can match
      // by accident and would report a spuriously good alignment.
  if (n > PATCH_N * PATCH_N * 0.5) best = Math.min(best, sum / n);
    }
  }
  // Let the high difference pass through so checkTiltMoved works correctly
  return best === Infinity ? 0 : best;
}

const fmt = (xs: number[]) => xs.map(d => d.toFixed(3)).join(" ");

// Whether the first and last captures of a step actually look like different
// angles at all. Capture waits for a real accelerometer reading, so this is a
// second, independent guard: two photos that don't look like different angles
// mean "you didn't really tilt" — NOT READ, not SUSPICIOUS. MIN_TILT_MOVED is
// provisional.
const MIN_TILT_MOVED = 0.20;
function checkTiltMoved(framePatches: number[][]): { moved: boolean; dist: number } {
  if (framePatches.length < 2) return { moved: true, dist: 1 }; // nothing to compare — don't block on it
  const dist = alignedDifference(framePatches[0], framePatches[framePatches.length - 1]);
  return { moved: dist >= MIN_TILT_MOVED, dist };
}
function parseOcrText(blocks: any[]): { serial: string | null; denom: number | null } {
  const raw = blocks.map((b: any) => b.text).join(" ");
  const clean = raw.toUpperCase().replace(/[^A-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  // Whole words only: every note says "LEGAL TENDER", and a substring match
  // on "TEN" read a $5 (and $50) as $10 whenever OCR caught that line first.
  const has = (w: string) => new RegExp(`\\b${w}\\b`).test(clean);
  let denom: number | null = null;
  if (has("HUNDRED")) denom = 100;
  else if (has("FIFTY")) denom = 50;
  else if (has("TWENTY")) denom = 20;
  else if (has("TEN")) denom = 10;
  else if (has("FIVE")) denom = 5;

  const m = clean.match(/\b([A-Z]{2})\s*(\d[\d\s]{6,8}\d)\b/);
  const serial = m ? (m[1] + " " + m[2].replace(/\s/g, "")) : null;
  console.log(`[OCR] serial=${serial} denom=${denom}`);
  return { serial, denom };
}

export function CameraScreen() {
  const navigation = useNavigation<any>();
  const { addScan } = useHistory();
  const { triggerHaptic, isHighContrastEnabled } = useAccessibility();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);
  const hc = isHighContrastEnabled;
  const accent = hc ? "#CCFF00" : Theme.colors.gold;

  const [phase, setPhaseState] = useState<ScanPhase>("setup");
  const [progress, setProgress] = useState(0);
  const [serial, setSerial] = useState<string>("");
  const [denom, setDenom] = useState<number | null>(null);
  const [ocrStatus, setOcrStatus] = useState<"scanning" | "found" | "notfound">("scanning");
  const [tiltHint,  setTiltHint]  = useState(0);
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);
  const pictureSizeChosenRef = useRef(false);
  const [checks, setChecks] = useState<CheckItem[]>([
    { label: "Serial Number", status: "pending" },
    { label: "Rolling Colour", status: "pending" },
  ]);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modelRef = useRef<tf.LayersModel | null>(null);
  const labelsRef = useRef<string[]>([]);
  const modelReadyRef = useRef(false);
  const cameraReadyRef = useRef(false);
  const ocrRunningRef = useRef(false);
  const serialStartedRef = useRef(false);

  // Every per-frame measurement is collected, then reduced once at the end of
  // the phase — a single blurred or glared frame must not decide a check.
  const p1 = useRef({
    denomination: null as number | null,
    mlScore: 0,
    serialNumber: "",
    // true = FAILED, false = passed, null = not read (a tilt side was skipped).
    rollingColour: null as boolean | null,
    oviChromas: [] as number[],
    oviRatios: [] as number[],
    oviHues: [] as number[],
    inkHues: [] as number[],      // rainbow measure — logged only
    inkSpreads: [] as number[],
    // Whole-note patch per capture — see checkTiltMoved.
    framePatches: [] as number[][],
  });
  const autoAdvancedRef = useRef(false);
  const serialSeenAtRef = useRef(0);
  // Mirrors `phase` so the deferred auto-advance can check the user has not
  // already moved on (or cancelled) before it fires.
  const phaseRef = useRef<ScanPhase>("loading");
  // Updates phaseRef in the same tick as the state. The scan flow is async
  // and checks phaseRef right after switching steps; when it was only synced
  // by a useEffect, a tilt that registered instantly (phone still tilted from
  // the previous step) saw the OLD phase, assumed the user had left, and quit
  // the step — leaving the screen up with nothing listening.
  const setPhase = (p: ScanPhase) => { phaseRef.current = p; setPhaseState(p); };
  // Drives the on-screen scale, updated live from the accelerometer on every
  // reading (see the Accelerometer subscription below) — a real sensor value,
  // not a scheduled animation. Reused as-is from the earlier sweep design
  // since GuideTrack already reads it the same way either way.
  const tiltAnim = useRef(new Animated.Value(0)).current;
  // The live reading itself, for the capture-wait loop to poll. A ref, not
  // state — this updates far too often (every accelerometer sample) to run
  // through React's render cycle.
  const liveTiltRef = useRef({ x: 0, y: 0 });
  // "move" = waiting for the phone to reach the target tilt. "captured"
  // = the flash shown right when a photo is taken, at that instant.
  const [motionStatus, setMotionStatus] = useState<"move" | "captured">("move");
  // Which side the app is waiting for (0 = either), and whether the wait has
  // run long — both only drive the on-screen prompt.
  const [tiltTarget, setTiltTarget] = useState<-1 | 0 | 1>(0);
  const [tiltLate, setTiltLate] = useState(false);

  // Pure UX layer, no bearing on capture timing (that's liveTiltRef /
  // waitForTilt). Screen-flash on capture and a
  // continuous demo sweep inside the note frame — both driven by Animated
  // values so neither re-renders React at accelerometer/frame rate.
  const flashOpacity       = useRef(new Animated.Value(0)).current;
  const sweepAnim          = useRef(new Animated.Value(0)).current;
  const capturedTextOpacity = useRef(new Animated.Value(0)).current;
  // Pulses HOLD STILL while the dot sits at the threshold — gated to zero
  // everywhere else by multiplying with holdOpacity in MotionStatusLine, so
  // it always runs but is only ever visible in that one zone.
  const holdPulse = useRef(new Animated.Value(0.55)).current;
  const captureFlashAnim = useRef(new Animated.Value(0)).current;
  // One camera, one photo at a time: the bird burst timer and every side
  // capture share this lock. A ref so every phase sees the same flag — it
  // used to be a local inside startBirdPhase, invisible to the tilt phases.
  const burstBusyRef = useRef(false);

  useEffect(() => {
    if (motionStatus === "captured") {
      flashOpacity.setValue(0);
      Animated.parallel([
        Animated.sequence([
          Animated.timing(flashOpacity, { toValue: 0.4, duration: 80,  useNativeDriver: true }),
          Animated.timing(flashOpacity, { toValue: 0,   duration: 220, useNativeDriver: true }),
        ]),
        Animated.timing(capturedTextOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.timing(capturedTextOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
    }
  }, [motionStatus]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweepAnim, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(sweepAnim, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(holdPulse, { toValue: 1,    duration: 500, useNativeDriver: true }),
        Animated.timing(holdPulse, { toValue: 0.55, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // Live accelerometer subscription for the whole scan session — cheaper to
  // keep running than to subscribe/unsubscribe every phase, and short-lived
  // either way since a scan only takes a few seconds.
  useEffect(() => {
    Accelerometer.setUpdateInterval(TILT_POLL_MS);
    const sub = Accelerometer.addListener(({ x, y }) => {
      liveTiltRef.current = { x, y };
      tiltAnim.setValue(Math.max(-1, Math.min(1, x / TILT_CAPTURE_THRESHOLD)));
    });
    return () => sub.remove();
  }, []);

  // A real scan proved the "any direction" version of this wrong: tilting up
  // and down (vertical, y-axis) collapsed chromaSwing to 0.0023-0.0053 on the
  // SAME genuine note that hit 0.0204 on a left/right tilt. That matches the
  // physics that was in this file before the any-direction request: OVI ink
  // and the reversing numeral respond to light raking ACROSS the note
  // (horizontal), not to pitch. So the capture trigger reads the horizontal
  // axis only — y is tracked and shown for feedback, but never gates a
  // capture. Magnitude-of-both was the bug; only x can actually produce the
  // signal these checks depend on.
  //
  // direction -1 = left, 1 = right, 0 = whichever side comes first. Returns
  // the side reached, or null if it timed out or the user left the step —
  // callers take NO photo on null.
  // No phase check in here: each step calls this right after setPhase(),
  // before the effect updates phaseRef, so a "phase changed" check fired
  // instantly and skipped every step's first side. Callers check the phase
  // themselves after this returns.
  const waitForTilt = async (direction: -1 | 0 | 1): Promise<-1 | 1 | null> => {
    // A step's first side (direction 0): start from roughly flat. Otherwise a
    // phone still tilted from the previous step captures instantly, before
    // the user has even lined the note up.
    if (direction === 0) await waitForCenter();
    setTiltTarget(direction);
    setTiltLate(false);
    const start = Date.now();
    let lateShown = false;
    while (Date.now() - start < TILT_WAIT_TIMEOUT_MS) {
      const { x, y } = liveTiltRef.current;
      const side = x <= -TILT_CAPTURE_THRESHOLD ? -1 : x >= TILT_CAPTURE_THRESHOLD ? 1 : 0;
      if (side !== 0 && (direction === 0 || side === direction)) {
        // The reading that actually triggered this capture — the only way to
        // tell, from the log alone, whether TILT_CAPTURE_THRESHOLD is sane on
        // a real device, or needs correcting.
        console.log(`[Tilt] reached ${side === -1 ? "LEFT" : "RIGHT"} x=${x.toFixed(3)} y=${y.toFixed(3)} after ${Date.now() - start}ms (threshold ${TILT_CAPTURE_THRESHOLD})`);
        setTiltLate(false);
        return side;
      }
      if (!lateShown && Date.now() - start > TILT_LATE_HINT_MS) { lateShown = true; setTiltLate(true); }
      await sleep(TILT_POLL_MS);
    }
    const { x, y } = liveTiltRef.current;
    const want = direction === -1 ? "LEFT" : direction === 1 ? "RIGHT" : "EITHER";
    console.log(`[Tilt] TIMED OUT waiting for ${want} tilt — side SKIPPED, no photo — last x=${x.toFixed(3)} y=${y.toFixed(3)}`);
    setTiltLate(false);
    return null;
  };

  // Second capture goes to the side opposite the first; if the first was
  // skipped, either side will do.
  const oppositeOf = (side: -1 | 1 | null): -1 | 0 | 1 => (side === null ? 0 : side === -1 ? 1 : -1);

  // Waits for the phone to pass back through roughly flat, between the away
  // and return captures — used only for the reversing-numeral's extra middle
  // shot (see startPhase2), which needs a genuinely different angle from the
  // away capture, not just "close to the last one." Horizontal only, same
  // reasoning as waitForTilt.
  const waitForCenter = async () => {
    const start = Date.now();
    while (Date.now() - start < CENTER_WAIT_TIMEOUT_MS) {
      if (Math.abs(liveTiltRef.current.x) < TILT_CAPTURE_THRESHOLD * 0.35) return;
      await sleep(TILT_POLL_MS);
    }
  };

  // Flash the screen white for ~380 ms at the instant each photo is taken.
  // Uses the native driver so it does not block image analysis on the JS thread.
  const triggerCaptureFlash = () => {
    captureFlashAnim.setValue(0.45);
    Animated.timing(captureFlashAnim, {
      toValue: 0, duration: 380, useNativeDriver: true,
    }).start();
  };

  // Every tilt step renders its own <CameraView>, so the camera re-initialises
  // on each step. A takePictureAsync issued before it is ready can hang with
  // no error — the scan then waited forever ("froze") while the screen showed
  // 0 captured. Each attempt is capped, retried, and logged.
  const takePhoto = async (opts: CameraPictureOptions): Promise<CameraCapturedPicture | null> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!cameraRef.current) { await sleep(300); continue; }
      const t0 = Date.now();
      try {
        const photo = await withTimeout(cameraRef.current.takePictureAsync(opts) as Promise<CameraCapturedPicture>, 4000);
        if (photo && (photo.base64 || photo.uri)) {
          console.log(`[Capture] ok ${photo.width}x${photo.height} in ${Date.now() - t0}ms (attempt ${attempt})`);
          return photo;
        }
        console.log(`[Capture] attempt ${attempt} ${photo ? "returned empty" : "timed out after 4000ms"}`);
      } catch (e) {
        console.log(`[Capture] attempt ${attempt} error: ${e}`);
      }
      await sleep(400);
    }
    console.log("[Capture] FAILED after 3 attempts — side not captured");
    return null;
  };

  // Called the moment the photo is taken — before the slow decode + analysis —
  // so the user sees "captured" and can stop holding the tilt right away.
  const markCaptured = (side: number) => {
    setProgress((side + 1) / TARGET_FRAMES);
    setMotionStatus("captured");
    triggerCaptureFlash();
  };

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const statusOf = (failed: boolean | null): "pass" | "fail" | "unread" =>
    failed === null ? "unread" : failed ? "fail" : "pass";

  const updateCheck = (label: string, status: "pass" | "fail" | "unread") =>
    setChecks(prev => prev.map(c => c.label === label ? { ...c, status } : c));

  const stopInterval = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  // True while the user is still moving into the position just asked for.
  // Capture waits this out so frames are taken with the note held, not mid-swing.
  // The scan does not start the moment the screen opens. Repeat scans of the
  // same genuine note produced swing values from 0.024 to 0.057 on one check
  // alone — a spread as wide as the real/fake gap it is meant to detect — and
  // the working theory is that grip, distance and tilt speed vary between
  // scans more than the note does. A short guided setup, held the same way
  // every time, is the only lever that can fix that; the pixel measurements
  // cannot correct for it after the fact.
  const setupDoneRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        await tf.ready();
        const meta = await (await fetch(`${MODEL_URL}metadata.json`)).json();
        labelsRef.current = meta.labels ?? [];
        modelRef.current = await tf.loadLayersModel(`${MODEL_URL}model.json`);
        const dummy = tf.zeros([1, 224, 224, 3]);
        modelRef.current.predict(dummy);
        dummy.dispose();
        modelReadyRef.current = true;
        if (cameraReadyRef.current && setupDoneRef.current) startSerialPhase();
      } catch (e: any) { console.error("[ML] Load failed:", e?.message); }
    })();
    return () => stopInterval();
  }, []);

  const onCameraReady = () => {
    cameraReadyRef.current = true;
    if (!pictureSizeChosenRef.current && cameraRef.current) {
      pictureSizeChosenRef.current = true;
      cameraRef.current.getAvailablePictureSizesAsync()
        .then(sizes => {
          const chosen = choosePictureSize(sizes);
          console.log(`[Camera] picture sizes=[${sizes.join(", ")}] → using ${chosen ?? "default (full)"}`);
          if (chosen) setPictureSize(chosen);
        })
        .catch(e => console.log(`[Camera] getAvailablePictureSizesAsync failed: ${e}`));
    }
    if (modelReadyRef.current && setupDoneRef.current) startSerialPhase();
  };

  const beginScan = () => {
    setupDoneRef.current = true;
    setPhase("loading");
    if (cameraReadyRef.current && modelReadyRef.current) startSerialPhase();
  };

  // ─── STEP 1: Serial ──────────────────────────────────────────────────────
  // Three places can call this (model loaded, camera ready, Begin tapped), and
  // each step mounts a new CameraView that fires onCameraReady again. Without
  // the guard, a second OCR interval started, only the last one was cleared,
  // and the orphan kept taking photos through every tilt step — fighting the
  // tilt captures for the camera ("Failed to capture image", 13 s captures).
  const startSerialPhase = () => {
    if (serialStartedRef.current) return;
    serialStartedRef.current = true;
    stopInterval();
    setPhase("serial");
    setOcrStatus("scanning");

    intervalRef.current = setInterval(async () => {
      if (phaseRef.current !== "serial") { stopInterval(); return; }
      if (!cameraRef.current || ocrRunningRef.current) return;
      ocrRunningRef.current = true;
      try {
        const photo = await takePhoto({
          base64: false, quality: 0.85, skipProcessing: false,
        });
        if (!photo?.uri) return;

        const ocr = await withTimeout(TextRecognition.recognize(photo.uri), 3000);
        if (!ocr) { setOcrStatus("notfound"); return; }

        const { serial: sn, denom: d } = parseOcrText(ocr.blocks);
        if (d && !p1.current.denomination) { p1.current.denomination = d; setDenom(d); }
        if (sn) {
          p1.current.serialNumber = sn;
          setSerial(sn);
          setOcrStatus("found");
          updateCheck("Serial Number", "pass");
          if (!serialSeenAtRef.current) serialSeenAtRef.current = Date.now();
        } else if (!p1.current.serialNumber) {
          setOcrStatus("notfound");
        }
        // Advance on its own once the serial AND the value are read. Advancing
        // on the serial alone left the value unread on some scans, and without
        // it the scan cannot PASS (it sizes every crop). If the value still
        // isn't read DENOM_WAIT_MS after the serial, move on anyway — the
        // verdict screen then says "value not recognised".
        const haveBoth = !!p1.current.serialNumber && !!p1.current.denomination;
        const waitedOut = serialSeenAtRef.current > 0 && Date.now() - serialSeenAtRef.current > DENOM_WAIT_MS;
        if ((haveBoth || waitedOut) && !autoAdvancedRef.current) {
          autoAdvancedRef.current = true;
          if (!haveBoth) console.log(`[OCR] value not read ${DENOM_WAIT_MS}ms after serial — continuing without it`);
          setTimeout(() => { if (phaseRef.current === "serial") confirmSerial(); }, 400);
        }
      } catch { } finally { ocrRunningRef.current = false; }
    }, 500);
  };

  const runMlDenomination = (raw: Uint8Array) => {
    if (!modelRef.current) return;
    const scores: number[] = tf.tidy(() => {
      const img = decodeJpeg(raw, 3);
      const norm = tf.image.resizeBilinear(img, [224, 224]).toFloat().div(255).expandDims(0);
      return Array.from((modelRef.current!.predict(norm) as tf.Tensor).dataSync());
    });
    const topIdx = scores.indexOf(Math.max(...scores));
    const topScore = scores[topIdx];
    const topLabel = labelsRef.current[topIdx] ?? "";
    const mlDenom = LABEL_TO_DENOM[topLabel] ?? null;
    console.log(`[ML] ${topLabel}=${topScore.toFixed(3)} denom=${mlDenom}`);

    // Logged and passed to the Verdict screen as `confidence` only. The model
    // NEVER sets the denomination: it has no authenticity
    // signal, the denomination sizes every crop zone, and on 2026-09-24 it
    // called a genuine $10 "$5" (0.95) and "$100" (0.73). Denomination comes
    // from OCR alone; with no OCR denomination the scan cannot PASS.
    if (mlDenom && topScore > p1.current.mlScore) p1.current.mlScore = topScore;
  };

  const confirmSerial = () => {
    stopInterval();
    if (!serial) updateCheck("Serial Number", "fail");
    startPhase1();
  };

  // ─── Shared capture sequence for every tilt step ─────────────────────────
  // The note stays flat on a surface; the phone tilts. Three captures: the
  // first side reached, back through flat, then the opposite side. The middle
  // shot is only taken after a real first-side capture — with that side
  // skipped, "passing through flat" has nothing to be between.
  const captureFrame = async (i: number): Promise<Uint8Array | null> => {
    if (!cameraRef.current) return null;
    while (burstBusyRef.current) await sleep(50);
    burstBusyRef.current = true;
    try {
      const photo = await takePhoto({ base64: true, quality: 0.7, skipProcessing: true, shutterSound: false });
      if (photo) markCaptured(i);
      return photo?.base64 ? Uint8Array.from(atob(photo.base64), c => c.charCodeAt(0)) : null;
    } catch { return null; } finally { burstBusyRef.current = false; }
  };

  // Returns false if the user left the step part-way.
  const runTiltSequence = async (step: ScanPhase, onFrame: (raw: Uint8Array) => void): Promise<boolean> => {
    const shoot = async (i: number) => {
      const raw = await captureFrame(i);
      if (raw) { try { onFrame(raw); } catch (e: any) { console.log(`[${step}] analysis failed: ${e?.message}`); } }
      setMotionStatus("move");
    };
    const first = await waitForTilt(0);
    if (phaseRef.current !== step) return false;
    if (first !== null) {
      await shoot(0);
      await waitForCenter();
      if (phaseRef.current !== step) return false;
      await shoot(1);
    }
    const second = await waitForTilt(oppositeOf(first));
    if (phaseRef.current !== step) return false;
    if (second !== null) await shoot(2);
    return true;
  };

  // ─── STEP 2: Rolling Colour (front) ──────────────────────────────────────
  const startPhase1 = async () => {
    setPhase("phase1");
    setProgress(0);
    setMotionStatus("move");

    const done = await runTiltSequence("phase1", raw => {
      runMlDenomination(raw);
      const f = analyzePhase1Frame(raw, p1.current.denomination);
      p1.current.oviChromas.push(f.oviChroma);
      p1.current.oviRatios.push(f.oviRatio);
      p1.current.oviHues.push(f.oviHue);
      p1.current.framePatches.push(f.framePatch);
      p1.current.inkHues.push(f.inkHue);
      p1.current.inkSpreads.push(f.inkSpread);
    });
    if (!done) return;
    finalizePhase1();
    await finalizeScan();
  };

  const finalizePhase1 = () => {
    const { oviChromas, oviRatios, oviHues, framePatches } = p1.current;
    // Captures that don't look like different angles mean the phone wasn't
    // really tilted — NOT READ, never a fail against the note.
    const tilt = checkTiltMoved(framePatches);
    const read = oviRatios.length >= 2 && tilt.moved;
    // Swing relative to the median ratio, so the measure is unitless and
    // doesn't depend on how coloured the reference print happens to be.
    const relSwing = read ? range(oviRatios) / Math.max(median(oviRatios), 1e-3) : 0;
    // Verdict = rainbow spread (see TH_INK_SPREAD); the strength swing is
    // still logged for comparison.
    const { inkHues, inkSpreads } = p1.current;
    const spreadMax = inkSpreads.length ? Math.max(...inkSpreads) : 0;
    const rollingColour = read ? spreadMax < TH_INK_SPREAD : null;
    p1.current.rollingColour = rollingColour;
    console.log(
      `[P1 Final] frames=${oviRatios.length} tiltMoved=${tilt.moved}(${tilt.dist.toFixed(3)}) ` +
      `oviRatios=[${fmt(oviRatios)}] relSwing=${relSwing.toFixed(3)} (old th ${TH_OVI_RATIO_SWING}, logged only) ` +
      `vivid=[${fmt(oviChromas)}] hueSwing=${range(oviHues).toFixed(1)}°`,
    );
    console.log(
      `[Rainbow] inkHueTurn=${hueRange(inkHues).toFixed(1)}° inkHues=[${inkHues.map(h => h.toFixed(1)).join(" ")}] ` +
      `spreadMax=${spreadMax.toFixed(3)} (th ${TH_INK_SPREAD}) spreads=[${fmt(inkSpreads)}] → rolling fail=${rollingColour}`,
    );
    updateCheck("Rolling Colour", statusOf(rollingColour));
  };

  // ─── Verdict ─────────────────────────────────────────────────────────────
  const finalizeScan = async () => {
    const { rollingColour, serialNumber } = p1.current;

    // Rolling Colour (rainbow spread) alone decides — see TH_INK_SPREAD.
    // Denomination is from OCR only: it sizes every crop zone.
    const identified = !!p1.current.denomination;
    const complete = rollingColour !== null;
    const verdict: "PASS" | "REVIEW" = (identified && complete && !rollingColour) ? "PASS" : "REVIEW";
    // Why, for the result screen — a REVIEW because the scan couldn't finish
    // must not read like a counterfeit warning.
    const reason: "ok" | "no_value" | "no_tilt" | "no_colour" =
      !identified ? "no_value" : !complete ? "no_tilt" : rollingColour ? "no_colour" : "ok";

    const mark = (fail: boolean | null) => fail === null ? "NOT READ" : fail ? "SUSPICIOUS" : "OK";
    console.log(
      `\n══════ SCAN RESULT ══════\n` +
      `  Note            : $${p1.current.denomination ?? "?"}  ${serialNumber || "(no serial)"}\n` +
      `  1 Serial Number : ${mark(!serialNumber)}\n` +
      `  2 Rolling Colour: ${mark(rollingColour)}\n` +
      `  ─────────────────────\n` +
      `  Risk score      : ${rollingColour ? "1.00" : "0.00"} / 1.00  (REVIEW if Rolling Colour fails)\n` +
      `  Identified      : ${identified ? "yes" : "NO — OCR read no denomination, cannot PASS"}\n` +
      `  Front tilt read : ${complete ? "yes" : "NO — front tilt skipped or too small, cannot PASS"}\n` +
      `  ML denom conf   : ${p1.current.mlScore.toFixed(3)}  (identification only)\n` +
      `  VERDICT         : ${verdict}  (${reason})\n` +
      `═════════════════════════\n`,
    );
    triggerHaptic(verdict);

    await addScan({
      id: Date.now().toString(),
      denomination: p1.current.denomination ?? 0,
      verdict,
      timestamp: new Date().toISOString(),
      serialNumber: p1.current.serialNumber,
    });

    setPhase("done");
    // replace, not navigate: the finished scan screen must leave the stack.
    // With navigate it stayed mounted underneath, and "Scan again" started a
    // second one — the old copy kept firing camera calls at a camera that was
    // no longer active ("Failed to capture image" on every tick).
    navigation.replace("Verdict", {
      status: verdict,
      serialNumber: p1.current.serialNumber,
      denomination: p1.current.denomination ?? undefined,
      confidence: p1.current.mlScore,
      pixelChecks: { rollingColour },
      reason,
    });
  };

  // ─── Shared pieces ───────────────────────────────────────────────────────
  // The only status text on the bird/tilt screens. Names the side the app is
  // actually waiting for — "Follow the line…" never said which way, and
  // testers tilted the wrong way until the wait timed out.
  const MotionStatusLine = ({ status, accent }: { status: "move" | "captured"; accent: string }) => {
    const prompt =
      status === "captured" ? "✓ Captured" :
      tiltLate ? "Tilt further — roll the phone sideways" :
      tiltTarget === -1 ? "← Tilt LEFT" :
      tiltTarget === 1 ? "Tilt RIGHT →" :
      "Tilt left or right";
    return (
      <Text style={[styles.sheetSub, styles.tiltPrompt, { color: status === "captured" ? "#4ADE80" : tiltLate ? "#FBBF24" : accent }]}>
        {prompt}
      </Text>
    );
  };

  // Double-headed arrow that sweeps left and right on a continuous loop
  // (sweepAnim), showing the rocking motion rather than just naming it. Dims
  // once a capture lands so it doesn't compete with the "✓ CAPTURED" status
  // text.
  const SweepHint = () => (
    <View style={styles.sweepWrap} pointerEvents="none">
      <Animated.View style={{
        opacity: motionStatus === "captured" ? 0.15 : 0.55,
        transform: [{ translateX: sweepAnim.interpolate({ inputRange: [0, 1], outputRange: [-30, 30] }) }],
      }}>
        <Text style={[styles.sweepArrowText, { color: accent }]}>↔</Text>
      </Animated.View>
    </View>
  );

  // The literal thing asked for: a horizontal line with a dot that sweeps
  // left then right, driven by tiltAnim — the SAME value the capture timing
  // is scheduled against, so this isn't decoration running independently of
  // what the camera does. Tilt the PHONE to keep the dot roughly centred — the note stays put.
  // Target marks sit exactly at the capture threshold (tiltAnim = ±1), the
  // one being waited for is lit, and the dot turns green on reaching it.
  const GuideTrack = () => {
    const dotX = tiltAnim.interpolate({ inputRange: [-1, 1], outputRange: [-80, 80], extrapolate: "clamp" });
    const atTarget = tiltAnim.interpolate({ inputRange: [-1, -0.99, 0.99, 1], outputRange: [1, 0, 0, 1], extrapolate: "clamp" });
    const markColor = (side: -1 | 1) =>
      tiltTarget === side || tiltTarget === 0 ? accent : "rgba(255,255,255,0.2)";
    return (
      <View style={styles.guideTrack}>
        <View style={styles.guideLine} />
        <View style={[styles.guideMark, { transform: [{ translateX: -80 }], backgroundColor: markColor(-1) }]} />
        <View style={[styles.guideMark, { transform: [{ translateX: 80 }], backgroundColor: markColor(1) }]} />
        <Animated.View style={[styles.guideDot, { backgroundColor: accent, transform: [{ translateX: dotX }] }]} />
        <Animated.View style={[styles.guideDot, { backgroundColor: "#4ADE80", opacity: atTarget, transform: [{ translateX: dotX }] }]} />
      </View>
    );
  };

  const StepDots = ({ active }: { active: number }) => (
    <View style={styles.dots}>
      {[0, 1].map(i => (
        <View
          key={i}
          style={[
            styles.dot,
            i < active && { backgroundColor: "#4ADE80" },
            i === active && { backgroundColor: accent, width: 20 },
          ]}
        />
      ))}
    </View>
  );

  const TopBar = ({ step, onClose }: { step: number; onClose: () => void }) => (
    <View style={styles.topBar}>
      <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={8}>
        <X size={18} color="#fff" />
      </TouchableOpacity>
      <View style={styles.topCenter}>
        <Text style={styles.stepCount}>STEP {step + 1} OF 2</Text>
        <StepDots active={step} />
      </View>
      {denom ? (
        <View style={[styles.denomChip, { borderColor: accent }]}>
          <Text style={[styles.denomChipText, { color: accent }]}>${denom}</Text>
        </View>
      ) : (
        <View style={styles.denomChipEmpty} />
      )}
    </View>
  );

  const NoteFrame = ({ children }: { children?: React.ReactNode }) => (
    <View style={styles.frameWrap} pointerEvents="none">
      <View style={[styles.frame, { height: frameHeightFor(denom) }]}>
        <View style={[styles.fCorner, styles.fTL, { borderColor: accent }]} />
        <View style={[styles.fCorner, styles.fTR, { borderColor: accent }]} />
        <View style={[styles.fCorner, styles.fBL, { borderColor: accent }]} />
        <View style={[styles.fCorner, styles.fBR, { borderColor: accent }]} />
        {children}
      </View>
    </View>
  );

  const Zone = ({ style, label }: { style: any; label: string }) => (
    <View style={[styles.zone, style, { borderColor: accent }]}>
      <Text style={[styles.zoneLabel, { color: accent }]}>{label}</Text>
    </View>
  );

  const ProgressBar = () => (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${progress * 100}%` as any, backgroundColor: accent }]} />
    </View>
  );

  const CheckList = ({ items }: { items: CheckItem[] }) => (
    <View style={styles.checkList}>
      {items.map(c => {
        const color = c.status === "pass" ? "#4ADE80" : c.status === "fail" ? "#FB7185" : c.status === "unread" ? "#FBBF24" : "rgba(255,255,255,0.25)";
        return (
          <View key={c.label} style={styles.checkRow}>
            <View style={[styles.checkDot, { borderColor: color, backgroundColor: c.status === "pass" ? color : "transparent" }]}>
              {c.status === "fail" && <Text style={styles.checkX}>✕</Text>}
            </View>
            <Text style={[styles.checkLabel, c.status === "pending" && { color: "rgba(255,255,255,0.4)" }]}>
              {c.label}
            </Text>
            {c.status === "pending"
              ? <ActivityIndicator size="small" color="rgba(255,255,255,0.25)" />
              : <Text style={[styles.checkBadge, { color }]}>{c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "NOT READ"}</Text>}
          </View>
        );
      })}
    </View>
  );

  // ─── PERMISSION ──────────────────────────────────────────────────────────
  if (!permission) return <View style={styles.root} />;
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center, { padding: 32 }]}>
        <Text style={styles.permTitle}>Camera Access Required</Text>
        <Text style={styles.permSub}>AUDScan needs the camera to scan banknotes.</Text>
        <TouchableOpacity style={[styles.btn, { backgroundColor: accent }]} onPress={requestPermission}>
          <Text style={styles.btnText}>ALLOW CAMERA</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginTop: 16 }}>
          <Text style={styles.linkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── SETUP: how to hold the note, shown once before every scan ─────────────
  // Three rules, chosen because they are the three things that varied most
  // between repeat scans of the same note in testing: how far the note sits
  // from the camera, how flat it's held, and how fast it's tilted. Nothing
  // downstream can correct for these after the photo is taken.
  if (phase === "setup") {
    return (
      <View style={styles.root}>
        <View style={styles.sheetOverlay}>
          <Text style={styles.bigTitle}>HOW TO SCAN</Text>
          <Text style={styles.bigSub}>Three things keep every scan consistent</Text>

          <View style={styles.setupList}>
            <View style={styles.setupRow}>
              <View style={[styles.setupIcon, { borderColor: accent }]}>
                <Text style={[styles.setupIconText, { color: accent }]}>1</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.setupHead}>Put the note down flat</Text>
                <Text style={styles.setupBody}>On a table, under good light. It stays still for the whole scan — you don't touch it again once it's positioned.</Text>
              </View>
            </View>
            <View style={styles.setupRow}>
              <View style={[styles.setupIcon, { borderColor: accent }]}>
                <Text style={[styles.setupIconText, { color: accent }]}>2</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.setupHead}>Hold the phone above it</Text>
                <Text style={styles.setupBody}>Fill the frame guide with the note — not closer, not further. About one hand's length above it.</Text>
              </View>
            </View>
            <View style={styles.setupRow}>
              <View style={[styles.setupIcon, { borderColor: accent }]}>
                <Text style={[styles.setupIconText, { color: accent }]}>3</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.setupHead}>Tilt the phone, not the note</Text>
                <Text style={styles.setupBody}>The scale on screen tracks your phone's real tilt. Roll it left, then right, keeping the note in the frame guide — capture happens on its own once you reach each side.</Text>
              </View>
            </View>
          </View>

          <TouchableOpacity style={[styles.btn, styles.btnWide, { backgroundColor: accent }]} onPress={beginScan}>
            <Text style={styles.btnText}>START SCANNING</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginTop: 14 }}>
            <Text style={styles.linkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─── STEP 1: SERIAL ──────────────────────────────────────────────────────
  if (phase === "serial" || phase === "loading") {
    const found = ocrStatus === "found";
    return (
      <View style={styles.root}>
        <ExposureCamera ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" onCameraReady={onCameraReady} />
        <View style={styles.scrim} pointerEvents="none" />

        <TopBar step={0} onClose={() => { stopInterval(); navigation.goBack(); }} />

        <NoteFrame>
          <Zone style={styles.zoneSerial} label="SERIAL NUMBER" />
        </NoteFrame>

        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>Serial Number</Text>
              <Text style={styles.sheetSub}>
                {denom ? `$${denom} note detected`
                  : found ? "Reading the note's value — keep the whole note in the frame"
                  : "Hold the front of the note steady"}
              </Text>
            </View>
          </View>

          <View style={[styles.readout, found && { borderColor: "#4ADE80", backgroundColor: "rgba(74,222,128,0.08)" }]}>
            {phase === "loading" ? (
              <View style={styles.readoutRow}>
                <ActivityIndicator size="small" color={accent} />
                <Text style={styles.readoutPending}>Loading scanner…</Text>
              </View>
            ) : found ? (
              <>
                <Text style={styles.readoutOk}>✓  DETECTED</Text>
                <Text style={styles.readoutValue}>{serial}</Text>
              </>
            ) : (
              <View style={styles.readoutRow}>
                <ActivityIndicator size="small" color={accent} />
                <Text style={styles.readoutPending}>Looking for serial number…</Text>
              </View>
            )}
          </View>

          <TouchableOpacity
            style={[styles.btn, found ? { backgroundColor: accent } : styles.btnGhost]}
            onPress={confirmSerial}
          >
            <Text style={[styles.btnText, !found && styles.btnGhostText]}>
              {found ? (denom ? "CONTINUING…" : "READING VALUE…") : "SKIP & CONTINUE"}
            </Text>
          </TouchableOpacity>

          {ocrStatus === "notfound" && (
            <Text style={styles.tip}>Move closer and make sure the number is well lit</Text>
          )}
        </View>
      </View>
    );
  }

  // ─── STEP 2: ROLLING COLOUR TILT ─────────────────────────────────────────
  const leftCaptured = progress >= 1 / TARGET_FRAMES;
  const rightCaptured = progress >= 1;
  return (
    <View style={styles.root}>
      <ExposureCamera ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" exposure={COLOUR_EXPOSURE_EV} onCameraReady={onCameraReady} />
      <View style={styles.scrim} pointerEvents="none" />
      <Animated.View pointerEvents="none" style={[styles.captureFlash, { opacity: captureFlashAnim }]} />

      <TopBar step={1} onClose={() => { stopInterval(); navigation.goBack(); }} />

      <NoteFrame>
        <Zone
          style={styles.zoneOviBand}
          label="ROLLING COLOUR"
        />
        <SweepHint />
      </NoteFrame>

      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sheetTitle}>Front Side (Rolling Colour)</Text>
            <MotionStatusLine status={motionStatus} accent={accent} />
          </View>
          {serial ? (
            <View style={styles.serialTag}>
              <Text style={styles.serialTagLabel}>SERIAL</Text>
              <Text style={styles.serialTagValue}>{serial}</Text>
            </View>
          ) : null}
        </View>

        <ProgressBar />
        <GuideTrack />
        <Text style={styles.tip}>
          Lay the note flat in the frame — tilt the phone left, back to flat, then right
        </Text>
        <Text style={styles.tip}>{Math.round(progress * TARGET_FRAMES)}/{TARGET_FRAMES} captured</Text>

        <CheckList items={[checks[1]]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.25)" },

  // ── Top bar ──
  topBar: {
    position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
    flexDirection: "row", alignItems: "center",
    paddingTop: 58, paddingHorizontal: 16, paddingBottom: 16,
  },
  closeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.14)",
    alignItems: "center", justifyContent: "center",
  },
  topCenter: { flex: 1, alignItems: "center", gap: 7 },
  stepCount: { color: "rgba(255,255,255,0.75)", fontSize: 10, fontWeight: "800", letterSpacing: 2 },
  dots: { flexDirection: "row", gap: 5, alignItems: "center" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.22)" },
  denomChip: {
    minWidth: 52, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 10, borderWidth: 1.5,
    backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center",
  },
  denomChipText: { fontSize: 16, fontWeight: "900" },
  denomChipEmpty: { width: 52 },

  // ── Note frame ──
  frameWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", paddingBottom: 120 },
  frame: { width: FRAME_W, alignItems: "center", justifyContent: "center" },
  fCorner: { position: "absolute", width: 30, height: 30, borderWidth: 3, borderRadius: 2 },
  fTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0 },
  fTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0 },
  fBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0 },
  fBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0 },

  // ── Zone highlights inside the frame ──
  zone: {
    position: "absolute", borderWidth: 1.5, borderRadius: 6,
    borderStyle: "dashed", backgroundColor: "rgba(255,255,255,0.07)",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 4,
  },
  zoneLabel: { fontSize: 9, fontWeight: "900", letterSpacing: 1, textAlign: "center", lineHeight: 12 },
  zoneSerial: { top: "3%", left: "6%", right: "6%", height: "8%" },
  zoneOviBand: { top: "36%", left: "5%", right: "5%", height: "34%" },

  // ── Sweep hint (inside the note frame) ──
  sweepWrap:      { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  sweepArrowText: { fontSize: 40, fontWeight: "300" },

  // ── Full-screen capture flash ──
  captureFlash: { ...StyleSheet.absoluteFillObject, backgroundColor: "#fff", zIndex: 20 },

  // ── Live status text (stacked, cross-faded layers) ──
  statusStack: { height: 20, justifyContent: "center" },
  statusLayer: { position: "absolute", left: 0, top: 0 },

  // ── Guide track ──
  guideTrack: { height: 24, justifyContent: "center", marginTop: 2, marginBottom: 4 },
  guideLine:  { height: 2, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 1 },
  guideDot:   { position: "absolute", left: "50%", marginLeft: -7, width: 14, height: 14, borderRadius: 7 },
  guideMark:  { position: "absolute", left: "50%", marginLeft: -1.5, width: 3, height: 20, borderRadius: 1.5 },
  tiltPrompt: { fontSize: 18, fontWeight: "800", lineHeight: 24 },

  // ── Bird badge ──
  birdBadge: {
    width: 84, height: 84, borderRadius: 42, borderWidth: 2,
    alignItems: "center", justifyContent: "center",
  },

  // ── Bottom sheet ──
  sheet: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: "rgba(10,13,18,0.96)",
    borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 22, paddingTop: 22, paddingBottom: 40,
    gap: 16,
  },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sheetTitle: { color: "#fff", fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  sheetSub: { color: "rgba(255,255,255,0.5)", fontSize: 13, marginTop: 3, lineHeight: 18 },

  serialTag: { alignItems: "flex-end" },
  serialTagLabel: { color: "rgba(255,255,255,0.4)", fontSize: 8, fontWeight: "800", letterSpacing: 1.5 },
  serialTagValue: { color: "#fff", fontSize: 12, fontWeight: "700", fontFamily: "monospace", marginTop: 2 },

  progressTrack: { height: 3, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: 3, borderRadius: 2 },

  // ── Checks ──
  checkList: { gap: 12 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  checkDot: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2,
    alignItems: "center", justifyContent: "center",
  },
  checkX: { color: "#fff", fontSize: 9, fontWeight: "900" },
  checkLabel: { flex: 1, color: "#fff", fontSize: 14, fontWeight: "500" },
  checkBadge: { fontSize: 10, fontWeight: "900", letterSpacing: 1 },

  // ── Serial readout ──
  readout: {
    backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 16,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.1)",
  },
  readoutRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  readoutPending: { color: "rgba(255,255,255,0.45)", fontSize: 14 },
  readoutOk: { color: "#4ADE80", fontSize: 9, fontWeight: "900", letterSpacing: 2, marginBottom: 7 },
  readoutValue: { color: "#fff", fontSize: 24, fontWeight: "700", fontFamily: "monospace", letterSpacing: 2 },

  torchChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9, borderWidth: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  torchText: { fontSize: 9, fontWeight: "900", letterSpacing: 1 },

  tip: { color: "rgba(255,255,255,0.35)", fontSize: 12, textAlign: "center", lineHeight: 17 },

  // ── Buttons ──
  btn: { paddingVertical: 17, borderRadius: 14, alignItems: "center" },
  btnWide: { width: "100%" },
  btnGhost: { backgroundColor: "rgba(255,255,255,0.07)", borderWidth: 1, borderColor: "rgba(255,255,255,0.14)" },
  btnText: { color: "#000", fontWeight: "900", fontSize: 14, letterSpacing: 1 },
  btnGhostText: { color: "rgba(255,255,255,0.6)" },
  linkText: { color: "rgba(255,255,255,0.45)", fontSize: 14, textAlign: "center" },

  // ── Flip / full-screen prompt ──
  sheetOverlay: {
    flex: 1, backgroundColor: "rgba(10,13,18,0.94)",
    alignItems: "center", justifyContent: "center", padding: 32,
  },
  bigIcon: {
    width: 88, height: 88, borderRadius: 44, borderWidth: 2,
    alignItems: "center", justifyContent: "center", marginBottom: 22,
  },
  bigIconText: { fontSize: 38, color: "#fff" },
  bigTitle: { color: "#fff", fontSize: 26, fontWeight: "900", letterSpacing: 2, textAlign: "center" },
  bigSub: { color: "rgba(255,255,255,0.55)", fontSize: 14, textAlign: "center", lineHeight: 21, marginTop: 10 },
  timeline: { width: "100%", gap: 9, marginTop: 30, marginBottom: 30 },
  tlDone: { color: "#4ADE80", fontSize: 14 },
  tlNext: { fontSize: 14, fontWeight: "700" },

  // ── Permission ──
  permTitle: { color: "#fff", fontSize: 21, fontWeight: "800", textAlign: "center", marginBottom: 10 },
  permSub: { color: "rgba(255,255,255,0.5)", fontSize: 14, textAlign: "center", lineHeight: 21, marginBottom: 28 },

  // ── Setup screen ──
  setupList: { width: "100%", gap: 22, marginTop: 30, marginBottom: 34 },
  setupRow: { flexDirection: "row", alignItems: "flex-start", gap: 14 },
  setupIcon: {
    width: 30, height: 30, borderRadius: 15, borderWidth: 1.5,
    alignItems: "center", justifyContent: "center", marginTop: 2,
  },
  setupIconText: { fontSize: 13, fontWeight: "900" },
  setupHead: { color: "#fff", fontSize: 15, fontWeight: "700", marginBottom: 3 },
  setupBody: { color: "rgba(255,255,255,0.55)", fontSize: 13, lineHeight: 19 },
});

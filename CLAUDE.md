# CLAUDE.md

Read `SPEC.md` first. It contains locked decisions — do not re-derive or second-guess them.

## Hard guardrails (do not violate)
- **No ambisonics in the browser.** No Omnitone, no HOA decoder, no soundfield rotation in
  JS. The audio is pre-rendered stereo binaural stems. If you find yourself reaching for a
  decoder, stop — that work happened offline. See SPEC.
- **No framework.** Vite vanilla-JS template. One canvas, one AudioContext, 8 buffers.
  React/Next adds a build layer between us and Web Audio timing for zero benefit.
- **No `localStorage`/`sessionStorage`.** Not needed; keep all state in JS variables.
- **8 stems are one unit.** Always start them together; always correct their timing together.

## Stack
- Vite (`npm create vite@latest`, vanilla template). Dev server required — AudioContext
  needs a secure context, `file://` won't work.
- Three.js for the videosphere (inverted sphere, camera at origin, VideoTexture).
- Web Audio API directly for the 8 stems + gains + master gain. No audio library.

## Build order — test each stage before moving on
The sync bugs and the spatial bugs are separable. Do NOT tangle them. Build and verify
audio-alone before video exists.

### Stage 1 — 8-stem crossfade, NO video
- Load `head_000.wav … head_315.wav`, `decodeAudioData` all 8 to buffers.
- Start all 8 with one shared `start(when)` → sample-locked cluster. Each → its own
  GainNode → master GainNode → destination.
- Yaw source for now = **keyboard arrows** (left/right). Print yaw to screen.
- Equal-power crossfade between the two bracketing headings (see SPEC for the gain math);
  other six gains at 0.
- **Verify on headphones:** (a) turning right swings talkers the correct way — if mirrored,
  note it for the video MIRROR flag; (b) crossfade is acceptably smooth (some comb on dry
  direct sound at mid-blend is expected). This stage is the whole acoustic core. Nail it.

### Stage 2 — 360 video layer, registered
- Three.js inverted-sphere equirect video, camera at origin.
- Pointer-drag yaw REPLACES the arrow keys as the yaw source (keep arrows as a fallback).
- Register front: video 0 deg → 0 deg speaker heading. Add `MIRROR_YAW` flag; set it from
  what you observed in Stage 1.
- Verify picture and sound turn together, same direction, front-aligned.

### Stage 3 — single-clock sync (video is master)
- Bake in `CAPTURE_OFFSET` constant (video t=0 vs audio t=0). Target = `video.currentTime + OFFSET`.
- Micro-nudge `playbackRate` (±0.3%) on all 8 for steady drift.
- Hard re-cue all 8 (master-gain dip → stop → restart at offset → gain ramp) on `seeked`,
  `waiting`/`playing`, `visibilitychange`.
- Verify: scrub the video, background the tab, let it run several minutes — audio stays locked.

## Config block (surface these at top of the entry file)
`STEM_DIR`, `HEADINGS = [0,45,90,135,180,225,270,315]`, `VIDEO_SRC`, `CAPTURE_OFFSET`,
`MIRROR_YAW`, `DRAG_SENSITIVITY`, `FOV`, `RESYNC_THRESHOLD`.

## Reference material
There is a prior single-file HTML prototype (the ambisonic version). Use it ONLY as a
reference for: the Three.js inverted-sphere + VideoTexture setup, the yaw-drag math, and
the buffer-vs-video sync pattern (playbackRate nudge + re-cue). Those port directly.
The Omnitone/ambisonic decode in it does NOT port — there is no decoder here. Do not copy
it as the base; build fresh from this spec.

## Footer (required)
"Acoustic backgrounds derived from the ARTE database (Weisser et al., 2019), CC-BY 4.0."

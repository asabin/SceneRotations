# SPEC — 360 Video + Head-Tracked Binaural Player (8 headings)

## What this is
A web player where a 360 video and a head-tracked binaural soundtrack turn together
as the user rotates their view (yaw only). Body stable, horizontal rotation only.
Target: **headphones on desktop.** This is a controlled demo, not a mobile product.

## The audio is PRE-RENDERED BINAURAL. There is NO ambisonic decoding in the browser.
This is the single most important thing to get right. Do **not** add Omnitone, an
ambisonic/HOA decoder, or any soundfield rotation in JS. The soundfield work already
happened offline in the lab. The browser only ever plays back stereo binaural stems and
crossfades between them.

Pipeline that produced the stems (context, not something to rebuild):
- Lab is a regular octagonal ring of 8 speakers at 0/±45/±90/±135/180 deg, radius 1 m,
  Yamaha HS5, flat-EQ'd, KEMAR at center. Direct sound dominates (RT60 0.072 s,
  critical distance 1.3 m > 1 m radius).
- Scenes were authored to the 8 ring feeds (ARTE backgrounds decoded to the ring +
  studio talkers placed at 0/±45 + matched IRs).
- **Rotation was captured by cyclic-shifting the channel→speaker mapping.** On a regular
  octagonal ring this is an *acoustically exact* 45 deg rotation of the whole field — not
  an approximation — because every speaker is interchangeable.
- For each 45 deg heading, the shifted feeds were played and KEMAR was recorded
  **through the hearing aids**, then diffuse-field equalized.
- Result: 8 stereo binaural stems per scene, one per heading. Each carries the real
  device processing. All 8 are the same reproducible acoustic event, so they are
  **inherently sample-aligned** to each other.

## Consequences of the above (why the web layer is simple)
- **Inter-stem sync is free.** Start all 8 buffers with one identical `start(when)` in one
  AudioContext → they are locked to the same hardware clock and cannot drift from each
  other, ever. Treat the 8 as a single unit; when you correct timing, correct all 8.
- **45 deg headings land exactly on the talker positions (0/±45)**, so the perceptually
  loaded directions are captured precisely; quantization only shows in the gaps.
- **Rotation is world-anchored**: turning the head swings the talkers around the listener.
  That is correct head-tracked behavior, not a bug.

## Stem naming + convention (LOCKED)
- Files: `head_000.wav head_045.wav head_090.wav head_135.wav head_180.wav head_225.wav head_270.wav head_315.wav`
- Each is **stereo** (L/R binaural), diffuse-field EQ'd, ready for headphones.
- `head_045` = the field captured with the ring shifted for a **45 deg listener head-turn**
  (heading = LISTENER YAW, not source azimuth). Index the crossfade off listener yaw.

## Crossfade
- At any yaw, pick the two bracketing headings (yaw is in [0,360), stems every 45 deg).
- Equal-power crossfade on the angular fraction between them:
  `d = angular distance to a heading in deg (0..45); gain = cos((d/45) * PI/2)`;
  the two bracketing stems get the two gains, the other six are at 0.
- Known artifact: crossfading two binaurals with different ITDs combs the **dry direct
  sound** mid-blend (diffuse/reverberant part is fine). Acceptable for v1. If it bothers,
  the fix is more headings (16/24) captured the same way, NOT fancier JS interpolation.

## Video
- 360 equirectangular, sourced SEPARATELY (the audio pipeline produces no video).
- Three.js: inverted sphere (`geometry.scale(-1,1,1)`), camera at origin, video texture.
- **Spatial registration:** video front (0 deg) must align to the 0 deg speaker heading,
  and video yaw must increase in the SAME direction as the stem index. One `MIRROR_YAW`
  flag to fix handedness if turning right makes sound go left.

## Sync (video is master)
- Video runs on its own media clock; the audio cluster runs on `ctx.currentTime`.
  Different crystals → they drift. Video owns the timeline; pull audio to it.
- **Capture offset:** video t=0 and audio t=0 are not the same instant. Measure the fixed
  delta once (sync marker) and bake it in as a constant. Target = `video.currentTime + OFFSET`.
- **Micro-nudge** (steady drift): bend `playbackRate` on all 8 sources by the same tiny
  amount (±0.3%, ~5 cents, inaudible) toward the target. Glitch-free.
- **Hard re-cue** (seeks / big stalls): dip a master gain to 0, `stop()` all 8, restart all
  8 at the new offset, ramp gain back. Wire to `seeked`, `waiting`/`playing`,
  `visibilitychange` (backgrounded tabs throttle rAF and separate the clocks).

## Autoplay
- One user gesture (Start button) to `ctx.resume()` + start playback + `decodeAudioData`.

## Attribution (LOCKED)
- Backgrounds derive from the ARTE database (Weisser et al. 2019), **CC-BY 4.0**.
  Credit in the page footer: "Acoustic backgrounds derived from the ARTE database
  (Weisser et al., 2019), CC-BY 4.0."

## Out of scope for v1
Pitch/roll (yaw only). Mobile. VR/WebXR. Ambisonic decode. >8 headings.

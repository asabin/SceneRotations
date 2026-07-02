#!/usr/bin/env python3
"""Apply Diffuse-Field EQ (DFE) to the scene-rotation binaural stems.

Replicates the HearAdvisor pipeline step (headAdvisorPy utils/dfe.py, MATLAB
apply_dfe_all_wavs.m):

    load('DFEnewPinNewSim1120.mat')   -> Bl, Br filter coefficients
    fftfilt([Bl' Br'], audio)         -> per-channel convolution (L->Bl, R->Br)

Gain differs from the pipeline's fixed +20 dB: all 8 stems of a scene get one
common scale factor that puts the scene's peak at TARGET_PEAK_DBFS, so the
web-served files cannot clip and inter-stem level relationships are preserved.

Output: <scene dir>/DFE/<same filename>.wav (24-bit PCM, original rate).
"""

import os
import sys

import numpy as np
import scipy.io as sio
import soundfile as sf
from scipy.signal import fftconvolve

DFE_MAT = "/Users/andrewsabin/Dropbox/ReferenceConditions/DFEnewPinNewSim1120.mat"

SCENE_DIRS = [
    "/Users/andrewsabin/Dropbox/SceneRotations/FoodCourt 1",
    "/Users/andrewsabin/Dropbox/SceneRotations/Living Room",
]

# Peak target per scene. -4 dBFS leaves headroom for the worst-case +3 dB sum
# of two correlated stems mid-crossfade in the player.
TARGET_PEAK_DBFS = -4.0

# Drop the head of every stem (same sample count on all 8 keeps them aligned).
TRIM_START_SEC = 15.0


def load_dfe_filters(mat_path):
    mat = sio.loadmat(mat_path, squeeze_me=True)
    bl = np.asarray(mat["Bl"], dtype=np.float64).ravel()
    br = np.asarray(mat["Br"], dtype=np.float64).ravel()
    return bl, br


def apply_dfe(audio, bl, br):
    """audio: (samples, 2) float64. Returns filtered audio, same shape."""
    n = audio.shape[0]
    left = fftconvolve(audio[:, 0], bl, mode="full")[:n]
    right = fftconvolve(audio[:, 1], br, mode="full")[:n]
    return np.column_stack([left, right])


def process_scene(scene_dir, bl, br):
    wavs = sorted(
        f for f in os.listdir(scene_dir)
        if f.lower().endswith(".wav") and not f.startswith(".")
    )
    if not wavs:
        print(f"  no wavs in {scene_dir}")
        return

    out_dir = os.path.join(scene_dir, "DFE")
    os.makedirs(out_dir, exist_ok=True)

    filtered = {}
    rates = {}
    peak = 0.0
    for name in wavs:
        audio, sr = sf.read(os.path.join(scene_dir, name), dtype="float64", always_2d=True)
        audio = audio[int(round(TRIM_START_SEC * sr)):]
        y = apply_dfe(audio, bl, br)
        filtered[name] = y
        rates[name] = sr
        peak = max(peak, np.max(np.abs(y)))

    # One common scale for the whole scene keeps all 8 stems' relative levels.
    scale = (10.0 ** (TARGET_PEAK_DBFS / 20.0)) / peak
    print(f"  post-DFE peak {20*np.log10(peak):+.1f} dBFS -> scaling by "
          f"{20*np.log10(scale):+.1f} dB to hit {TARGET_PEAK_DBFS} dBFS")

    for name in wavs:
        out_path = os.path.join(out_dir, name)
        sf.write(out_path, filtered[name] * scale, rates[name], subtype="PCM_24")
        print(f"  {name} -> DFE/{name}")


def main():
    if not os.path.isfile(DFE_MAT):
        sys.exit(f"DFE filter file not found: {DFE_MAT}")
    bl, br = load_dfe_filters(DFE_MAT)
    print(f"Loaded DFE filters: Bl {bl.shape[0]} taps, Br {br.shape[0]} taps")
    for d in SCENE_DIRS:
        print(f"\nScene: {d}")
        process_scene(d, bl, br)


if __name__ == "__main__":
    main()

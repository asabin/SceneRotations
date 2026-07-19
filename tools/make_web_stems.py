#!/usr/bin/env python3
"""Encode the DFE'd scene stems to 16-bit FLAC for the web player.

The 24-bit WAVs in <scene>/DFE/ are ~124 MB for both scenes, which made the
player's stem load painfully slow. Babble-heavy room recordings barely compress
losslessly at 24-bit (~73% of WAV), but at 16-bit FLAC lands around 38% — and
with scene peaks normalized to -4 dBFS (apply_dfe.py), 16-bit quantization
noise (~-92 dBFS after dither) sits far below the recordings' own acoustic
noise floor.

Conversion: TPDF dither at 1 LSB (16-bit), quantize, FLAC. Everything above
the last bit is untouched — no resampling, no lossy codec.

Output: player/public/stems/<scene>/<same basename>.flac. Replaces the old
symlinks that pointed the web dirs straight at the DFE WAVs.
"""

import glob
import os

import numpy as np
import soundfile as sf

ROOT = "/Users/andrewsabin/Dropbox/SceneRotations"

SCENES = {
    f"{ROOT}/FoodCourt 1/DFE": f"{ROOT}/player/public/stems/foodcourt",
    f"{ROOT}/Living Room/DFE": f"{ROOT}/player/public/stems/livingroom",
}

# Fixed seed so re-runs produce byte-identical files.
rng = np.random.default_rng(20260718)


def to_int16_tpdf(x):
    """Float [-1,1] -> int16 with triangular (TPDF) dither at 1 LSB."""
    tri = rng.random(x.shape) + rng.random(x.shape) - 1.0  # [-1,1] LSB
    return np.clip(np.round(x * 32768.0 + tri), -32768, 32767).astype(np.int16)


def main():
    for src_dir, dst_dir in SCENES.items():
        if os.path.islink(dst_dir):
            os.unlink(dst_dir)
        os.makedirs(dst_dir, exist_ok=True)

        wavs = sorted(glob.glob(os.path.join(src_dir, "*.wav")))
        assert len(wavs) == 8, f"expected 8 stems in {src_dir}, found {len(wavs)}"

        total_in = total_out = 0
        for wav in wavs:
            x, fs = sf.read(wav, dtype="float64")
            dst = os.path.join(
                dst_dir, os.path.splitext(os.path.basename(wav))[0] + ".flac"
            )
            sf.write(dst, to_int16_tpdf(x), fs, subtype="PCM_16", format="FLAC")
            total_in += os.path.getsize(wav)
            total_out += os.path.getsize(dst)
            print(f"  {os.path.basename(dst)}  "
                  f"{os.path.getsize(wav) / 1e6:.1f} -> {os.path.getsize(dst) / 1e6:.1f} MB")

        print(f"{os.path.basename(os.path.dirname(src_dir))}: "
              f"{total_in / 1e6:.1f} -> {total_out / 1e6:.1f} MB "
              f"({total_out / total_in:.0%})\n")


if __name__ == "__main__":
    main()

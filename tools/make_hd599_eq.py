#!/usr/bin/env python3
"""Build a Sennheiser HD 599 (SE) headphone-compensation FIR for the player.

The scene stems are diffuse-field equalized, i.e. they assume playback over a
diffuse-field-flat headphone. This filter corrects the HD 599's measured
response toward the diffuse-field target so that assumption actually holds:

    correction_dB(f) = DF_target(f) - HD599_measured(f)

Sources (AutoEq project, github.com/jaakkopasanen/AutoEq):
  - measurements/oratory1990/data/over-ear/Sennheiser HD 599.csv (GRAS 43AG)
  - targets/Diffuse field GRAS KEMAR.csv

Output: player/public/eq/hd599_ir.wav — 1023-tap linear-phase FIR at 44.1 kHz,
stereo (identical channels), float32. Loaded by a ConvolverNode at runtime.

Constraints applied:
  - 1/3-octave smoothing
  - boost capped at +8 dB, cuts at -12 dB
  - boost tapered below 50 Hz (open-back bass headroom) and above 16 kHz
    (measurement reliability), cuts still allowed
  - normalized to 0 dB mean in 300-1500 Hz, then -2 dB broadband for
    crossfade-sum clip safety
"""

import csv
import os

import numpy as np
import soundfile as sf
from scipy.signal import firwin2, minimum_phase

HERE = os.path.dirname(os.path.abspath(__file__))
MEAS = "/tmp/hd599.csv"
TARGET = "/tmp/df_target.csv"
OUT = os.path.join(HERE, "..", "player", "public", "eq", "hd599_ir.wav")

FS = 44100
N_TAPS = 2047 # design length; min-phase output is (N+1)/2 taps
MAX_BOOST_DB = 8.0
MAX_CUT_DB = -12.0
SAFETY_DB = -2.0


def read_curve(path):
    f, y = [], []
    with open(path) as fh:
        for row in csv.DictReader(fh):
            f.append(float(row["frequency"]))
            y.append(float(row["raw"]))
    return np.array(f), np.array(y)


def octave_smooth(freq, db, frac=3):
    """Simple 1/frac-octave gaussian smoothing on a log-frequency axis."""
    logf = np.log2(freq)
    out = np.empty_like(db)
    sigma = 1.0 / frac / 2.0
    for i, lf in enumerate(logf):
        w = np.exp(-0.5 * ((logf - lf) / sigma) ** 2)
        out[i] = np.sum(w * db) / np.sum(w)
    return out


def main():
    f_m, meas = read_curve(MEAS)
    f_t, target = read_curve(TARGET)
    assert np.allclose(f_m, f_t), "measurement/target grids differ"
    freq = f_m

    corr = target - meas
    corr = octave_smooth(freq, corr, frac=3)

    # Taper boosts at the extremes; cuts pass through.
    lo_taper = np.clip((np.log2(freq) - np.log2(25)) / (np.log2(50) - np.log2(25)), 0, 1)
    hi_taper = np.clip(
        (np.log2(20000) - np.log2(freq)) / (np.log2(20000) - np.log2(16000)), 0, 1
    )
    boost_scale = lo_taper * hi_taper
    corr = np.where(corr > 0, corr * boost_scale, corr)
    corr = np.clip(corr, MAX_CUT_DB, MAX_BOOST_DB)

    # Reference level: mid-band mean -> 0 dB, then safety trim.
    mid = (freq >= 300) & (freq <= 1500)
    corr -= corr[mid].mean()
    corr += SAFETY_DB

    # firwin2 wants gains from DC to Nyquist inclusive.
    f_grid = np.concatenate([[0.0], freq, [FS / 2]])
    g_db = np.concatenate([[corr[0]], corr, [corr[-1]]])
    # Minimum phase: no added latency (a linear-phase FIR would delay audio
    # vs video/motion by (N-1)/2 samples = ~12 ms). scipy's homomorphic
    # minimum_phase yields sqrt of the designed magnitude, so design squared.
    gains_sq = 10 ** (g_db / 10.0)
    lin = firwin2(N_TAPS, f_grid / (FS / 2), gains_sq)
    taps = minimum_phase(lin, method="homomorphic")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sf.write(OUT, np.column_stack([taps, taps]).astype(np.float32), FS, subtype="FLOAT")

    print(f"wrote {os.path.normpath(OUT)} ({len(taps)} taps, minimum phase)")
    print(f"correction range: {corr.min():+.1f} .. {corr.max():+.1f} dB (incl. {SAFETY_DB} dB trim)")

    # Verify the realized response against the design.
    from scipy.signal import freqz
    check = [30, 60, 100, 200, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 16000]
    w, h = freqz(taps, worN=np.array(check, dtype=float), fs=FS)
    print("   freq   design  realized")
    for fq, hh in zip(check, h):
        i = np.argmin(np.abs(freq - fq))
        print(f"  {fq:>6} Hz: {corr[i]:+5.1f}  {20*np.log10(abs(hh)):+5.1f} dB")


if __name__ == "__main__":
    main()

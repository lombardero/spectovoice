// ─────────────────────────────────────────────────────────────────────────────
// SpectoVoice — live config
// Edit any value here and the browser will hot-reload instantly (no restart).
// ─────────────────────────────────────────────────────────────────────────────

// ── FFT / frequency resolution ───────────────────────────────────────────────

// Size of the FFT window. Must be a power of 2, range 32–32768.
// Higher  → more frequency bins, thinner harmonic lines — but longer window =
//           more temporal smear (onsets take longer to "appear" on screen).
// Lower   → onsets appear faster, but harmonic lines are coarser / wider.
//
// Time/frequency trade-off at 44100 Hz:
//   1024  →  23 ms window,  ~43 Hz/bin  (very crisp onsets, wide lines)
//   4096  →  93 ms window,  ~11 Hz/bin  ← sweet spot for voice
//   16384 → 372 ms window,  ~2.7 Hz/bin (thin lines, very slow onsets)
//   32768 → 743 ms window,  ~1.3 Hz/bin (thinnest lines, onset barely visible)
//
// After changing FFT_SIZE: click Pause → Play to recreate the analyser.
export const FFT_SIZE = 8192

// Temporal smoothing applied by the browser between frames (0–1).
//   0 = no averaging — raw per-frame snapshot, maximum crispness
//   >0 = blends current frame with previous; stabilises lines at cost of smear
export const SMOOTHING = 0

// ── Amplitude / dynamic range ────────────────────────────────────────────────

// dB floor — everything quieter than this is black.
// Raising this (less negative) cuts background hiss and harmonic side-lobes,
// making lines appear thinner and the background darker.
//   −95 = very sensitive, lots of noise visible
//   −75 = good balance — hiss invisible, weak harmonics still show
//   −60 = only loud content visible
export const MIN_DB = -100

// dB ceiling — signals at or above this saturate to full brightness.
// Lowering this makes the display respond to quieter sounds sooner.
export const MAX_DB = -30

// ── Frequency range displayed ────────────────────────────────────────────────

export const MIN_FREQ_HZ = 20
export const MAX_FREQ_HZ = 2_000

// Frequency axis scale exponent (power scale).
//   1.0 = linear — equal Hz per pixel, high frequencies dominate the screen
//   0.5 = square root — good balance, low frequencies get more space ← recommended
//   0.3 = closer to log — very compressed highs, expanded lows
export const FREQ_SCALE_EXP = 0.5

// ── Temporal / scrolling ─────────────────────────────────────────────────────

export const SCROLL_SPEED = 4
export const BUFFER_SECS  = 30

// ── Colour mapping pipeline ───────────────────────────────────────────────────
//
//   db          = raw float dB from FFT for this frequency bin
//   linearNorm  = clamp((db − MIN_DB) / (MAX_DB − MIN_DB), 0, 1)
//   norm0       = linearNorm ^ GAMMA          — gamma curves the response
//   norm        = norm0 * onsetMult  if norm0 > ONSET_GATE, else norm0
//                 ↑ gated onset boost: only bins already above the gate
//                   threshold are amplified, so the noise floor stays dark
//   colour      = COLOR_LUT[ round(norm × 255) ]
//                 → black → deep navy → electric blue → cyan → near-white

// ── Gamma ────────────────────────────────────────────────────────────────────

// Power applied to linearNorm.
//   < 1  → brightens mid-level content (lines look wider / cloudier)
//   1.0  → linear
//   > 1  → darkens mid-level content; only the sharpest peaks survive
//          → harmonic lines appear thinner and more precise
//   1.8  → recommended for "engraving" look
//   3.0  → extreme — only very loud harmonics visible
export const GAMMA = 1.5

// ── Onset detection ───────────────────────────────────────────────────────────
//
// A second tiny analyser (256 samples ≈ 6 ms) measures instantaneous RMS energy.
// Its output is used as a gated brightness multiplier:
//   onsetMult = 1 + clamp(rms × ONSET_SENSITIVITY, 0, 1) × ONSET_BOOST
//
// The multiplier is only applied to bins where norm0 > ONSET_GATE.
// Bins below ONSET_GATE (noise floor, harmonic side-lobes) are left unchanged,
// so they never bloom — the gaps between harmonics stay dark even during onset.

// Gate threshold: bins with gamma-corrected brightness below this are NOT boosted.
//   0.05 = very permissive (almost everything gets boosted → cloudier at onset)
//   0.15 = good balance — only real harmonic content gets the flash
//   0.30 = strict — only the brightest peaks flash
export const ONSET_GATE = 0.3

// Multiplier applied to above-gate bins when energy is detected.
//   0   = onset boost disabled
//   1.0 = subtle brightening of existing lines
//   2.0 = clear onset flash on harmonic peaks ← recommended
//   4.0 = very aggressive flash
export const ONSET_BOOST = 0

// Scales the raw RMS value (typically 0.001–0.3 for mic input) to 0–1.
//   Low  (3–6)  = only loud sounds trigger the boost
//   Med  (10–15) = normal speaking voice triggers clearly
//   High (25+)  = even quiet breathing triggers it
export const ONSET_SENSITIVITY = 10

// ── Display defaults ─────────────────────────────────────────────────────────

export const DEFAULT_BRIGHTNESS = 1.0

import { useRef, useState, useEffect, useCallback } from 'react'
import {
  FFT_SIZE, SCROLL_SPEED, SMOOTHING,
  MIN_DB, MAX_DB,
  MIN_FREQ_HZ, MAX_FREQ_HZ, FREQ_SCALE_EXP,
  BUFFER_SECS, DEFAULT_BRIGHTNESS,
  GAMMA, ONSET_BOOST, ONSET_SENSITIVITY, ONSET_GATE,
} from './config'

// ---------------------------------------------------------------------------
// Blue colormap: black → deep-blue → electric-blue → cyan → near-white
// ---------------------------------------------------------------------------
const COLOR_STOPS: [number, [number, number, number]][] = [
  [0.00, [0,   0,   0  ]],
  [0.20, [10,  0,   60 ]],
  [0.45, [0,   50,  200]],
  [0.70, [0,   150, 255]],
  [0.85, [100, 210, 255]],
  [1.00, [230, 250, 255]],
]

function blueColor(t: number): [number, number, number] {
  if (t <= 0) return [0, 0, 0]
  if (t >= 1) return COLOR_STOPS[COLOR_STOPS.length - 1][1]
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [t0, c0] = COLOR_STOPS[i]
    const [t1, c1] = COLOR_STOPS[i + 1]
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0)
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
      ]
    }
  }
  return [0, 0, 0]
}

// Pre-computed 256-entry color table (no brightness baked in)
const COLOR_LUT: Uint8Array = (() => {
  const buf = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = blueColor(i / 255)
    buf[i * 3]     = r
    buf[i * 3 + 1] = g
    buf[i * 3 + 2] = b
  }
  return buf
})()

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TARGET_FPS = 60

// ---------------------------------------------------------------------------
// Log-scale frequency → canvas-row mapping (fractional bin positions).
// Storing a Float32Array lets the draw loop interpolate between adjacent FFT
// bins instead of snapping to the nearest one — this eliminates the wide
// uniform stripes that appear at low frequencies on a log scale.
// ---------------------------------------------------------------------------
function buildYToFracBin(physH: number, fftSize: number, sampleRate: number): Float32Array {
  const arr    = new Float32Array(physH)
  const maxBin = fftSize / 2 - 1
  const exp    = 1 / FREQ_SCALE_EXP
  for (let y = 0; y < physH; y++) {
    const t    = y / (physH - 1)                          // 0 = top, 1 = bottom
    // Power scale: pct ∈ [0,1] from top; freq = MIN + (MAX-MIN) × (1-t)^exp
    const freq = MIN_FREQ_HZ + (MAX_FREQ_HZ - MIN_FREQ_HZ) * Math.pow(1 - t, exp)
    arr[y] = Math.max(0, Math.min(maxBin, freq * fftSize / sampleRate))
  }
  return arr
}

// ---------------------------------------------------------------------------
// Frequency labels for the log scale
// pct = log(MAX/hz) / log(MAX/MIN)   →   0 = top, 1 = bottom
// ---------------------------------------------------------------------------
// pct from top: invert the power scale mapping
function freqPct(hz: number) {
  const norm = (hz - MIN_FREQ_HZ) / (MAX_FREQ_HZ - MIN_FREQ_HZ)  // 0=MIN, 1=MAX
  return 1 - Math.pow(norm, FREQ_SCALE_EXP)                       // 0=top, 1=bottom
}

const FREQ_LABELS: { label: string; pct: number; edge: 'top' | 'mid' | 'bot' }[] = [
  { label: '2 kHz',  pct: freqPct(2000), edge: 'top' },
  { label: '1 kHz',  pct: freqPct(1000), edge: 'mid' },
  { label: '500 Hz', pct: freqPct(500),  edge: 'mid' },
  { label: '200 Hz', pct: freqPct(200),  edge: 'mid' },
  { label: '100 Hz', pct: freqPct(100),  edge: 'mid' },
  { label: '50 Hz',  pct: freqPct(50),   edge: 'mid' },
  { label: '20 Hz',  pct: freqPct(20),   edge: 'bot' },
]

const edgeTransform = {
  top: 'translateY(2px)',
  mid: 'translateY(-50%)',
  bot: 'translateY(calc(-100% - 2px))',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function App() {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)

  const scrollPxRef  = useRef(SCROLL_SPEED)
  const bufWidthRef  = useRef(BUFFER_SECS * TARGET_FPS * SCROLL_SPEED)
  const yToFracBinRef = useRef<Float32Array | null>(null)  // log-scale fractional bin map

  const audioCtxRef       = useRef<AudioContext | null>(null)
  const analyserRef       = useRef<AnalyserNode | null>(null)
  const onsetAnalyserRef  = useRef<AnalyserNode | null>(null)   // tiny analyser for fast onset RMS
  const onsetTimeDomainRef = useRef<Float32Array | null>(null)
  const streamRef         = useRef<MediaStream | null>(null)
  const animFrameRef      = useRef<number>(0)
  const dataArrayRef      = useRef<Float32Array | null>(null)
  const waveCanvasRef     = useRef<HTMLCanvasElement>(null)

  const writeXRef   = useRef(0)
  const totalPxRef  = useRef(0)

  const panOffsetRef    = useRef(0)
  const isDraggingRef   = useRef(false)
  const dragStartXRef   = useRef(0)
  const dragStartPanRef = useRef(0)
  const isPannedRef     = useRef(false)

  const [isRunning,  setIsRunning]  = useState(false)
  const [pending,    setPending]    = useState(false)
  const [isPanned,   setIsPanned]   = useState(false)
  const [brightness, setBrightness] = useState(DEFAULT_BRIGHTNESS)
  const [minDb,      setMinDb]      = useState(MIN_DB)
  const [error,      setError]      = useState<string | null>(null)

  const brightnessRef = useRef(brightness)
  brightnessRef.current = brightness
  const minDbRef = useRef(minDb)
  minDbRef.current = minDb

  // ── resize: physical-pixel canvas + off-screen buffer ────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const dpr   = window.devicePixelRatio || 1
      const physW = Math.round(canvas.offsetWidth  * dpr)
      const physH = Math.round(canvas.offsetHeight * dpr)
      if (physW === 0 || physH === 0) return

      canvas.width  = physW
      canvas.height = physH

      const scrollPx = Math.round(SCROLL_SPEED * dpr)
      const bufW     = BUFFER_SECS * TARGET_FPS * scrollPx
      scrollPxRef.current = scrollPx
      bufWidthRef.current = bufW

      const buf = document.createElement('canvas')
      buf.width  = bufW
      buf.height = physH
      const bCtx = buf.getContext('2d')!
      bCtx.fillStyle = '#000'
      bCtx.fillRect(0, 0, bufW, physH)
      offscreenRef.current = buf

      writeXRef.current  = 0
      totalPxRef.current = 0
      panOffsetRef.current = 0

      // Rebuild the log-scale y→bin table for this physical height.
      // We need sampleRate; use 44100 as default until audio starts.
      const sr = audioCtxRef.current?.sampleRate ?? 44100
      yToFracBinRef.current = buildYToFracBin(physH, FFT_SIZE, sr)

      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, physW, physH)

      // Size the waveform strip canvas
      const wc = waveCanvasRef.current
      if (wc) {
        wc.width  = physW
        wc.height = Math.round(wc.offsetHeight * dpr)
        const wCtx = wc.getContext('2d')!
        wCtx.fillStyle = '#00000f'
        wCtx.fillRect(0, 0, wc.width, wc.height)
      }
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // ── renderViewport ────────────────────────────────────────────────────────
  const renderViewport = useCallback(() => {
    const canvas    = canvasRef.current
    const offscreen = offscreenRef.current
    if (!canvas || !offscreen) return

    const ctx  = canvas.getContext('2d')!
    const W    = canvas.width
    const H    = canvas.height
    const BUFW = bufWidthRef.current

    const srcEnd   = ((writeXRef.current - panOffsetRef.current) % BUFW + BUFW) % BUFW
    const srcStart = ((srcEnd - W) % BUFW + BUFW) % BUFW

    ctx.imageSmoothingEnabled = false
    ctx.filter = `brightness(${brightnessRef.current})`

    if (srcStart < srcEnd) {
      ctx.drawImage(offscreen, srcStart, 0, W, H, 0, 0, W, H)
    } else {
      const leftW  = BUFW - srcStart
      const rightW = srcEnd
      ctx.drawImage(offscreen, srcStart, 0, leftW,  H, 0,     0, leftW,  H)
      if (rightW > 0) {
        ctx.drawImage(offscreen, 0, 0, rightW, H, leftW, 0, rightW, H)
      }
    }

    ctx.filter = 'none'
  }, [])

  // ── draw loop ─────────────────────────────────────────────────────────────
  // Uses ImageData for pixel-perfect rendering: one pixel row = one canvas row,
  // mapped through the log-scale yToBin table → no anti-aliasing, no blur.
  const drawLoop = useCallback(() => {
    const offscreen    = offscreenRef.current
    const analyser     = analyserRef.current
    const dataArray    = dataArrayRef.current
    const yToFracBin   = yToFracBinRef.current
    const onsetAnalyser   = onsetAnalyserRef.current
    const onsetTimeDomain = onsetTimeDomainRef.current
    if (!offscreen || !analyser || !dataArray || !yToFracBin) return

    const offCtx   = offscreen.getContext('2d')!
    const H        = offscreen.height
    const x        = writeXRef.current
    const scrollPx = scrollPxRef.current
    const BUFW     = bufWidthRef.current

    analyser.getFloatFrequencyData(dataArray)  // float dB values — no 8-bit quantisation

    // ── onset detection: instantaneous RMS from the 256-sample onset analyser ──
    // This is independent of FFT_SIZE so onsets are always detected in ≈6 ms.
    // onsetMult = 1 + clamp(rms × ONSET_SENSITIVITY, 0, 1) × ONSET_BOOST
    let onsetMult = 1
    if (onsetAnalyser && onsetTimeDomain) {
      onsetAnalyser.getFloatTimeDomainData(onsetTimeDomain)
      let sumSqOnset = 0
      for (let i = 0; i < onsetTimeDomain.length; i++) sumSqOnset += onsetTimeDomain[i] ** 2
      const rms = Math.sqrt(sumSqOnset / onsetTimeDomain.length)
      onsetMult = 1 + Math.min(1, rms * ONSET_SENSITIVITY) * ONSET_BOOST
    }

    // ── waveform level strip (derived from the same dataArray as the spectrogram) ──
    let sumSq = 0
    for (let i = 0; i < dataArray.length; i++) {
      const norm = Math.max(0, (dataArray[i] - minDbRef.current) / (MAX_DB - minDbRef.current))
      sumSq += norm * norm
    }
    const level = Math.min(1, Math.sqrt(sumSq / dataArray.length) * 4)

    const wc = waveCanvasRef.current
    if (wc) {
      const dpr = window.devicePixelRatio || 1
      const wCtx = wc.getContext('2d')!
      const wW = wc.width
      const wH = wc.height
      const sp  = Math.round(scrollPx)
      // Scroll left
      wCtx.drawImage(wc, -sp, 0)
      // Clear new right strip
      wCtx.fillStyle = '#00000f'
      wCtx.fillRect(wW - sp, 0, sp, wH)
      // Draw symmetric amplitude bar around centre line
      const barH = Math.max(Math.round(level * (wH - 2 * dpr)), 1)
      const cy   = wH / 2
      const grad = wCtx.createLinearGradient(0, cy - barH / 2, 0, cy + barH / 2)
      grad.addColorStop(0,   'rgba(0,120,255,0.5)')
      grad.addColorStop(0.5, 'rgba(0,180,255,1)')
      grad.addColorStop(1,   'rgba(0,120,255,0.5)')
      wCtx.fillStyle = grad
      wCtx.fillRect(wW - sp, Math.round(cy - barH / 2), sp, barH)
    }

    // Write a scrollPx-wide strip using ImageData (pixel-perfect, no smoothing)
    const imgData = offCtx.createImageData(scrollPx, H)
    const pixels  = imgData.data   // RGBA

    for (let y = 0; y < H; y++) {
      // Fractional bin position → interpolate between bin0 and bin1
      const frac  = yToFracBin[y]
      const bin0  = frac | 0
      const bin1  = Math.min(bin0 + 1, dataArray.length - 1)
      const t     = frac - bin0
      // Interpolate in dB space then map to 0–255 colour index
      const db         = dataArray[bin0] * (1 - t) + dataArray[bin1] * t
      const dbRange    = MAX_DB - minDbRef.current
      const linearNorm = Math.max(0, Math.min(1, (db - minDbRef.current) / dbRange))
      // GAMMA > 1 darkens mid-level content so only the sharpest peaks survive → thin lines
      const norm0 = Math.pow(linearNorm, GAMMA)
      // Gated onset boost: only bins already above ONSET_GATE get amplified.
      // Noise-floor bins stay dark so the gaps between harmonic lines never bloom.
      const norm  = norm0 > ONSET_GATE ? Math.min(1, norm0 * onsetMult) : norm0
      const ri    = Math.round(norm * 255) * 3

      const rowBase = y * scrollPx * 4
      for (let px = 0; px < scrollPx; px++) {
        const i = rowBase + px * 4
        pixels[i]     = COLOR_LUT[ri]
        pixels[i + 1] = COLOR_LUT[ri + 1]
        pixels[i + 2] = COLOR_LUT[ri + 2]
        pixels[i + 3] = 255                            // always opaque — fixes panning trace
      }
    }

    offCtx.putImageData(imgData, x, 0)

    writeXRef.current  = (x + scrollPx) % BUFW
    totalPxRef.current = Math.min(totalPxRef.current + scrollPx, BUFW)

    renderViewport()
    animFrameRef.current = requestAnimationFrame(drawLoop)
  }, [renderViewport])

  // Re-render when brightness changes (even while paused)
  useEffect(() => { renderViewport() }, [brightness, renderViewport])

  // ── audio ─────────────────────────────────────────────────────────────────
  const snapToLive = useCallback(() => {
    panOffsetRef.current = 0
    isPannedRef.current  = false
    setIsPanned(false)
    renderViewport()
  }, [renderViewport])

  const startRecording = useCallback(async () => {
    setError(null)
    setPending(true)
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia is not supported in this browser or context.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx

      const analyser = audioCtx.createAnalyser()
      analyser.fftSize              = FFT_SIZE
      analyser.smoothingTimeConstant = SMOOTHING
      analyser.minDecibels          = -90
      analyser.maxDecibels          = -10
      analyserRef.current = analyser

      dataArrayRef.current = new Float32Array(analyser.frequencyBinCount)

      // Second tiny analyser: 256-sample window (≈6 ms) for fast onset detection.
      // Connected to the same source — does NOT affect the main spectrogram.
      const onsetAnalyser = audioCtx.createAnalyser()
      onsetAnalyser.fftSize = 256
      onsetAnalyserRef.current  = onsetAnalyser
      onsetTimeDomainRef.current = new Float32Array(256)

      // Rebuild yToFracBin with the real sample rate
      const physH = canvasRef.current?.height ?? 800
      yToFracBinRef.current = buildYToFracBin(physH, FFT_SIZE, audioCtx.sampleRate)

      const source = audioCtx.createMediaStreamSource(stream)
      source.connect(analyser)
      source.connect(onsetAnalyser)

      snapToLive()
      setIsRunning(true)
      animFrameRef.current = requestAnimationFrame(drawLoop)
    } catch (e) {
      console.error('[SpectoVoice] mic error:', e)
      const name = e instanceof DOMException ? e.name : ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Microphone permission denied. Allow access in your browser and in System Settings → Privacy → Microphone, then try again.')
      } else if (name === 'NotFoundError') {
        setError('No microphone found. Please connect one and try again.')
      } else {
        setError(e instanceof Error ? e.message : 'Could not access microphone.')
      }
    } finally {
      setPending(false)
    }
  }, [drawLoop, snapToLive])

  const pauseRecording = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    setIsRunning(false)
    const wc = waveCanvasRef.current
    if (wc) {
      const ctx = wc.getContext('2d')!
      ctx.fillStyle = '#00000f'
      ctx.fillRect(0, 0, wc.width, wc.height)
    }
  }, [])

  const resumeRecording = useCallback(() => {
    if (!analyserRef.current) { startRecording(); return }
    snapToLive()
    setIsRunning(true)
    animFrameRef.current = requestAnimationFrame(drawLoop)
  }, [drawLoop, snapToLive, startRecording])

  const handleToggle = useCallback(() => {
    if (isRunning) pauseRecording()
    else if (streamRef.current) resumeRecording()
    else startRecording()
  }, [isRunning, pauseRecording, resumeRecording, startRecording])

  // ── panning (window-level so dragging outside canvas still works) ─────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingRef.current   = true
    dragStartXRef.current   = e.clientX
    dragStartPanRef.current = panOffsetRef.current
    document.body.style.cursor = 'grabbing'
    e.preventDefault()
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const canvas = canvasRef.current
      if (!canvas) return

      const dx     = e.clientX - dragStartXRef.current
      const maxPan = Math.max(0, totalPxRef.current - canvas.width)
      panOffsetRef.current = Math.max(0, Math.min(maxPan, dragStartPanRef.current + dx))

      const nowPanned = panOffsetRef.current > 0
      if (nowPanned !== isPannedRef.current) {
        isPannedRef.current = nowPanned
        setIsPanned(nowPanned)
      }
      renderViewport()
    }
    const onUp = () => {
      isDraggingRef.current      = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [renderViewport])

  // ── cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioCtxRef.current?.close()
    }
  }, [])

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      <h1 style={styles.title}>SpectoVoice</h1>

      <div style={styles.canvasWrapper}>
        {/* Waveform level strip */}
        <canvas ref={waveCanvasRef} style={styles.waveStrip} />

        <canvas
          ref={canvasRef}
          style={styles.canvas}
          onMouseDown={handleMouseDown}
        />

        <FreqLabels />

        <div style={styles.liveBar}>
          {isPanned
            ? <button onClick={snapToLive} style={styles.liveBtn}>◀ Back to live</button>
            : <span style={styles.liveDot}>● LIVE</span>
          }
        </div>

        {!isRunning && !streamRef.current && (
          <div style={styles.overlay}>
            <span style={styles.overlayText}>Press play to start recording</span>
          </div>
        )}
      </div>

      {error && (
        <div style={styles.errorBox}>
          <strong>Error:</strong> {error}
          <button onClick={() => setError(null)} style={styles.errorDismiss}>✕</button>
        </div>
      )}

      <div style={styles.controls}>
        <button
          onClick={handleToggle}
          disabled={pending}
          style={{ ...styles.playBtn, opacity: pending ? 0.5 : 1 }}
          aria-label={isRunning ? 'Pause' : (pending ? 'Waiting for permission…' : 'Play')}
        >
          {pending ? <SpinnerIcon /> : isRunning ? <PauseIcon /> : <PlayIcon />}
        </button>

        <div style={styles.sliderGroup}>
          <label style={styles.sliderLabel} htmlFor="brightness">Brightness</label>
          <input
            id="brightness"
            type="range"
            min={0.3}
            max={4}
            step={0.05}
            value={brightness}
            onChange={e => setBrightness(Number(e.target.value))}
            style={styles.slider}
          />
          <span style={styles.sliderValue}>{brightness.toFixed(1)}×</span>
        </div>

        <div style={styles.sliderGroup}>
          <label style={styles.sliderLabel} htmlFor="mindb">Noise floor</label>
          <input
            id="mindb"
            type="range"
            min={-130}
            max={-40}
            step={1}
            value={minDb}
            onChange={e => setMinDb(Number(e.target.value))}
            style={styles.slider}
          />
          <span style={styles.sliderValue}>{minDb} dB</span>
        </div>

        <div style={styles.hint}>Drag right to pan back up to 30 s</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Frequency axis
// ---------------------------------------------------------------------------
function FreqLabels() {
  return (
    <div style={styles.freqAxis}>
      {FREQ_LABELS.map(({ label, pct, edge }) => (
        <span
          key={label}
          style={{ ...styles.freqLabel, top: `${pct * 100}%`, transform: edgeTransform[edge] }}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function SpinnerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
      <path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  )
}
function PlayIcon() {
  return <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
}
function PauseIcon() {
  return <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '100vw',
    height: '100vh',
    padding: '20px 24px 16px',
    gap: '16px',
  },
  title: {
    fontSize: '1.2rem',
    fontWeight: 600,
    letterSpacing: '0.12em',
    color: '#a0a0c0',
    textTransform: 'uppercase',
    flexShrink: 0,
  },
  waveStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '52px',
    display: 'block',
    borderBottom: '1px solid rgba(0,80,180,0.25)',
  },
  canvasWrapper: {
    position: 'relative',
    width: '100%',
    flex: 1,
    borderRadius: '10px',
    overflow: 'hidden',
    border: '1px solid #222240',
    background: '#000',
  },
  canvas: {
    display: 'block',
    width: '100%',
    height: '100%',
    cursor: 'grab',
    userSelect: 'none',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    background: 'rgba(0,0,0,0.45)',
  },
  overlayText: {
    fontSize: '1rem',
    color: '#606080',
    letterSpacing: '0.05em',
  },
  freqAxis: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '62px',
    height: '100%',
    pointerEvents: 'none',
  },
  freqLabel: {
    position: 'absolute',
    left: '6px',
    fontSize: '10px',
    color: 'rgba(180,180,220,0.6)',
    whiteSpace: 'nowrap',
  },
  liveBar: {
    position: 'absolute',
    top: '10px',
    right: '12px',
  },
  liveDot: {
    fontSize: '11px',
    color: '#44dd88',
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  liveBtn: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.06em',
    color: '#8888cc',
    background: 'rgba(30,30,60,0.85)',
    border: '1px solid #4444aa',
    borderRadius: '6px',
    padding: '4px 10px',
    cursor: 'pointer',
  },
  errorBox: {
    position: 'relative' as const,
    background: 'rgba(180,30,30,0.2)',
    border: '1px solid #aa3333',
    borderRadius: '8px',
    padding: '10px 40px 10px 14px',
    fontSize: '0.85rem',
    color: '#ffaaaa',
    maxWidth: '600px',
    lineHeight: 1.5,
    flexShrink: 0,
  },
  errorDismiss: {
    position: 'absolute' as const,
    top: '8px',
    right: '10px',
    background: 'none',
    border: 'none',
    color: '#ffaaaa',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '32px',
    flexShrink: 0,
    paddingBottom: '8px',
  },
  playBtn: {
    width: '72px',
    height: '72px',
    borderRadius: '50%',
    border: '2px solid #4444aa',
    background: 'linear-gradient(135deg, #1a1a40, #2a2a60)',
    color: '#8888ff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.15s ease',
    boxShadow: '0 0 20px rgba(80,80,200,0.3)',
    flexShrink: 0,
  },
  sliderGroup: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
  },
  sliderLabel: {
    fontSize: '0.75rem',
    color: '#606080',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
  },
  slider: {
    width: '180px',
    accentColor: '#6666cc',
    cursor: 'pointer',
  },
  sliderValue: {
    fontSize: '0.85rem',
    color: '#8888cc',
    fontVariantNumeric: 'tabular-nums',
    minWidth: '36px',
    textAlign: 'center',
  },
  hint: {
    fontSize: '0.72rem',
    color: '#404060',
    maxWidth: '120px',
    textAlign: 'center',
    lineHeight: 1.4,
  },
}

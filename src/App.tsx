import { useRef, useState, useEffect, useCallback } from 'react'

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

const COLOR_LUT: [number, number, number][] = Array.from({ length: 256 }, (_, i) =>
  blueColor(i / 255)
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FFT_SIZE     = 2048
const SCROLL_SPEED = 3           // logical px / frame
const SMOOTHING    = 0.6
const MAX_FREQ_HZ  = 10_000
const BUFFER_SECS  = 30
const TARGET_FPS   = 60

// ---------------------------------------------------------------------------
// Frequency labels (linear 0–10 kHz)
// ---------------------------------------------------------------------------
const FREQ_LABELS: { label: string; pct: number; edge: 'top' | 'mid' | 'bot' }[] = [
  { label: '10 kHz', pct: 0,   edge: 'top' },
  { label: '8 kHz',  pct: 0.2, edge: 'mid' },
  { label: '6 kHz',  pct: 0.4, edge: 'mid' },
  { label: '4 kHz',  pct: 0.6, edge: 'mid' },
  { label: '2 kHz',  pct: 0.8, edge: 'mid' },
  { label: '0 Hz',   pct: 1.0, edge: 'bot' },
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

  // Physical-pixel scroll speed and buffer width (computed on resize)
  const scrollPxRef  = useRef(SCROLL_SPEED)
  const bufWidthRef  = useRef(BUFFER_SECS * TARGET_FPS * SCROLL_SPEED)

  const audioCtxRef  = useRef<AudioContext | null>(null)
  const analyserRef  = useRef<AnalyserNode | null>(null)
  const streamRef    = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number>(0)
  const dataArrayRef = useRef<Uint8Array | null>(null)
  const maxBinRef    = useRef(512)

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
  const [brightness, setBrightness] = useState(1.4)
  const [error,      setError]      = useState<string | null>(null)

  const brightnessRef = useRef(brightness)
  brightnessRef.current = brightness

  // ── resize ─────────────────────────────────────────────────────────────────
  // Everything lives in PHYSICAL pixels — the off-screen buffer matches the
  // canvas's physical resolution so drawImage is 1-to-1, no upscaling blur.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const dpr   = window.devicePixelRatio || 1
      const physW = Math.round(canvas.offsetWidth  * dpr)
      const physH = Math.round(canvas.offsetHeight * dpr)

      canvas.width  = physW
      canvas.height = physH

      // Physical scroll speed and buffer width for this DPR
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

      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, physW, physH)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // ── renderViewport ─────────────────────────────────────────────────────────
  // All coordinates are physical pixels — 1:1 with the canvas, no scaling.
  const renderViewport = useCallback(() => {
    const canvas    = canvasRef.current
    const offscreen = offscreenRef.current
    if (!canvas || !offscreen) return

    const ctx  = canvas.getContext('2d')!
    const W    = canvas.width          // physical
    const H    = canvas.height         // physical
    const BUFW = bufWidthRef.current

    const srcEnd   = ((writeXRef.current - panOffsetRef.current) % BUFW + BUFW) % BUFW
    const srcStart = ((srcEnd - W)                                % BUFW + BUFW) % BUFW

    ctx.imageSmoothingEnabled = false
    ctx.filter = `brightness(${brightnessRef.current})`

    if (srcStart < srcEnd) {
      ctx.drawImage(offscreen, srcStart, 0, W, H, 0, 0, W, H)
    } else {
      const leftW  = BUFW - srcStart
      const rightW = srcEnd
      ctx.drawImage(offscreen, srcStart, 0, leftW,  H, 0,     0, leftW,  H)
      if (rightW > 0) {
        ctx.drawImage(offscreen, 0, 0,        rightW, H, leftW, 0, rightW, H)
      }
    }

    ctx.filter = 'none'
  }, [])

  // ── draw loop ──────────────────────────────────────────────────────────────
  const drawLoop = useCallback(() => {
    const offscreen = offscreenRef.current
    const analyser  = analyserRef.current
    const dataArray = dataArrayRef.current
    if (!offscreen || !analyser || !dataArray) return

    const offCtx   = offscreen.getContext('2d')!
    offCtx.imageSmoothingEnabled = false
    const H        = offscreen.height        // physical
    const maxBin   = maxBinRef.current
    const x        = writeXRef.current
    const scrollPx = scrollPxRef.current
    const BUFW     = bufWidthRef.current

    analyser.getByteFrequencyData(dataArray)

    offCtx.fillStyle = '#000'
    offCtx.fillRect(x, 0, scrollPx, H)

    const binH = H / maxBin
    for (let i = 0; i < maxBin; i++) {
      const rawValue = dataArray[maxBin - 1 - i]
      const [r, g, b] = COLOR_LUT[rawValue]
      if (r === 0 && g === 0 && b === 0) continue
      offCtx.fillStyle = `rgb(${r},${g},${b})`
      offCtx.fillRect(x, Math.floor(i * binH), scrollPx, Math.ceil(binH))
    }

    writeXRef.current  = (x + scrollPx) % BUFW
    totalPxRef.current = Math.min(totalPxRef.current + scrollPx, BUFW)

    renderViewport()
    animFrameRef.current = requestAnimationFrame(drawLoop)
  }, [renderViewport])

  // Re-render when brightness changes (including while paused)
  useEffect(() => { renderViewport() }, [brightness, renderViewport])

  // ── audio ──────────────────────────────────────────────────────────────────
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
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = SMOOTHING
      analyser.minDecibels = -90
      analyser.maxDecibels = -10
      analyserRef.current = analyser

      maxBinRef.current = Math.min(
        analyser.frequencyBinCount,
        Math.floor(MAX_FREQ_HZ * FFT_SIZE / audioCtx.sampleRate)
      )
      dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount)
      audioCtx.createMediaStreamSource(stream).connect(analyser)

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

  // ── panning (window-level so drag outside canvas still works) ─────────────
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

  // ── cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioCtxRef.current?.close()
    }
  }, [])

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      <h1 style={styles.title}>SpectoVoice</h1>

      <div style={styles.canvasWrapper}>
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

        <div style={styles.hint}>Drag left to pan back up to 30 s</div>
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
    width: '60px',
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

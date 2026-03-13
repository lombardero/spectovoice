# SpectoVoice

A real-time voice spectrogram in the browser. Records your microphone and displays a scrolling frequency waterfall (frequency vs. time).

**Live demo:** https://lombardero.github.io/spectovoice/

## Requirements

- [Node.js](https://nodejs.org) (v18 or later)
- A modern browser with microphone access (Chrome, Firefox, Safari, Edge)

## Run

```bash
./start.sh
```

Then open **http://localhost:5173** in your browser.

> The script installs dependencies on first run, so it may take a few seconds the first time.

## Usage

1. Click the **play button** — your browser will ask for microphone permission, grant it.
2. Speak or make noise — frequencies scroll left across the canvas in real time.
3. Click the button again to **pause** the visualization (the mic stream stays open so resuming is instant).
4. Use the **Brightness** slider to adjust how visible quiet frequencies are:
   - Low brightness → only loud frequencies show color
   - High brightness → even quiet background noise is visible

## What you're seeing

- **Y-axis:** frequency (low frequencies at the bottom, ~20 kHz at the top)
- **X-axis:** time scrolling left
- **Color:** amplitude — dark/black = silence, purple → magenta → orange → bright yellow = louder

## Tech

- [Vite](https://vitejs.dev) + [React](https://react.dev) + TypeScript
- Native [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) (`AnalyserNode`, 2048-point FFT)
- HTML5 Canvas for rendering (no visualization library needed)

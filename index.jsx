import React, { useEffect, useRef, useState } from 'react'

// Godot runs directly in this app frame. Its policy already permits
// WebAssembly; the nested packaged-file frame does not on every Möbius.
// Packaged files are public under /app-assets, so the engine loads them from
// there and saves go straight to Möbius app storage.
const BUILD = 'b79ba950b6f5'
const GODOT_CONFIG = {"args": [], "canvasResizePolicy": 2, "ensureCrossOriginIsolationHeaders": true, "executable": "index", "experimentalVK": false, "fileSizes": {"index.pck": 13425280, "index.wasm": 35376909}, "focusCanvas": true, "gdextensionLibs": []}

const CSS = `
.rk-app { position: fixed; inset: 0; overflow: hidden; background: #221712; color: var(--text); font-family: var(--font); }
.rk-app canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; }
.rk-cover { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; background: var(--bg); }
.rk-card { width: min(100%, 390px); padding: 28px; border: 1px solid var(--border); border-radius: 22px; background: var(--surface); text-align: center; box-shadow: 0 22px 60px #0003; }
.rk-card img { width: 76px; height: 76px; object-fit: contain; margin-bottom: 12px; }
.rk-card h1 { font-size: 24px; margin: 0 0 9px; }
.rk-card p { color: var(--muted); line-height: 1.45; margin: 0; }
.rk-card button, .rk-audio button { min-height: 44px; margin-top: 20px; padding: 9px 20px; border: 0; border-radius: 12px; background: var(--accent); color: white; font: inherit; font-weight: 700; cursor: pointer; }
.rk-card button:focus-visible, .rk-audio button:focus-visible { outline: 3px solid var(--text); outline-offset: 3px; }
.rk-audio { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); width: max-content; max-width: calc(100% - 32px); padding: 8px 16px 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; border: 2px solid #ba8245; border-radius: 16px; background: #39251bdc; color: #fff5df; font-weight: 700; }
.rk-audio button { margin-top: 4px; background: #f7ca6d; color: #3b2619; }
.rk-save-warning { position: absolute; bottom: 12px; left: 12px; right: 12px; max-width: 520px; margin: auto; padding: 12px 15px; border-radius: 12px; background: #692b22; color: #fff; font-size: 14px; text-align: center; }
`

// The engine and pack ship gzip-compressed: the Store preserves every file
// separately and refuses very large ones. Godot still asks for index.wasm and
// index.pck; inflate them in the stream.
function installInflatingFetch() {
  if (window.__ratKingdomFetch) return
  window.__ratKingdomFetch = true
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href)
    const packed = url.pathname.match(/\/index\.(wasm|pck)$/)
    if (!packed) return nativeFetch(input, init)
    url.pathname += '.gz'
    return nativeFetch(url.href, init).then((response) => {
      if (!response.ok || !response.body) return response
      if (typeof DecompressionStream !== 'function') {
        throw new Error('Ovaj preglednik je prestar za igru (nema DecompressionStream).')
      }
      const type = packed[1] === 'wasm' ? 'application/wasm' : 'application/octet-stream'
      const body = response.body.pipeThrough(new DecompressionStream('gzip'))
      return new Response(body, { status: 200, headers: { 'Content-Type': type } })
    })
  }
}

// Godot renders at window size × devicePixelRatio. A big pane on a high-DPI
// screen can mean 3–4× the pixels of the 1280×720 game, which stutters in
// the browser. Cap the drawn resolution; CSS stretches the canvas to fit.
const MAX_RENDER = { width: 1600, height: 900 }
function capRenderResolution() {
  const real = window.devicePixelRatio || 1
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    get() {
      const w = Math.max(1, window.innerWidth)
      const h = Math.max(1, window.innerHeight)
      return Math.min(real, MAX_RENDER.width / w, MAX_RENDER.height / h)
    },
  })
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = resolve
    script.onerror = () => reject(new Error('Igra se nije mogla preuzeti. Provjeri vezu.'))
    document.head.append(script)
  })
}

export default function App({ appId }) {
  const canvas = useRef(null)
  const writeQueue = useRef(Promise.resolve())
  const [state, setState] = useState('loading')
  const [progress, setProgress] = useState(0)
  const [failure, setFailure] = useState('')
  const [audioPaused, setAudioPaused] = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    // One engine per page: Godot keeps global state, so a retry reloads.
    if (window.__ratKingdomStarted !== undefined) return
    window.__ratKingdomStarted = false
    const base = `/app-assets/by-id/${appId}/`
    const fail = (error) => {
      if (window.__ratKingdomStarted) return
      const message = String((error && error.message) || error || 'Nepoznata greška.').slice(0, 300)
      window.mobius.signal('error', { source: 'game', message })
      setFailure(message)
      setState('error')
    }

    let audioContext = null
    let onScreen = true
    let suspendedForVisibility = false
    let visibilityAudioWork = Promise.resolve()
    const visible = () => onScreen && document.visibilityState !== 'hidden'
    const syncAudio = () => setAudioPaused(visible() && audioContext?.state === 'suspended')
    const syncVisibility = () => {
      visibilityAudioWork = visibilityAudioWork.then(async () => {
        window.__ratKingdomBridge?.setVisible?.(visible())
        if (!audioContext) return
        if (!visible() && audioContext.state === 'running') {
          suspendedForVisibility = true
          await audioContext.suspend()
        } else if (visible() && suspendedForVisibility) {
          suspendedForVisibility = false
          await audioContext.resume()
        }
        syncAudio()
      }).catch(syncAudio)
    }
    const onAudioContext = () => {
      audioContext = window.__ratKingdomAudioContext
      audioContext.addEventListener('statechange', syncVisibility)
      syncVisibility()
    }
    window.addEventListener('rat-kingdom:audio-context', onAudioContext)
    const onFrameVisibility = (event) => {
      if (event.source !== window.parent || event.data?.type !== 'moebius:frame-visibility') return
      onScreen = event.data.visible === true
      syncVisibility()
    }
    window.addEventListener('message', onFrameVisibility)
    document.addEventListener('visibilitychange', syncVisibility)
    const unlockAudio = () => {
      if (visible() && audioContext?.state === 'suspended') audioContext.resume().then(syncAudio).catch(() => {})
    }
    window.addEventListener('pointerdown', unlockAudio, true)
    window.addEventListener('keydown', unlockAudio, true)

    installInflatingFetch()
    capRenderResolution()
    window.mobius.storage.get('save.json').then(async (saved) => {
      window.__ratKingdomBridge = {
        load() {
          return saved && typeof saved === 'object' ? JSON.stringify(saved) : ''
        },
        save(json) {
          let next
          try { next = JSON.parse(json) } catch { return false }
          writeQueue.current = writeQueue.current.catch(() => {}).then(() => window.mobius.storage.set('save.json', next))
          writeQueue.current.then(() => {
            setSaveError(false)
            window.mobius.signal('game_saved')
          }).catch((error) => {
            setSaveError(true)
            window.mobius.signal('error', { source: 'save', message: error.message })
          })
          return 'mobius_saved'
        },
      }
      await loadScript(`${base}index.js?v=${BUILD}`)
      const missing = window.Engine.getMissingFeatures({ threads: false })
      if (missing.length) throw new Error('Pregledniku nedostaje: ' + missing.join(', '))
      const executable = `${base}index`
      const engine = new window.Engine({
        ...GODOT_CONFIG,
        canvas: canvas.current,
        executable,
        mainPack: `${executable}.pck?v=${BUILD}`,
        fileSizes: {
          [`${executable}.wasm`]: GODOT_CONFIG.fileSizes['index.wasm'],
          [`${executable}.pck?v=${BUILD}`]: GODOT_CONFIG.fileSizes['index.pck'],
        },
        persistentPaths: [],
        serviceWorker: '',
        ensureCrossOriginIsolationHeaders: false,
      })
      await engine.startGame({
        onProgress: (current, total) => {
          if (!window.__ratKingdomStarted && total > 0) setProgress(Math.min(1, current / total))
        },
      })
      window.__ratKingdomBridge?.setVisible?.(visible())
      window.__ratKingdomStarted = true
      setState('playing')
      canvas.current?.focus()
      window.mobius.signal('app_ready')
    }).catch(fail)
    return () => {
      window.removeEventListener('message', onFrameVisibility)
      document.removeEventListener('visibilitychange', syncVisibility)
      window.removeEventListener('rat-kingdom:audio-context', onAudioContext)
      window.removeEventListener('pointerdown', unlockAudio, true)
      window.removeEventListener('keydown', unlockAudio, true)
      audioContext?.removeEventListener('statechange', syncVisibility)
      audioContext?.suspend().catch(() => {})
    }
  }, [appId])

  const retry = () => location.reload()
  return <div className="rk-app">
    <style>{CSS}</style>
    <canvas id="canvas" ref={canvas} tabIndex={0} onContextMenu={(event) => event.preventDefault()}>
      Tvoj preglednik ne podržava canvas.
    </canvas>
    {state !== 'playing' ? <div className="rk-cover" role="status"><div className="rk-card">
      <img src={`/app-assets/by-id/${appId}/index.icon.png`} alt="" />
      <h1>Rat Kingdom</h1>
      <p>{state === 'error' ? `Igra se nije pokrenula: ${failure}`
        : progress > 0 && progress < 1 ? `Pripremamo tvoje kraljevstvo… ${Math.round(progress * 100)}%`
        : progress >= 1 ? 'Kraljevstvo se budi…' : 'Pripremamo tvoje kraljevstvo…'}</p>
      {state === 'error' ? <button type="button" onClick={retry}>Pokušaj ponovo</button> : null}
    </div></div> : null}
    {state === 'playing' && audioPaused ? <div className="rk-audio" role="status">
      <span>Zvuk je pauziran u pregledniku.</span>
      <button type="button" onClick={() => window.__ratKingdomAudioContext?.resume()}>Pokreni sa zvukom</button>
    </div> : null}
    {saveError ? <div className="rk-save-warning" role="alert">Napredak nije snimljen. Provjeri vezu i pokušaj ponovo prije zatvaranja igre.</div> : null}
  </div>
}

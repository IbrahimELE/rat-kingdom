import React, { useEffect, useRef, useState } from 'react'

const CSS = `
.rk-app { width: 100%; height: 100%; min-height: 320px; overflow: hidden; position: relative; display: flex; align-items: center; justify-content: center; background: #221712; color: var(--text); font-family: var(--font); }
.rk-app iframe { flex: none; display: block; border: 0; background: #221712; }
.rk-cover { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; background: var(--bg); }
.rk-card { width: min(100%, 390px); padding: 28px; border: 1px solid var(--border); border-radius: 22px; background: var(--surface); text-align: center; box-shadow: 0 22px 60px #0003; }
.rk-card img { width: 76px; height: 76px; object-fit: contain; margin-bottom: 12px; }
.rk-card h1 { font-size: 24px; margin: 0 0 9px; }
.rk-card p { color: var(--muted); line-height: 1.45; margin: 0; }
.rk-card button { min-height: 44px; margin-top: 20px; padding: 9px 20px; border: 0; border-radius: 12px; background: var(--accent); color: white; font: inherit; font-weight: 700; cursor: pointer; }
.rk-card button:focus-visible { outline: 3px solid var(--text); outline-offset: 3px; }
.rk-save-warning { position: absolute; bottom: 12px; left: 12px; right: 12px; max-width: 520px; margin: auto; padding: 12px 15px; border-radius: 12px; background: #692b22; color: #fff; font-size: 14px; text-align: center; }
`

export default function App({ appId }) {
  const container = useRef(null)
  const frame = useRef(null)
  const saved = useRef(null)
  const writeQueue = useRef(Promise.resolve())
  const [load, setLoad] = useState({ state: 'loading', attempt: 0 })
  const [playing, setPlaying] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [frameSize, setFrameSize] = useState({ width: 1280, height: 720 })
  // Visible loading: download share from Godot, then a failure reason if the game stops.
  const [progress, setProgress] = useState(0)
  const [failure, setFailure] = useState('')
  const started = useRef(false)

  useEffect(() => {
    const resize = () => {
      const box = container.current?.getBoundingClientRect()
      if (!box) return
      const scale = Math.min(1, box.width / 1280, box.height / 720)
      const next = { width: 1280 * scale, height: 720 * scale }
      setFrameSize((previous) => previous.width === next.width && previous.height === next.height ? previous : next)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container.current)
    resize()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    setPlaying(false)
    setSaveError(false)
    setProgress(0)
    setFailure('')
    started.current = false
    window.mobius.storage.get('save.json').then((value) => {
      if (!active) return
      saved.current = value
      setLoad((current) => ({ ...current, state: 'ready' }))
    }).catch((error) => {
      if (!active) return
      window.mobius.signal('error', { source: 'load', message: error.message })
      setLoad((current) => ({ ...current, state: 'error' }))
    })
    return () => { active = false }
  }, [load.attempt])

  useEffect(() => {
    if (load.state !== 'ready') return
    // Slow networks keep sending progress; only a silent minute counts as stuck.
    let timeout
    // Everything below guards startup only: once the game reported ready it
    // owns the frame, and late messages (Godot keeps animating its progress
    // bar for a while) must never time out or replace a running game.
    const fail = (reason, details) => {
      if (started.current) return
      clearTimeout(timeout)
      window.mobius.signal('error', { source: 'game', message: reason, ...details })
      setFailure(reason)
      setLoad((current) => ({ ...current, state: 'error' }))
    }
    const armTimeout = (seen) => {
      clearTimeout(timeout)
      timeout = setTimeout(() => fail('Igra se predugo učitava.', { progress: seen }), 60000)
    }
    armTimeout(0)
    const onMessage = (event) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return
      if (event.data?.type === 'rat-kingdom:boot-request') {
        frame.current.contentWindow.postMessage({ type: 'rat-kingdom:boot', save: saved.current }, '*')
      } else if (event.data?.type === 'rat-kingdom:progress' && !started.current) {
        const share = event.data.total > 0 ? Math.min(1, event.data.current / event.data.total) : 0
        setProgress(share)
        armTimeout(share)
      } else if (event.data?.type === 'rat-kingdom:failed' && !started.current) {
        fail(String(event.data.message || 'Nepoznata greška.').slice(0, 300), {})
      } else if (event.data?.type === 'rat-kingdom:ready') {
        clearTimeout(timeout)
        started.current = true
        setPlaying(true)
        window.mobius.signal('app_ready')
      } else if (event.data?.type === 'rat-kingdom:save' && event.data.save && typeof event.data.save === 'object') {
        const next = event.data.save
        writeQueue.current = writeQueue.current.catch(() => {}).then(() => window.mobius.storage.set('save.json', next))
        writeQueue.current.then(() => {
          saved.current = next
          setSaveError(false)
          window.mobius.signal('game_saved')
        }).catch((error) => {
          setSaveError(true)
          window.mobius.signal('error', { source: 'save', message: error.message })
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => { clearTimeout(timeout); window.removeEventListener('message', onMessage) }
  }, [load.state])

  const retry = () => setLoad((current) => ({ state: 'loading', attempt: current.attempt + 1 }))
  const src = `/app-embeds/by-id/${appId}/index.html?v=557b7b659a1c`
  return <div className="rk-app" ref={container}>
    <style>{CSS}</style>
    {load.state === 'ready' ? <iframe key={load.attempt} ref={frame} title="Rat Kingdom" src={src}
      onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'rat-kingdom:boot', save: saved.current }, '*')}
      allow="autoplay *; fullscreen *; gamepad *" style={{ ...frameSize, opacity: playing ? 1 : 0 }} /> : null}
    {!playing ? <div className="rk-cover" role="status"><div className="rk-card">
      <img src={`/app-assets/by-id/${appId}/index.icon.png`} alt="" />
      <h1>Rat Kingdom</h1>
      <p>{load.state === 'error'
        ? (failure ? `Igra se nije pokrenula: ${failure}` : 'Igra se nije uspjela učitati bez rizika za tvoj napredak.')
        : progress > 0 && progress < 1 ? `Pripremamo tvoje kraljevstvo… ${Math.round(progress * 100)}%`
        : progress >= 1 ? 'Kraljevstvo se budi…' : 'Pripremamo tvoje kraljevstvo…'}</p>
      {load.state === 'error' ? <button type="button" onClick={retry}>Pokušaj ponovo</button> : null}
    </div></div> : null}
    {saveError ? <div className="rk-save-warning" role="alert">Napredak nije snimljen. Provjeri vezu i pokušaj ponovo prije zatvaranja igre.</div> : null}
  </div>
}

// The parent owns durable saves; the sandboxed Godot frame cannot use IndexedDB.
let resolveBoot
window.__ratKingdomReady = new Promise((resolve) => { resolveBoot = resolve })

function acceptBoot(event) {
  if (event.source !== window.parent || event.data?.type !== 'rat-kingdom:boot') return
  window.removeEventListener('message', acceptBoot)
  const initialSave = event.data.save
  window.__ratKingdomBridge = {
    load() {
      return initialSave && typeof initialSave === 'object' ? JSON.stringify(initialSave) : ''
    },
    save(json) {
      try {
        window.parent.postMessage({ type: 'rat-kingdom:save', save: JSON.parse(json) }, '*')
        return 'mobius_saved'
      } catch (error) {
        console.error('Rat Kingdom save bridge failed', error)
        return false
      }
    },
  }
  resolveBoot()
}
window.addEventListener('message', acceptBoot)

window.parent.postMessage({ type: 'rat-kingdom:boot-request' }, '*')

// An embedded web game may create WebAudio before the browser allows playback.
// The button lives in the game frame so its click is a direct user gesture for
// the same AudioContext Godot uses. It only appears while that context is paused.
let gameAudioContext = null
let audioPrompt = null

function syncAudioPrompt() {
  if (!gameAudioContext || gameAudioContext.state !== 'suspended') {
    audioPrompt?.remove()
    audioPrompt = null
    return
  }
  if (audioPrompt) return

  const prompt = document.createElement('div')
  prompt.id = 'rat-kingdom-audio-prompt'
  prompt.setAttribute('role', 'status')
  prompt.style.cssText = 'position:fixed;z-index:1000;left:50%;bottom:24px;transform:translateX(-50%);width:max-content;max-width:calc(100% - 32px);padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:center;border:2px solid #ba8245;border-radius:16px;background:#39251bdc;color:#fff5df;box-shadow:0 8px 30px #0008;font:700 16px sans-serif;text-align:center;'
  const label = document.createElement('span')
  label.textContent = 'Zvuk je pauziran u pregledniku.'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Pokreni sa zvukom'
  button.style.cssText = 'min-height:44px;padding:8px 16px;border:0;border-radius:10px;background:#f7ca6d;color:#3b2619;font:700 16px sans-serif;cursor:pointer;'
  button.addEventListener('click', unlockAudio)
  prompt.append(label, button)
  document.body.append(prompt)
  audioPrompt = prompt
}

function unlockAudio() {
  if (!gameAudioContext || gameAudioContext.state !== 'suspended') return
  gameAudioContext.resume().then(syncAudioPrompt).catch((error) => {
    console.error('Rat Kingdom audio could not resume', error)
    if (audioPrompt) audioPrompt.firstElementChild.textContent = 'Preglednik je odbio zvuk. Pokušaj kliknuti opet.'
  })
}

window.addEventListener('rat-kingdom:audio-context', () => {
  gameAudioContext = window.__ratKingdomAudioContext
  gameAudioContext.addEventListener('statechange', syncAudioPrompt)
  syncAudioPrompt()
})
window.addEventListener('pointerdown', unlockAudio, true)
window.addEventListener('keydown', unlockAudio, true)

// Face reading in the browser with the free open-source @vladmandic/human library. The three model files are served from /models
// (our own web app), so nothing is sent to an outside service. The library is loaded only when a person clocks in with proof.
// A reading is a list of numbers (an "embedding") the server compares with the person's approved readings; the picture is not rebuilt from it.
let human: any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function loadFace() {
  if (human) return human
  const { Human } = await import('@vladmandic/human')
  const h = new Human({
    modelBasePath: '/models/', backend: 'webgl', cacheSensitivity: 0, debug: false,
    filter: { enabled: true, equalization: false },
    face: { enabled: true, detector: { rotation: false, maxDetected: 1 }, mesh: { enabled: true }, iris: { enabled: false }, description: { enabled: true }, emotion: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false } },
    body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false },
  })
  await h.load()
  human = h
  return h
}

type Source = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
// One face in the picture: its embedding and how far the head is turned (yaw, radians). null when no face is found.
export async function readFace(src: Source, withEmbedding = true): Promise<{ embedding: number[]; yaw: number } | null> {
  const h = await loadFace()
  const r = await h.detect(src, withEmbedding ? undefined : { face: { description: { enabled: false } } })
  const f = r.face?.[0]
  if (!f) return null
  const embedding: number[] = f.embedding?.length ? Array.from(f.embedding as number[]) : []
  if (withEmbedding && !embedding.length) return null
  return { embedding, yaw: f.rotation?.angle?.yaw ?? 0 }
}
export const readable = (e: number[]) => e.map((n) => Math.round(n * 1e5) / 1e5)

// Head-turn challenge: the person turns their head to one side and then the other within the time limit. It is direction-agnostic
// because the preview is mirrored; a flat photo cannot do it. ponytail: a pre-recorded video of someone turning both ways can still pass,
// which is why every punch is also reviewable and a stronger provider can replace this later.
export async function turnChallenge(video: HTMLVideoElement, ms = 10000): Promise<boolean> {
  const T = 0.25
  let a = false, b = false
  const end = Date.now() + ms
  while (Date.now() < end && !(a && b)) {
    const r = await readFace(video, false)
    if (r) { if (r.yaw > T) a = true; if (r.yaw < -T) b = true }
    await sleep(120)
  }
  return a && b
}

export const deviceKind = (): 'mobile' | 'desktop' => (/Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? 'mobile' : 'desktop')
export const isVirtualCamera = (s: MediaStream | null) => /virtual|manycam|xsplit|splitcam|snap camera|obs-?camera/i.test(s?.getVideoTracks()[0]?.label ?? '')

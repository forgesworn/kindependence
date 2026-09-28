// Camera QR scanning (jsQR over getUserMedia), shared by sign-in's bunker /
// dependant screens (signin.ts) and in-person guardian-link pairing
// (link-pairing.ts; plan 2, Task 7). Lifted from signin.ts unchanged in
// behaviour. One persistent <video> element, reused across renders and
// moved into whichever `.qr-scan-mount` the current render drew
// (`mountQrScanner`, called from app.ts's render() like its own `mountMap`),
// since recreating a MediaStream every render would restart the camera
// constantly. One scan at a time: starting a scan stops any other.

import jsQRDefault from 'jsqr'
import type { QRCode as JsQRResult } from 'jsqr'

// jsqr ships a CJS bundle (`module.exports = jsQR`, confirmed by reading its
// dist output) whose .d.ts nonetheless uses ESM `export default` syntax.
// Under `moduleResolution: NodeNext` that mismatch makes TypeScript type the
// default-import binding as the whole module namespace rather than the
// function it actually is at runtime — a known interop gap for CJS packages
// that ship an ESM-shaped .d.ts. Re-typed once here, at the one call site
// below, rather than fighting the resolver.
const jsQR = jsQRDefault as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => JsQRResult | null

let videoEl: HTMLVideoElement | null = null
let scanStream: MediaStream | null = null
let scanRaf: number | null = null
/** Bumped by every start and stop, so a camera grant that resolves after
 *  its scan was stopped or replaced is recognised as stale. */
let generation = 0

export function stopQrScan(): void {
  generation++
  if (scanRaf !== null) { cancelAnimationFrame(scanRaf); scanRaf = null }
  scanStream?.getTracks().forEach((t) => t.stop())
  scanStream = null
}

/** Scanned frames are downscaled to at most this many pixels wide before
 *  jsQR runs over them (signin fix round 1, finding 7d) — a raw camera
 *  frame can be several megapixels; jsQR only needs enough resolution to
 *  resolve a QR code's own modules, and decoding a full-resolution
 *  `ImageData` on every animation frame is needless CPU/battery cost on a
 *  phone. */
const MAX_SCAN_WIDTH = 640

/** Opens the camera and feeds each decoded QR text to `onText`; scanning
 *  stops when it returns true. `opts.onCameraError` runs when the camera
 *  can't be opened (even if the scan was stopped meanwhile — the caller
 *  checks its own screen). `opts.stillWanted` is re-checked once the camera is
 *  granted: the screen may have moved on while the permission prompt was
 *  up (signin fix round 1, finding 5) — then, as after a `stopQrScan`, the
 *  just-granted stream is stopped and nothing is wired up. */
export async function startQrScan(
  onText: (text: string) => boolean,
  opts: { stillWanted?: () => boolean; onCameraError?: () => void } = {},
): Promise<void> {
  stopQrScan()
  const mine = generation
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch {
    opts.onCameraError?.()
    return
  }
  if (mine !== generation || (opts.stillWanted && !opts.stillWanted())) {
    stream.getTracks().forEach((t) => t.stop())
    return
  }
  scanStream = stream
  if (!videoEl) videoEl = document.createElement('video')
  videoEl.srcObject = scanStream
  videoEl.setAttribute('playsinline', 'true')
  videoEl.muted = true
  // Attach before play: autoplay on a detached WebView video can fail,
  // and camera startup resolves after the render that drew the mount.
  mountQrScanner()
  try {
    await videoEl.play()
  } catch {
    if (mine !== generation) return
    stopQrScan()
    opts.onCameraError?.()
    return
  }
  if (mine !== generation) return
  if (opts.stillWanted && !opts.stillWanted()) { stopQrScan(); return }
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const tick = (): void => {
    if (!scanStream || mine !== generation) return
    const v = videoEl
    if (v && ctx && v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
      const scale = v.videoWidth > MAX_SCAN_WIDTH ? MAX_SCAN_WIDTH / v.videoWidth : 1
      canvas.width = Math.round(v.videoWidth * scale)
      canvas.height = Math.round(v.videoHeight * scale)
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(image.data, image.width, image.height)
      if (code?.data && onText(code.data)) {
        stopQrScan()
        return
      }
    }
    scanRaf = requestAnimationFrame(tick)
  }
  scanRaf = requestAnimationFrame(tick)
}

/** Moves the persistent `<video>` element into the current render's
 *  `.qr-scan-mount`, if a scan is live and the render drew one. */
export function mountQrScanner(): void {
  if (!scanStream || !videoEl) return
  const mount = document.querySelector('.qr-scan-mount')
  if (!mount) return
  if (videoEl.parentElement !== mount) mount.appendChild(videoEl)
}

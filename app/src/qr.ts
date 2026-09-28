// QR rendering — currently signin.ts's My Signet NIP-46 `nostrconnect://`
// connect code (the old companion-rail pairing URI this module first shipped
// for is gone with rail.ts/rail-live.ts, Task 11 fix round 1). Thin wrapper
// around qrcode-generator; produces a data: URL so callers can drop it
// straight into an <img src> with no canvas/DOM dependency of its own.

import qrcode from 'qrcode-generator'

/** Renders `data` as a QR code data: URL. Type 0 = automatic size (smallest
 *  that fits the payload); 'M' error correction (15% damage tolerance) — the
 *  pairing QR is scanned off a phone or laptop screen at an angle/distance,
 *  unlike a clean static invite screen, so it needs more tolerance than the
 *  minimum. */
export function qrDataUrl(data: string, cellSize = 6, margin = 16): string {
  const qr = qrcode(0, 'M')
  qr.addData(data)
  qr.make()
  return qr.createDataURL(cellSize, margin)
}

/** Renders `data` as a ready-to-insert `<img>` tag wrapping {@link qrDataUrl}.
 *  `alt` is escaped here (an attribute-position sink) rather than at each
 *  call site — signin.ts's only caller today passes a fixed string, but
 *  escaping unconditionally here is a no-op for that case and keeps this
 *  function safe by default for any future caller that doesn't, per
 *  global-constraints "esc() every wire-derived string in innerHTML
 *  (attribute AND text positions)". */
export function qrImgTag(data: string, alt: string, cellSize = 6, margin = 16): string {
  return `<img class="qr" src="${qrDataUrl(data, cellSize, margin)}" alt="${esc(alt)}" width="256" height="256" />`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

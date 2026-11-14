// QR rendering — currently signin.ts's My Signet NIP-46 `nostrconnect://`
// connect code (the old companion-rail pairing URI this module first shipped
// for is gone with rail.ts/rail-live.ts, Task 11 fix round 1). Thin wrapper
// around @forgesworn/qr; produces a data: URL so callers can drop it
// straight into an <img src> with no canvas/DOM dependency of its own.

import { encode, toSvg } from '@forgesworn/qr'

/** Renders `data` as a QR code data: URL (an SVG, black on white). The
 *  smallest version that fits the payload is chosen automatically; 'M' error
 *  correction (15% damage tolerance) — the pairing QR is scanned off a phone
 *  or laptop screen at an angle/distance, unlike a clean static invite
 *  screen, so it needs more tolerance than the minimum.
 *
 *  `margin` is the quiet zone in whole modules. The previous encoder used a
 *  16 px border at 6 px a module (about 2.7 modules); 3 is the nearest whole
 *  number, and the standard's own minimum is 4. */
export function qrDataUrl(data: string, margin = 3): string {
  const svg = toSvg(encode(data, { ecc: 'M' }), { margin, dark: '#000', light: '#fff' })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Renders `data` as a ready-to-insert `<img>` tag wrapping {@link qrDataUrl}.
 *  `alt` is escaped here (an attribute-position sink) rather than at each
 *  call site — signin.ts's only caller today passes a fixed string, but
 *  escaping unconditionally here is a no-op for that case and keeps this
 *  function safe by default for any future caller that doesn't, per
 *  global-constraints "esc() every wire-derived string in innerHTML
 *  (attribute AND text positions)". */
export function qrImgTag(data: string, alt: string, margin = 3): string {
  return `<img class="qr" src="${qrDataUrl(data, margin)}" alt="${esc(alt)}" width="256" height="256" />`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

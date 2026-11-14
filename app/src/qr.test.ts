import { describe, it, expect } from 'vitest'
import jsQR from 'jsqr'
import { qrDataUrl, qrImgTag } from './qr.js'

// Regression test for a Phase-2 Task 10 esc() sweep finding: `alt` is an
// attribute-position sink (app.ts's onboarding "setup code" screen builds it
// from a wire/user-chosen child name — untrusted) that was previously
// interpolated raw. See qr.ts's own doc comment on `qrImgTag`.
describe('qrImgTag', () => {
  it('escapes HTML-meta characters in alt', () => {
    const tag = qrImgTag('payload', `Setup QR code for <b>"Al & Ex"</b>`)
    expect(tag).toContain('alt="Setup QR code for &lt;b&gt;&quot;Al &amp; Ex&quot;&lt;/b&gt;"')
    expect(tag).not.toContain('<b>')
  })

  it('leaves ordinary alt text untouched', () => {
    const tag = qrImgTag('payload', 'Signet pairing QR code')
    expect(tag).toContain('alt="Signet pairing QR code"')
  })

  it('still embeds a data: URL src', () => {
    const tag = qrImgTag('payload', 'alt')
    expect(tag).toMatch(/src="data:image\//)
  })
})

// Renders the SVG inside a qrDataUrl() result to pixels (the path is runs of
// `M<x> <y>h<w>v1h-<w>z` in module units) and reads it back with jsQR, the
// decoder the app scans with, so the test covers the real rendered output.
function decodeDataUrl(url: string, scale = 4): string | undefined {
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1))
  const side = Number(/viewBox="0 0 (\d+) /.exec(svg)![1])
  const px = side * scale
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255)
  for (const [, x, y, w] of svg.matchAll(/M(\d+) (\d+)h(\d+)v1/g)) {
    for (let j = 0; j < scale; j++) {
      for (let i = 0; i < Number(w) * scale; i++) {
        const o = ((Number(y) * scale + j) * px + Number(x) * scale + i) * 4
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 0
      }
    }
  }
  return jsQR(rgba, px, px)?.data
}

describe('qrDataUrl', () => {
  it('is an SVG data: URL that jsQR reads back', () => {
    const uri = `nostrconnect://${'a'.repeat(64)}?relay=${encodeURIComponent('wss://relay.example.com')}&secret=${'b'.repeat(32)}&name=Test`
    const url = qrDataUrl(uri)
    expect(url).toMatch(/^data:image\/svg\+xml/)
    expect(decodeDataUrl(url)).toBe(uri)
  })

  it('keeps a whole-module quiet zone of 3 by default', () => {
    const svg = decodeURIComponent(qrDataUrl('x').split(',')[1]!)
    expect(svg).toMatch(/M3 3h/)
  })
})

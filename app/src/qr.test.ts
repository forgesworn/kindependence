import { describe, it, expect } from 'vitest'
import { qrImgTag } from './qr.js'

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

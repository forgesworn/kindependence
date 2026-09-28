// Covers native-geo.ts's one pure seam — `shouldWatcherRun` — the decision
// `ensure()` makes about whether the continuous background watcher should be
// running (review, Task 9: watcher lifecycle tied to sharing, not
// visibility). Everything else in native-geo.ts talks to
// `@capacitor/core`/the BackgroundGeolocation plugin and isn't worth mocking
// scaffolding for — this is the part that actually encodes the decision the
// reviewer flagged, and it's plain enough to test directly.
import { describe, it, expect } from 'vitest'
import { shouldWatcherRun } from './native-geo.js'

describe('shouldWatcherRun', () => {
  it('runs when native, signed in, and in at least one circle', () => {
    expect(shouldWatcherRun(true, true, true)).toBe(true)
  })

  it('never runs on web, regardless of identity/circle state', () => {
    expect(shouldWatcherRun(false, true, true)).toBe(false)
  })

  it('does not run natively without a signed-in identity (sharing stopped: signed out)', () => {
    expect(shouldWatcherRun(true, false, true)).toBe(false)
  })

  it('does not run natively with an identity but no circles (nothing to share)', () => {
    expect(shouldWatcherRun(true, true, false)).toBe(false)
  })

  it('does not run natively with neither identity nor circles', () => {
    expect(shouldWatcherRun(true, false, false)).toBe(false)
  })
})

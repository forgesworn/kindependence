import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('camera startup in a WebView', () => {
  let video: any, mount: any, track: any, media: any
  beforeEach(() => {
    vi.resetModules()
    track = { stop: vi.fn() }
    mount = { appendChild: vi.fn((v: any) => { v.parentElement = mount }) }
    video = { parentElement: null, muted: false, setAttribute: vi.fn(), play: vi.fn(async () => {
      expect(video.parentElement).toBe(mount)
      expect(video.muted).toBe(true)
    }) }
    media = vi.fn(async () => ({ getTracks: () => [track] }))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } })
    vi.stubGlobal('document', { querySelector: () => mount, createElement: (tag: string) => tag === 'video' ? video : { getContext: () => null } })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('mounts and plays after async permission resolves without another render', async () => {
    const { startQrScan } = await import('./qr-scan.js')
    await startQrScan(() => false)
    expect(mount.appendChild).toHaveBeenCalledWith(video)
    expect(video.setAttribute).toHaveBeenCalledWith('playsinline', 'true')
    expect(video.play).toHaveBeenCalledOnce()
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
  })

  it('reports failed playback and closes the camera instead of leaving a black preview', async () => {
    const { startQrScan } = await import('./qr-scan.js')
    video.play.mockRejectedValue(new Error('autoplay blocked'))
    const onCameraError = vi.fn()
    await startQrScan(() => false, { onCameraError })
    expect(onCameraError).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('does not restart a cancelled scanner when playback resolves late', async () => {
    const { startQrScan, stopQrScan } = await import('./qr-scan.js')
    let resolvePlay!: () => void
    video.play.mockImplementation(() => new Promise<void>(r => { resolvePlay = r }))
    const pending = startQrScan(() => false)
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled())
    stopQrScan(); resolvePlay(); await pending
    expect(track.stop).toHaveBeenCalledOnce()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('ignores stale camera permission after cancelling the scan', async () => {
    const { startQrScan, stopQrScan } = await import('./qr-scan.js')
    let resolveMedia!: (v: any) => void
    media.mockImplementation(() => new Promise(r => { resolveMedia = r }))
    const pending = startQrScan(() => false)
    stopQrScan(); resolveMedia({ getTracks: () => [track] }); await pending
    expect(track.stop).toHaveBeenCalledOnce()
    expect(video.play).not.toHaveBeenCalled()
  })
})

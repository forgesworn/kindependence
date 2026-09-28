import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent, type EventTemplate } from 'nostr-tools/pure'
import * as store from './store.js'
import { guardianOfTemplate, dependantOfTemplate, unlinkTemplate } from './device-statements.js'
import {
  acceptLinkPair, acceptUnlink, linked, dependantsOf, guardiansOf, linkEvents, linkedWithMe, onLinkChange,
} from './guardian-links.js'

function fakeLocalStorage(): Storage {
  const mem = new Map<string, string>()
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size },
  } as unknown as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
})

interface Key { sk: Uint8Array; pk: string }
function key(): Key {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}
const sign = (t: EventTemplate, k: Key) => finalizeEvent(t, k.sk)

const G = key()
const D = key()
const X = key()

/** A matching guardian-of (by G) / dependant-of (by D) pair at `at`. */
function pair(g: Key, d: Key, at: number, dAt = at) {
  return { g: sign(guardianOfTemplate(d.pk, at), g), d: sign(dependantOfTemplate(g.pk, dAt), d) }
}

describe('acceptLinkPair / linked', () => {
  it('links a matching pair', () => {
    const p = pair(G, D, 100)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    expect(linked(G.pk, D.pk)).toBe(true)
    expect(linked(D.pk, G.pk)).toBe(false)
    expect(dependantsOf(G.pk)).toEqual([D.pk])
    expect(guardiansOf(D.pk)).toEqual([G.pk])
    expect(linkEvents(G.pk, D.pk)).toMatchObject({ g: { id: p.g.id }, d: { id: p.d.id } })
    expect(store.load().guardianLinks[`${G.pk}:${D.pk}`]).toBeTruthy()
  })

  it('rejects a one-sided claim (only the guardian statement)', () => {
    const p = pair(G, D, 100)
    expect(acceptLinkPair(p.g, null)).toBe(false)
    expect(acceptLinkPair(p.g, undefined)).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
    expect(linkEvents(G.pk, D.pk)).toBeNull()
  })

  it('rejects two guardian-of statements', () => {
    const g1 = sign(guardianOfTemplate(D.pk, 100), G)
    const g2 = sign(guardianOfTemplate(G.pk, 100), D)
    expect(acceptLinkPair(g1, g2)).toBe(false)
    expect(acceptLinkPair(g1, g1)).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
    expect(linked(D.pk, G.pk)).toBe(false)
  })

  it('rejects swapped roles (dependant-of signed by the guardian)', () => {
    const g = sign(guardianOfTemplate(D.pk, 100), G)
    const d = sign(dependantOfTemplate(D.pk, 100), G)
    expect(acceptLinkPair(g, d)).toBe(false)
    const p = pair(G, D, 100)
    expect(acceptLinkPair(p.d, p.g)).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
  })

  it('rejects statements about different people', () => {
    const g = sign(guardianOfTemplate(D.pk, 100), G)
    const d = sign(dependantOfTemplate(X.pk, 100), D)
    expect(acceptLinkPair(g, d)).toBe(false)
    const g2 = sign(guardianOfTemplate(X.pk, 100), G)
    const d2 = sign(dependantOfTemplate(G.pk, 100), D)
    expect(acceptLinkPair(g2, d2)).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
    expect(linked(G.pk, X.pk)).toBe(false)
  })

  it('rejects a pair with a bad signature', () => {
    const p = pair(G, D, 100)
    expect(acceptLinkPair(p.g, { ...p.d, sig: '00'.repeat(64) })).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
  })

  it('does not replace a stored pair with an older one', () => {
    const newer = pair(G, D, 300)
    const older = pair(G, D, 100)
    expect(acceptLinkPair(newer.g, newer.d)).toBe(true)
    expect(acceptLinkPair(older.g, older.d)).toBe(false)
    expect(linkEvents(G.pk, D.pk)?.g.id).toBe(newer.g.id)
    // An unlink between the two can't then break the newer link.
    expect(acceptUnlink(sign(unlinkTemplate(D.pk, 200), G))).toBe(true)
    expect(linked(G.pk, D.pk)).toBe(true)
  })
})

describe('unlinks', () => {
  it('an unlink by the guardian breaks the link', () => {
    const p = pair(G, D, 100)
    acceptLinkPair(p.g, p.d)
    expect(acceptUnlink(sign(unlinkTemplate(D.pk, 200), G))).toBe(true)
    expect(linked(G.pk, D.pk)).toBe(false)
    expect(dependantsOf(G.pk)).toEqual([])
    expect(guardiansOf(D.pk)).toEqual([])
    expect(linkEvents(G.pk, D.pk)).toBeNull()
  })

  it('an unlink by the dependant breaks the link', () => {
    const p = pair(G, D, 100)
    acceptLinkPair(p.g, p.d)
    expect(acceptUnlink(sign(unlinkTemplate(G.pk, 200), D))).toBe(true)
    expect(linked(G.pk, D.pk)).toBe(false)
  })

  it('an unlink with the same created_at as the pair wins', () => {
    const p = pair(G, D, 100)
    acceptLinkPair(p.g, p.d)
    acceptUnlink(sign(unlinkTemplate(G.pk, 100), D))
    expect(linked(G.pk, D.pk)).toBe(false)
  })

  it('an unlink older than the pair has no effect', () => {
    const p = pair(G, D, 100)
    acceptLinkPair(p.g, p.d)
    expect(acceptUnlink(sign(unlinkTemplate(D.pk, 50), G))).toBe(true)
    expect(linked(G.pk, D.pk)).toBe(true)
  })

  it('the pair must be newer than the unlink in BOTH statements', () => {
    acceptUnlink(sign(unlinkTemplate(D.pk, 200), G))
    const p = pair(G, D, 300, 150)
    expect(acceptLinkPair(p.g, p.d)).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
  })

  it('a new pair dated after the unlink links again; one dated before does not', () => {
    const first = pair(G, D, 100)
    acceptLinkPair(first.g, first.d)
    acceptUnlink(sign(unlinkTemplate(D.pk, 200), G))
    const stale = pair(G, D, 150)
    expect(acceptLinkPair(stale.g, stale.d)).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
    const fresh = pair(G, D, 300)
    expect(acceptLinkPair(fresh.g, fresh.d)).toBe(true)
    expect(linked(G.pk, D.pk)).toBe(true)
  })

  it('an unlink that arrives before the pair it predates still blocks an older pair', () => {
    acceptUnlink(sign(unlinkTemplate(G.pk, 200), D))
    const p = pair(G, D, 100)
    expect(acceptLinkPair(p.g, p.d)).toBe(false)
    expect(linked(G.pk, D.pk)).toBe(false)
  })

  it('keeps the newest unlink per signer and other', () => {
    const newer = sign(unlinkTemplate(D.pk, 200), G)
    const older = sign(unlinkTemplate(D.pk, 100), G)
    expect(acceptUnlink(newer)).toBe(true)
    expect(acceptUnlink(older)).toBe(true)
    expect(store.load().unlinks[`${G.pk}:${D.pk}`].id).toBe(newer.id)
  })

  it('rejects invalid unlinks and non-unlink statements', () => {
    const ev = sign(unlinkTemplate(D.pk, 200), G)
    expect(acceptUnlink({ ...ev, sig: '00'.repeat(64) })).toBe(false)
    expect(acceptUnlink(sign(guardianOfTemplate(D.pk, 200), G))).toBe(false)
    expect(acceptUnlink(null)).toBe(false)
    expect(store.load().unlinks).toEqual({})
  })

  it('an unlink only affects links between its own two people', () => {
    const a = pair(G, D, 100)
    const b = pair(G, X, 100)
    acceptLinkPair(a.g, a.d)
    acceptLinkPair(b.g, b.d)
    acceptUnlink(sign(unlinkTemplate(D.pk, 200), G))
    expect(linked(G.pk, D.pk)).toBe(false)
    expect(linked(G.pk, X.pk)).toBe(true)
    expect(dependantsOf(G.pk)).toEqual([X.pk])
  })
})

describe('linkedWithMe', () => {
  it('holds both ways', () => {
    const p = pair(G, D, 100)
    acceptLinkPair(p.g, p.d)
    expect(linkedWithMe(G.pk)(D.pk)).toBe(true)
    expect(linkedWithMe(D.pk)(G.pk)).toBe(true)
    expect(linkedWithMe(G.pk)(X.pk)).toBe(false)
    expect(linkedWithMe(X.pk)(G.pk)).toBe(false)
  })
})

describe('onLinkChange', () => {
  it('fires when a pair links and when an unlink breaks it, not otherwise', () => {
    const calls: Array<[string, string, boolean]> = []
    const off = onLinkChange((g, d, l) => { calls.push([g, d, l]) })
    const p = pair(G, D, 100)
    acceptLinkPair(p.g, p.d)
    expect(calls).toEqual([[G.pk, D.pk, true]])
    // A newer pair for an already-linked couple: no flip.
    const again = pair(G, D, 150)
    acceptLinkPair(again.g, again.d)
    // An older unlink: no flip.
    acceptUnlink(sign(unlinkTemplate(D.pk, 50), G))
    expect(calls).toHaveLength(1)
    acceptUnlink(sign(unlinkTemplate(G.pk, 200), D))
    expect(calls).toEqual([[G.pk, D.pk, true], [G.pk, D.pk, false]])
    // A second unlink of an already-broken link: no flip.
    acceptUnlink(sign(unlinkTemplate(D.pk, 250), G))
    expect(calls).toHaveLength(2)
    const fresh = pair(G, D, 300)
    acceptLinkPair(fresh.g, fresh.d)
    expect(calls).toEqual([[G.pk, D.pk, true], [G.pk, D.pk, false], [G.pk, D.pk, true]])
    off()
    acceptUnlink(sign(unlinkTemplate(D.pk, 400), G))
    expect(calls).toHaveLength(3)
  })

  it('reports a link in the reverse direction with its own roles', () => {
    const calls: Array<[string, string, boolean]> = []
    const off = onLinkChange((g, d, l) => { calls.push([g, d, l]) })
    const p = pair(D, G, 100) // D is the guardian of G here
    acceptLinkPair(p.g, p.d)
    acceptUnlink(sign(unlinkTemplate(D.pk, 200), G))
    expect(calls).toEqual([[D.pk, G.pk, true], [D.pk, G.pk, false]])
    off()
  })

  it('a throwing listener does not stop others or the store write', () => {
    const calls: boolean[] = []
    const off1 = onLinkChange(() => { throw new Error('boom') })
    const off2 = onLinkChange((_g, _d, l) => { calls.push(l) })
    const p = pair(G, D, 100)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    expect(calls).toEqual([true])
    expect(linked(G.pk, D.pk)).toBe(true)
    off1(); off2()
  })
})

describe('store robustness', () => {
  it('load() tolerates malformed guardianLinks / unlinks', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ v: 1, guardianLinks: 'x', unlinks: [1] }))
    const p = store.load()
    expect(p.guardianLinks).toEqual({})
    expect(p.unlinks).toEqual({})
    expect(linked(G.pk, D.pk)).toBe(false)
  })

  it('load() drops malformed entries', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({
      v: 1,
      guardianLinks: { a: { g: null, d: {} }, b: 5 },
      unlinks: { c: null, d: 'x' },
    }))
    const p = store.load()
    expect(p.guardianLinks).toEqual({})
    expect(p.unlinks).toEqual({})
  })
})

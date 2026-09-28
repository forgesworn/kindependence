import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildPinSignal, decryptPin, withPin, PIN_KINDS, PIN_KIND_LIST, isPinKind, type Pin } from './pins.js'

// Cross-app pin wire compatibility — pins against flock's OWN app/src/pin.ts,
// not kindependence's own idea of what the wire should be. Vectors were
// produced by running flock's pin.ts (copied verbatim from origin/main) against
// this repo's installed canary-kit — see ../compatibility/flock-app-pins.json's
// own `source`/`notes` for provenance and how each vector was generated.
//
// Sibling to flock-compatibility-vectors.test.ts (flock-v1.json), which mirrors
// flock-kit's own published vector set. This file is separate because pin.ts is
// an app-level flock file (not yet part of the published @forgesworn/flock kit)
// and its vectors are NOT flock-kit's own — mixing the two provenances into one
// fixture would muddy where each vector actually came from.
const vectorsPath = fileURLToPath(new URL('../compatibility/flock-app-pins.json', import.meta.url))
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'))

function tagValue(event: { tags: string[][] }, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1]
}

function applySequence(pins: Record<string, Pin>, keys: string[]): { list: Pin[] | undefined; prev: Pin[] | undefined } {
  let list: Pin[] | undefined
  let prev: Pin[] | undefined
  for (const key of keys) {
    prev = list
    list = withPin(list, pins[key])
  }
  return { list, prev }
}

interface MergeCase {
  name: string
  sequence?: string[]
  startSequence?: string[]
  incoming?: string
  expectSameRef?: boolean
  expectedLength?: number
  expectedFindId?: string
  expectedRemoved?: boolean
  expectedGeohash?: string
  expectedFrom?: string
}

describe('Flock app (pin.ts) compatibility vectors', () => {
  it('matches flock’s fixed kind vocabulary exactly, including key order (the picker order)', () => {
    expect(PIN_KIND_LIST).toEqual(vectors.kindVocabulary.order)
    expect(PIN_KINDS).toEqual(vectors.kindVocabulary.kinds)
    for (const k of vectors.kindVocabulary.order) expect(isPinKind(k)).toBe(true)
  })

  it('builds a drop signal with flock’s exact event kind + signal type, decrypting back to the same payload', async () => {
    const v = vectors.signal.drop
    const event = await buildPinSignal(v.params)
    expect({ kind: event.kind, signalType: tagValue(event, 't') }).toEqual(v.expectedEvent)
    expect(await decryptPin(v.params.seedHex, event.content)).toEqual(v.expectedDecoded)
  })

  it('decrypts flock’s own drop ciphertext (produced by flock’s pin.ts + canary-kit) exactly', async () => {
    const v = vectors.signal.drop
    expect(await decryptPin(v.params.seedHex, v.content)).toEqual(v.expectedDecoded)
  })

  it('builds and decrypts flock’s own tombstone signal/ciphertext exactly (removed:true)', async () => {
    const v = vectors.signal.tombstone
    const event = await buildPinSignal(v.params)
    expect({ kind: event.kind, signalType: tagValue(event, 't') }).toEqual(v.expectedEvent)
    expect(await decryptPin(v.params.seedHex, event.content)).toEqual(v.expectedDecoded)
    expect(await decryptPin(v.params.seedHex, v.content)).toEqual(v.expectedDecoded)
  })

  it('decrypts flock-produced ciphertext for every vocabulary kind', async () => {
    for (const vec of vectors.decrypt.kindRoundTrip) {
      expect(await decryptPin(vectors.decrypt.seedHex, vec.content), vec.kind).toEqual(vec.expected)
    }
  })

  describe('merge / tombstone / anti-resurrection (withPin, flock’s d569b17 final form)', () => {
    const pins: Record<string, Pin> = vectors.merge.pins
    for (const c of vectors.merge.cases as MergeCase[]) {
      it(c.name, () => {
        const keys = c.sequence ?? [...(c.startSequence ?? []), c.incoming as string]
        const { list, prev } = applySequence(pins, keys)
        if (c.expectSameRef) expect(list).toBe(prev)
        if (c.expectedLength !== undefined) expect(list).toHaveLength(c.expectedLength)
        if (c.expectedFindId) {
          const entry = list?.find((p) => p.id === c.expectedFindId)
          if (c.expectedRemoved !== undefined) expect(entry?.removed ?? false).toBe(c.expectedRemoved)
          if (c.expectedGeohash) expect(entry?.geohash).toBe(c.expectedGeohash)
          if (c.expectedFrom) expect(entry?.from).toBe(c.expectedFrom)
        }
      })
    }
  })

  // Flock's pin.ts (6bea625, "pin durability — re-broadcast authored pins on
  // presence") added ONE new wire-adjacent export: authoredPins(list, pk) — a
  // pure selection of the pins whose latest held state a given pubkey
  // authored, used to build the anti-entropy re-send set. authoredPins itself
  // never touches the wire (it only *selects* which already-valid Pin objects
  // get re-published through the ordinary buildPinSignal/publish path), so
  // this is a LOCAL-ONLY difference, not a wire compatibility gap.
  //
  // Kindependence's pins.ts implements the same selection (`p.from ===
  // self.identityPk`) inline inside its unexported `resendAuthoredPins`, wired
  // to circles.ts's `registerMemberAddedHandler` (fires on a verified roster
  // addition) rather than flock's presence-announce trigger — see pins.ts's
  // own "Fix round 2" doc comment. There is no exported `authoredPins`
  // equivalent to call directly here; the equivalent behaviour is already
  // exercised in pins.test.ts's "pins.ts wiring — resendAuthoredPins fires on
  // a genuine roster addition" suite. Left as todo rather than deleted so the
  // API-shape gap stays visible if flock's pin.ts durability trigger ever
  // becomes wire-visible.
  it.todo(
    'authoredPins anti-entropy re-send selection (flock 6bea625) has no exported pins.ts equivalent to vector directly — local-only, not wire-affecting (see pins.test.ts resendAuthoredPins coverage)',
  )

  describe('invalid payloads flock rejects', () => {
    for (const v of vectors.invalid.decryptRejects) {
      it(`decryptPin rejects: ${v.name}`, async () => {
        await expect(decryptPin(vectors.invalid.seedHex, v.content)).rejects.toThrow(new RegExp(v.errorMatch, 'i'))
      })
    }

    it('decryptPin rejects flock’s own ciphertext under the wrong seed', async () => {
      const v = vectors.invalid.decryptRejectsWrongSeed
      await expect(decryptPin(v.wrongSeedHex, v.content)).rejects.toThrow()
    })

    for (const v of vectors.invalid.buildPinSignalRejects) {
      it(`buildPinSignal rejects: ${v.name}`, async () => {
        await expect(buildPinSignal(v.params)).rejects.toThrow()
      })
    }
  })
})

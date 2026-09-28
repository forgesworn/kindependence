import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decryptBeacon, decryptDuressAlert, deriveBeaconKey, deriveDuressKey } from 'canary-kit'
import { classifyContainment } from '@forgesworn/flock/geofence'
import { decideEmission } from '@forgesworn/flock/policy'
import { signalTypeForReason, buildLocationSignal, buildHelpSignal } from '@forgesworn/flock/signals'
import { buildBuzzSignal, decryptBuzz } from '@forgesworn/flock/buzz'
import { buildFindPingSignal, decryptFindPing } from '@forgesworn/flock/findping'
import { buildJoinedSignal, decryptJoined } from '@forgesworn/flock/joined'
import { noReportPolicyAt } from '@forgesworn/flock/noreport'

const vectorsPath = fileURLToPath(new URL('../compatibility/flock-v1.json', import.meta.url))
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'))

function tagValue(event: { tags: string[][] }, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1]
}

describe('Flock compatibility vectors', () => {
  it('preserves geofence classifications', () => {
    for (const vector of vectors.geofence) {
      expect(
        classifyContainment(vector.point, vector.accuracyMetres, vector.fences),
        vector.name,
      ).toBe(vector.expected)
    }
  })

  it('preserves disclosure policy decisions', () => {
    for (const vector of vectors.policy) {
      expect(decideEmission(vector.context), vector.name).toEqual(vector.expected)
    }
  })

  it('preserves signal tags and decrypted payload semantics', async () => {
    for (const [reason, expected] of Object.entries(vectors.signals.reasonMap)) {
      expect(signalTypeForReason(reason as never), reason).toBe(expected)
    }

    const location = await buildLocationSignal(vectors.signals.location.params)
    expect({ kind: location.kind, signalType: tagValue(location, 't') }).toEqual(
      vectors.signals.location.expectedEvent,
    )
    const beacon = await decryptBeacon(
      deriveBeaconKey(vectors.signals.location.params.seedHex),
      location.content,
    )
    expect({ geohash: beacon.geohash, precision: beacon.precision }).toEqual(
      vectors.signals.location.expectedPayload,
    )

    const help = await buildHelpSignal(vectors.signals.help.params)
    expect({ kind: help.kind, signalType: tagValue(help, 't') }).toEqual(
      vectors.signals.help.expectedEvent,
    )
    const alert = await decryptDuressAlert(
      deriveDuressKey(vectors.signals.help.params.seedHex),
      help.content,
    )
    expect({
      type: alert.type,
      member: alert.member,
      geohash: alert.geohash,
      locationSource: alert.locationSource,
      scope: alert.scope,
      originGroupId: alert.originGroupId,
    }).toEqual(vectors.signals.help.expectedPayload)
  })

  it('preserves buzz wire semantics', async () => {
    const event = await buildBuzzSignal(vectors.buzz.params)
    expect({ kind: event.kind, signalType: tagValue(event, 't') }).toEqual(vectors.buzz.expectedEvent)
    expect(await decryptBuzz(vectors.buzz.params.seedHex, event.content)).toEqual(vectors.buzz.expectedPayload)
  })

  it('preserves find-ping wire semantics', async () => {
    const event = await buildFindPingSignal(vectors.findping.params)
    expect({ kind: event.kind, signalType: tagValue(event, 't') }).toEqual(vectors.findping.expectedEvent)
    expect(await decryptFindPing(vectors.findping.params.seedHex, event.content)).toEqual(vectors.findping.expectedPayload)
  })

  it('preserves joined wire semantics', async () => {
    const event = await buildJoinedSignal(vectors.joined.params)
    expect({ kind: event.kind, signalType: tagValue(event, 't') }).toEqual(vectors.joined.expectedEvent)
    expect(await decryptJoined(vectors.joined.params.seedHex, event.content)).toEqual(vectors.joined.expectedPayload)
  })

  it('preserves no-report fail-safe policy', () => {
    for (const vector of vectors.noreport) {
      expect(
        noReportPolicyAt(vector.point, vector.zones, vector.accuracyMetres),
        vector.name,
      ).toBe(vector.expected)
    }
  })
})

import type { Persisted } from './store.js'
import * as store from './store.js'
import { currentSession } from './session.js'
import { memberPositions } from './beacons.js'
import { decode as decodeGeohash } from 'geohash-kit'
import { haversineMetres } from '@forgesworn/flock/geofence'
import { notify } from './notify.js'
import { recordActivity } from './activity.js'

export interface GuardianWarning { id: string; circleId: string; memberPk: string; at: number; title: string; kind: 'agreement-status' | 'window-missed' }

/** Missing confirmation is a local observation, never a report of the
 * dependant's whereabouts. It still works when their phone has gone flat. */
export function guardianWarnings(p: Persisted, guardianPk: string, now: number, remember?: (id: string, at: number) => void): GuardianWarning[] {
  const warnings: GuardianWarning[] = []
  const date = new Date(now * 1000)
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000
  for (const circle of p.circles) {
    if (!circle.members.some(m => m.pk === guardianPk && m.role === 'guardian')) continue
    for (const member of circle.members.filter(m => m.role === 'child')) {
      const name = member.name || 'Your dependant'
      for (const record of p.agreements) {
        if (record.agreement.circleId !== circle.id || record.agreement.child !== member.pk || record.status === 'arrived' || record.agreement.byUnix > now) continue
        warnings.push({ id: `watch-agreement-${record.agreement.id}-${record.agreement.byUnix}`, circleId: circle.id, memberPk: member.pk, at: record.agreement.byUnix, title: `No arrival confirmation from ${name}. Check with them.`, kind: 'agreement-status' })
      }
      for (const place of p.places[circle.id] ?? []) {
        for (const window of place.arrivalWindows ?? []) {
          if (!window.enabled || !window.days.includes(date.getDay())) continue
          const match = /^(\d{2}):(\d{2})$/.exec(window.arriveBy)
          if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) continue
          const due = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Number(match[1]), Number(match[2])).getTime() / 1000 + window.graceMin * 60
          const confirmationId = `watch-window-${circle.id}-${member.pk}-${place.id}-${window.id}-${midnight}`
          const position = memberPositions(circle.id).get(member.pk)
          let located = false
          if (position && now - position.at <= 120 && position.at >= midnight) {
            try {
              const cell = decodeGeohash(position.geohash)
              const edge = { lat: cell.lat + cell.error.lat, lon: cell.lon + cell.error.lon }
              located = haversineMetres(cell, place.centre) + haversineMetres(cell, edge) <= place.radiusMetres
            } catch { /* a coarse/invalid cell cannot confirm arrival */ }
          }
          if (located && !p.settings.guardianWindowConfirmations?.[confirmationId]) remember?.(confirmationId, position!.at)
          const confirmed = located || !!p.settings.guardianWindowConfirmations?.[confirmationId] || p.activity.some(e => e.kind === 'arrival' && e.circleId === circle.id && e.actorPk === member.pk && e.at >= midnight && e.at <= now && e.params.place === place.name)
          if (confirmed || now < due) continue
          warnings.push({ id: confirmationId, circleId: circle.id, memberPk: member.pk, at: due, title: `No arrival confirmation for ${name} at ${place.name}. Check with them.`, kind: 'window-missed' })
        }
      }
    }
  }
  return warnings
}

export function checkGuardianDeadlines(): void {
  const self = currentSession()
  if (!self) return
  const now = Math.floor(Date.now() / 1000)
  for (const warning of guardianWarnings(store.load(), self.identityPk, now, (id, at) => {
    store.update(p => { p.settings.guardianWindowConfirmations = { ...Object.fromEntries(Object.entries(p.settings.guardianWindowConfirmations ?? {}).filter(([, t]) => now - t < 2 * 86400)), [id]: at } })
  })) {
    const inserted = recordActivity({ id: warning.id, at: now, kind: warning.kind, circleId: warning.circleId, actorPk: warning.memberPk, params: { status: 'unconfirmed' } })
    if (inserted) void notify('deadline-unconfirmed', warning.memberPk, warning.title, 'The dependant’s phone may be offline. This phone has not received an arrival confirmation.')
  }
}

let started = false
export function ensure(): void {
  if (started) return
  started = true
  // Allow cold-start relay catch-up before the first local assessment.
  setTimeout(checkGuardianDeadlines, 60_000)
  setInterval(checkGuardianDeadlines, 60_000)
}

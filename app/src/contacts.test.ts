import { describe, it, expect, afterEach } from 'vitest'
import {
  setContactsSource,
  snapshot,
  contactTier,
  usable,
  known,
  classifyUpdate,
  candidates,
  type Contact,
  type ContactsSnapshot,
} from './contacts.js'
import { fakeContacts } from './test-support/fake-contacts.js'

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)
const PK_C = 'c'.repeat(64)
const noLink = () => false
const linked = (which: string) => (pk: string) => pk === which

function contact(o: Partial<Contact> & { contactId: string; pks: string[]; name: string }): Contact {
  return { blocked: false, ...o }
}

afterEach(() => {
  setContactsSource(null)
})

describe('snapshot with no source', () => {
  it('is the never-paired default', () => {
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
  })
})

describe('usable', () => {
  const s: ContactsSnapshot = {
    status: 'connected',
    contacts: [
      contact({ contactId: 'kin1', pks: [PK_A], name: 'Kin', tier: 'kin' }),
      contact({ contactId: 'kith1', pks: [PK_B], name: 'Kith', tier: 'kith' }),
      contact({ contactId: 'ken1', pks: [PK_C], name: 'Ken', tier: 'ken' }),
    ],
    fresh: true,
    at: 1000,
  }

  it('kin is usable', () => {
    expect(usable(s, PK_A, noLink)).toBe(true)
  })

  it('kith is usable', () => {
    expect(usable(s, PK_B, noLink)).toBe(true)
  })

  it('ken is not usable', () => {
    expect(usable(s, PK_C, noLink)).toBe(false)
  })

  it('none tier is not usable', () => {
    const withNone: ContactsSnapshot = {
      ...s,
      contacts: [...s.contacts, contact({ contactId: 'none1', pks: ['d'.repeat(64)], name: 'None', tier: 'none' })],
    }
    expect(usable(withNone, 'd'.repeat(64), noLink)).toBe(false)
  })

  it('missing tier is not usable ("absence is not Ken")', () => {
    const missing: ContactsSnapshot = {
      ...s,
      contacts: [...s.contacts, contact({ contactId: 'no-tier', pks: ['e'.repeat(64)], name: 'NoTier' })],
    }
    expect(usable(missing, 'e'.repeat(64), noLink)).toBe(false)
  })

  it('blocked kin is not usable', () => {
    const blocked: ContactsSnapshot = {
      ...s,
      contacts: [contact({ contactId: 'kin1', pks: [PK_A], name: 'Kin', tier: 'kin', blocked: true })],
    }
    expect(usable(blocked, PK_A, noLink)).toBe(false)
  })

  it('a not-present pk is not usable', () => {
    expect(usable(s, 'f'.repeat(64), noLink)).toBe(false)
  })

  describe('link overrides', () => {
    it('a guardian link makes a pk usable even with no contact record', () => {
      expect(usable(s, 'f'.repeat(64), linked('f'.repeat(64)))).toBe(true)
    })

    it('a guardian link makes a pk usable even if blocked', () => {
      const blocked: ContactsSnapshot = {
        ...s,
        contacts: [contact({ contactId: 'kin1', pks: [PK_A], name: 'Kin', tier: 'kin', blocked: true })],
      }
      expect(usable(blocked, PK_A, linked(PK_A))).toBe(true)
    })
  })
})

describe('two identities in one contact', () => {
  // The same real person can appear as more than one raw contact record
  // sharing a contactId, each with its own tier — see contacts.ts's own doc
  // comment on classifyUpdate/candidates for why.
  it('one pk moving to ken drops only that pk; the other stays usable', () => {
    const prev: ContactsSnapshot = {
      status: 'connected',
      contacts: [contact({ contactId: 'c1', pks: [PK_A, PK_B], name: 'Ann', tier: 'kin' })],
      fresh: true,
      at: 1000,
    }
    const next: ContactsSnapshot = {
      status: 'connected',
      contacts: [
        contact({ contactId: 'c1', pks: [PK_B], name: 'Ann', tier: 'kin' }),
        contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'ken' }),
      ],
      fresh: true,
      at: 2000,
    }
    expect(usable(prev, PK_A, noLink)).toBe(true)
    expect(usable(prev, PK_B, noLink)).toBe(true)
    expect(usable(next, PK_A, noLink)).toBe(false)
    expect(usable(next, PK_B, noLink)).toBe(true)

    const result = classifyUpdate(prev, next, [PK_A, PK_B])
    expect(result).toEqual({ dropped: [PK_A], absent: [], bulk: false, unknown: false })
  })
})

describe('classifyUpdate', () => {
  const prev: ContactsSnapshot = {
    status: 'connected',
    contacts: [
      contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'kin' }),
      contact({ contactId: 'c2', pks: [PK_B], name: 'Bo', tier: 'kith' }),
    ],
    fresh: true,
    at: 1000,
  }

  it('explicit ken drops', () => {
    const next: ContactsSnapshot = {
      ...prev,
      contacts: [contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'ken' }), prev.contacts[1]],
    }
    expect(classifyUpdate(prev, next, [PK_A])).toEqual({ dropped: [PK_A], absent: [], bulk: false, unknown: false })
  })

  it('explicit none drops', () => {
    const next: ContactsSnapshot = {
      ...prev,
      contacts: [contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'none' }), prev.contacts[1]],
    }
    expect(classifyUpdate(prev, next, [PK_A])).toEqual({ dropped: [PK_A], absent: [], bulk: false, unknown: false })
  })

  it('blocked drops', () => {
    const next: ContactsSnapshot = {
      ...prev,
      contacts: [contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'kin', blocked: true }), prev.contacts[1]],
    }
    expect(classifyUpdate(prev, next, [PK_A])).toEqual({ dropped: [PK_A], absent: [], bulk: false, unknown: false })
  })

  it('absent (no contact holds the pk any more) is reported as absent, not dropped', () => {
    const next: ContactsSnapshot = { ...prev, contacts: [prev.contacts[1]] }
    expect(classifyUpdate(prev, next, [PK_A])).toEqual({ dropped: [], absent: [PK_A], bulk: false, unknown: false })
  })

  it('two explicit drops in one update is bulk', () => {
    const next: ContactsSnapshot = {
      ...prev,
      contacts: [
        contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'ken' }),
        contact({ contactId: 'c2', pks: [PK_B], name: 'Bo', tier: 'ken' }),
      ],
    }
    const result = classifyUpdate(prev, next, [PK_A, PK_B])
    expect(result.dropped.sort()).toEqual([PK_A, PK_B].sort())
    expect(result.bulk).toBe(true)
    expect(result.unknown).toBe(false)
  })

  it('disconnected reports unknown with no drops', () => {
    const next: ContactsSnapshot = { ...prev, status: 'disconnected' }
    expect(classifyUpdate(prev, next, [PK_A])).toEqual({ dropped: [], absent: [], bulk: false, unknown: true })
  })

  it('truncated reports unknown with no drops', () => {
    const next: ContactsSnapshot = { ...prev, truncated: true }
    expect(classifyUpdate(prev, next, [PK_A])).toEqual({ dropped: [], absent: [], bulk: false, unknown: true })
  })

  it('emptied-out (non-empty to empty) reports unknown with no drops', () => {
    const next: ContactsSnapshot = { ...prev, contacts: [] }
    expect(classifyUpdate(prev, next, [PK_A])).toEqual({ dropped: [], absent: [], bulk: false, unknown: true })
  })

  it('a pk not usable in prev is ignored even if it looks dropped in next', () => {
    const prevWithKen: ContactsSnapshot = {
      ...prev,
      contacts: [...prev.contacts, contact({ contactId: 'c3', pks: [PK_C], name: 'Cy', tier: 'ken' })],
    }
    const next: ContactsSnapshot = {
      ...prevWithKen,
      contacts: [...prevWithKen.contacts.slice(0, 2), contact({ contactId: 'c3', pks: [PK_C], name: 'Cy', tier: 'none' })],
    }
    expect(classifyUpdate(prevWithKen, next, [PK_C])).toEqual({ dropped: [], absent: [], bulk: false, unknown: false })
  })
})

describe('known', () => {
  it('is false with no source paired', () => {
    expect(known({ status: 'none', contacts: [], fresh: false, at: 0 })).toBe(false)
  })

  it('is true when connected, even with no contacts yet', () => {
    expect(known({ status: 'connected', contacts: [], fresh: true, at: 1 })).toBe(true)
  })

  it('is true with contacts present regardless of status', () => {
    expect(known({ status: 'disconnected', contacts: [contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'kin' })], fresh: false, at: 1 })).toBe(true)
  })

  it('a revocation that empties contacts and disconnects is not known', () => {
    expect(known({ status: 'disconnected', contacts: [], fresh: false, at: 1 })).toBe(false)
  })
})

describe('candidates', () => {
  const s: ContactsSnapshot = {
    status: 'connected',
    contacts: [
      contact({ contactId: 'c1', pks: [PK_A], name: 'Zoe', tier: 'kin' }),
      contact({ contactId: 'c2', pks: [PK_B], name: 'Amir', tier: 'kith' }),
      contact({ contactId: 'c3', pks: [PK_C], name: 'Ken', tier: 'ken' }),
      contact({ contactId: 'c4', pks: ['d'.repeat(64)], name: 'None', tier: 'none' }),
      contact({ contactId: 'c5', pks: ['e'.repeat(64)], name: 'Blocked', tier: 'kin', blocked: true }),
    ],
    fresh: true,
    at: 1,
  }

  it('groups by tier, sorts usable by name, excludes none/blocked from both lists', () => {
    const result = candidates(s, new Set())
    expect(result.usable.map((c) => c.name)).toEqual(['Amir', 'Zoe'])
    expect(result.kens.map((c) => c.name)).toEqual(['Ken'])
  })

  it('excludes members already on the roster', () => {
    const result = candidates(s, new Set([PK_A]))
    expect(result.usable.map((c) => c.name)).toEqual(['Amir'])
  })

  it('a contactId whose every pk is excluded is left out entirely', () => {
    const multi: ContactsSnapshot = {
      ...s,
      contacts: [
        ...s.contacts,
        contact({ contactId: 'c1', pks: [PK_A], name: 'Zoe', tier: 'kin' }),
      ],
    }
    // c1 has two records, both keyed on PK_A — excluding PK_A drops the whole group.
    const result = candidates(multi, new Set([PK_A]))
    expect(result.usable.some((c) => c.contactId === 'c1')).toBe(false)
  })
})

describe('contactTier / snapshot via a fake source', () => {
  it('reads through setContactsSource', () => {
    const fake = fakeContacts({ status: 'connected', contacts: [contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'kin' })] })
    setContactsSource(fake)
    expect(snapshot().status).toBe('connected')
    expect(contactTier(snapshot(), PK_A)).toEqual({ tier: 'kin', blocked: false, present: true, name: 'Ann' })
  })

  it('notifies onContactsUpdate subscribers synchronously with prev/next', async () => {
    const { onContactsUpdate } = await import('./contacts.js')
    const fake = fakeContacts({ status: 'connected', contacts: [] })
    setContactsSource(fake)
    let seen: [ContactsSnapshot, ContactsSnapshot] | null = null
    const unsub = onContactsUpdate((next, prev) => {
      seen = [next, prev]
    })
    fake.set({ contacts: [contact({ contactId: 'c1', pks: [PK_A], name: 'Ann', tier: 'kin' })] })
    expect(seen).not.toBeNull()
    expect(seen![0].contacts).toHaveLength(1)
    expect(seen![1].contacts).toHaveLength(0)
    unsub()
  })
})

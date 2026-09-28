// Fake `ContactsSource` (plan 2, Task 1) — every other module's tests drive
// contacts through this instead of the real signet-contacts grant
// (contacts-grant.ts, Task 2). `set()` calls `onUpdate` subscribers
// synchronously, so a test can assert on the app's reaction right after
// calling it, with no need to await a tick.

import type { ContactsSnapshot, ContactsSource } from '../contacts.js'

export function fakeContacts(initial?: Partial<ContactsSnapshot>): ContactsSource & { set(next: Partial<ContactsSnapshot>): void } {
  let snap: ContactsSnapshot = {
    status: 'none',
    contacts: [],
    fresh: false,
    at: 0,
    ...initial,
  }
  const subs = new Set<(s: ContactsSnapshot) => void>()
  return {
    current() {
      return snap
    },
    onUpdate(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    set(next) {
      snap = { ...snap, ...next }
      for (const cb of subs) cb(snap)
    },
  }
}

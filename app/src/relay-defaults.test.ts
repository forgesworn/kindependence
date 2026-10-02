import { describe, it, expect } from 'vitest'
import { parseRelayList, PUBLIC_RELAYS, DEFAULT_RELAYS, relaysFromSettings } from './relay-defaults.js'

describe('relay-defaults', () => {
  it('parses a comma-separated list, trimming and dropping empties', () => {
    expect(parseRelayList(' wss://a.example , ,wss://b.example,')).toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('treats non-strings and blank strings as no list', () => {
    expect(parseRelayList(undefined)).toEqual([])
    expect(parseRelayList(42)).toEqual([])
    expect(parseRelayList('  , ')).toEqual([])
  })

  it('defaults to the public relays when VITE_DEFAULT_RELAY is unset', () => {
    expect([...DEFAULT_RELAYS]).toEqual([...PUBLIC_RELAYS])
    expect([...PUBLIC_RELAYS]).toEqual(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'])
  })

  it('a user relay wins as the only relay; empty string falls back to defaults', () => {
    expect(relaysFromSettings({ relayUrl: 'wss://mine.example' })).toEqual(['wss://mine.example'])
    expect(relaysFromSettings({ relayUrl: '' })).toEqual([...DEFAULT_RELAYS])
    expect(relaysFromSettings({})).toEqual([...DEFAULT_RELAYS])
  })
})

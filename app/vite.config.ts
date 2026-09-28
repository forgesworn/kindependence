/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// kindependence PWA — thin app shell over roost-kit/covey-kit and the local BROOD module. No
// framework: render-on-state vanilla TS (see src/app.ts), same idiom as
// flock's app/.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    passWithNoTests: true,
  },
})

import type { EclipseHubApi } from '../preload/index'

declare global {
  interface Window {
    eclipseHub: EclipseHubApi
  }
}

export {}

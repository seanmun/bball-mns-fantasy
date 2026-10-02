import type { Sport } from '../types/leagueConfig'

// Sport-specific branding. Everything UI-facing that would change if
// this deployment played a different sport lives on the sport adapter
// (src/lib/sport); components read from this object, never from string
// literals scattered through the codebase.
export interface Branding {
  identity: {
    appName: string
    shortName: string
    longName: string
    tagline: string
    sport: Sport
    seasonLabel: string
  }
  assets: {
    logo: string
    favicon: string
    ogImage: string
    appleTouchIcon: string
    heroVideoDesktop: string
    heroVideoMobile: string
    hinkieFolder: string
    prizePoolFolder: string
  }
  colors: {
    accent: string
    accentLight: string
    accentDark: string
    background: string
    card: string
    hover: string
    danger: string
    warning: string
  }
  footer: {
    copyright: string
    links: Array<{ label: string; href: string }>
  }
  platform: {
    parentUrl: string
    appUrl: string
    supportEmail: string
  }
}

export { sport as sportAdapter } from './sport/index'
import { sport } from './sport/index'
export const branding: Branding = sport.branding

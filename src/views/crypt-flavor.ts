// Flavor text for the crypt/sepulcher/thing
import { flavorLabel } from './flavor'

export const CRYPT_LINES: readonly string[] = [
  'GAZE UPON THE EXALTED, THE AMBITIOUS, THE DISGRACED',
  'DISTURB NOT THEIR HALLOWED REPOSE',
  'MEDITATE UPON THY TRIUMPHS',
  'CONTEMPLATE THY TRIBULATIONS',
]

export function pickCryptLine(): string {
  return flavorLabel(CRYPT_LINES)
}

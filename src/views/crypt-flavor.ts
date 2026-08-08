// Flavor text for the crypt/sepulcher/thing

export const CRYPT_LINES: readonly string[] = [
  'GAZE UPON THE EXALTED, THE AMBITIOUS, THE DISGRACED',
  'DISTURB NOT THEIR HALLOWED REPOSE',
  'MEDITATE UPON THY TRIUMPHS',
  'CONTEMPLATE THY TRIBULATIONS',
  'O TRAVELER, BASK IN THY GLORY',
]

// Rolled once per open, never during re-renders.
export function pickCryptLine(): string {
  return CRYPT_LINES[Math.floor(Math.random() * CRYPT_LINES.length)]!
}

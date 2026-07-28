// Rolled once when the view mounts, never during re-renders.
// Used only for consequence-free actions; consent-bearing actions
// (Update, Finish, etc.) always use literal labels.
// Weighting is represented by repeating entries in each pool.

export const SPECTATE_LABELS: readonly string[] = [
  'Spectate', 'Spectate', 'Spectate', 'Spectate', 'Spectate',
  'Gander', 'Behold', 'Lurk', 'Gawk', 'Observe', 'Surveil',
  'Witness',
]

export function flavorLabel(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]!
}

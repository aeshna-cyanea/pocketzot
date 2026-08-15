// Vite's BASE_URL always starts and ends with '/'. Production normally lives
// at the origin root, but GitHub project Pages serves under /<repository>/.
// Keep same-origin runtime fetches and generated DOM URLs under that scope.
const BASE_URL = import.meta.env.BASE_URL || '/'

export const APP_BASE_PATH = BASE_URL === '/' ? '' : BASE_URL.replace(/\/$/, '')

export function appPath(path: string): string {
  return APP_BASE_PATH + (path.startsWith('/') ? path : `/${path}`)
}

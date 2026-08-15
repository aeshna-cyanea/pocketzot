// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindZoomDrag, clampMapZoom, MAX_MAP_ZOOM, MIN_MAP_ZOOM, zoomFromDrag,
} from './zoom-gesture'

function pointer(
  el: HTMLElement,
  type: string,
  init: Partial<PointerEvent> & { timeStamp?: number } = {},
): void {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(e, {
    button: { value: init.button ?? 0 },
    isPrimary: { value: init.isPrimary ?? true },
    pointerId: { value: init.pointerId ?? 1 },
    clientX: { value: init.clientX ?? 20 },
    clientY: { value: init.clientY ?? 20 },
    timeStamp: { value: init.timeStamp ?? 100 },
  })
  el.dispatchEvent(e)
}

afterEach(() => { document.body.innerHTML = '' })

describe('continuous map zoom math', () => {
  it('maps downward travel to zoom-in and upward travel to zoom-out', () => {
    expect(zoomFromDrag(1, 120)).toBeCloseTo(Math.SQRT2)
    expect(zoomFromDrag(1, -240)).toBeCloseTo(0.5)
    expect(zoomFromDrag(2, -240)).toBeCloseTo(1)
  })

  it('clamps zoom to the supported range', () => {
    expect(clampMapZoom(0.1)).toBe(MIN_MAP_ZOOM)
    expect(clampMapZoom(9)).toBe(MAX_MAP_ZOOM)
  })
})

describe('double-tap-hold zoom gesture', () => {
  function setup() {
    const host = document.createElement('div')
    const map = document.createElement('div')
    map.id = 'map-grid'
    host.appendChild(map)
    document.body.appendChild(host)
    let scale = 1
    const setScale = vi.fn((next: number) => { scale = next })
    const binding = bindZoomDrag(host, {
      enabled: () => true,
      acceptsTarget: target => target instanceof Element && !!target.closest('#map-grid'),
      getScale: () => scale,
      setScale,
    })
    return { host, map, setScale, binding, scale: () => scale }
  }

  it('zooms continuously when the held second tap moves vertically', () => {
    const h = setup()
    pointer(h.map, 'pointerdown', { timeStamp: 100, clientY: 100 })
    pointer(h.map, 'pointerup', { timeStamp: 120, clientY: 100 })
    pointer(h.map, 'pointerdown', { timeStamp: 220, clientY: 100 })
    pointer(h.map, 'pointermove', { timeStamp: 240, clientY: 160 })
    expect(h.setScale).toHaveBeenCalledOnce()
    expect(h.scale()).toBeCloseTo(2 ** 0.25)
    pointer(h.map, 'pointermove', { timeStamp: 250, clientY: 220 })
    expect(h.scale()).toBeCloseTo(Math.SQRT2)
  })

  it('zooms out from the default view when the held second tap moves up', () => {
    const h = setup()
    pointer(h.map, 'pointerdown', { timeStamp: 100, clientY: 300 })
    pointer(h.map, 'pointerup', { timeStamp: 120, clientY: 300 })
    pointer(h.map, 'pointerdown', { timeStamp: 220, clientY: 300 })
    pointer(h.map, 'pointermove', { timeStamp: 240, clientY: 180 })
    expect(h.scale()).toBeCloseTo(1 / Math.SQRT2)
    pointer(h.map, 'pointermove', { timeStamp: 250, clientY: 60 })
    expect(h.scale()).toBeCloseTo(0.5)
  })

  it('does nothing for a quick double tap without a held drag', () => {
    const h = setup()
    pointer(h.map, 'pointerdown', { timeStamp: 100 })
    pointer(h.map, 'pointerup', { timeStamp: 120 })
    pointer(h.map, 'pointerdown', { timeStamp: 220 })
    pointer(h.map, 'pointerup', { timeStamp: 240 })
    expect(h.setScale).not.toHaveBeenCalled()
    expect(h.scale()).toBe(1)
  })

  it('rejects late, distant, secondary-finger, and off-map taps', () => {
    const h = setup()
    pointer(h.map, 'pointerdown', { timeStamp: 100, clientX: 10 })
    pointer(h.map, 'pointerdown', { timeStamp: 450, clientX: 10 })
    pointer(h.map, 'pointermove', { timeStamp: 460, clientY: 100 })
    pointer(h.map, 'pointerdown', { timeStamp: 500, clientX: 100 })
    pointer(h.map, 'pointerdown', { timeStamp: 600, clientX: 100, isPrimary: false })
    pointer(h.host, 'pointerdown', { timeStamp: 700 })
    expect(h.setScale).not.toHaveBeenCalled()
  })

  it('can be cancelled when a multi-touch gesture begins', () => {
    const h = setup()
    pointer(h.map, 'pointerdown', { timeStamp: 100, clientY: 100 })
    pointer(h.map, 'pointerdown', { timeStamp: 200, clientY: 100 })
    h.binding.cancel()
    pointer(h.map, 'pointermove', { timeStamp: 220, clientY: 180 })
    expect(h.setScale).not.toHaveBeenCalled()
  })
})

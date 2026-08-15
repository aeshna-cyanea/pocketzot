// Continuous user zoom shared by the ASCII and tile map renderers. Normal
// play starts at 1x; 0.5x provides the broad level overview that is the
// gesture's primary use case, while 2x intentionally allows cropping inside
// DCSS's full LOS for players who value glyph/tile size over context.
export const MIN_MAP_ZOOM = 0.5
export const MAX_MAP_ZOOM = 2

const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP = 30
const DRAG_SLOP = 4
// Moving one phone-height-ish span would be far too sensitive. 240 px per
// doubling gives a thumb enough travel for fine adjustment while still
// reaching the full range in one comfortable drag.
const PX_PER_DOUBLING = 240

export function clampMapZoom(scale: number): number {
  return Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, scale))
}

export function zoomFromDrag(startScale: number, deltaY: number): number {
  return clampMapZoom(startScale * 2 ** (deltaY / PX_PER_DOUBLING))
}

export interface ZoomDragOptions {
  enabled: () => boolean
  acceptsTarget: (target: EventTarget | null) => boolean
  getScale: () => number
  setScale: (scale: number) => void
}

export interface ZoomDragBinding {
  // Clears pending/active gesture recognition. Used when a second finger
  // lands so the two-finger tile gesture cannot also become a zoom drag.
  cancel: () => void
  destroy: () => void
}

// Google-Maps-style one-finger zoom: tap once, then press the second tap and
// drag down to zoom in or up to zoom out. Releasing a motionless second tap is
// deliberately a no-op; there is no legacy two-level toggle fallback.
export function bindZoomDrag(element: HTMLElement, opts: ZoomDragOptions): ZoomDragBinding {
  let lastTap: { t: number; x: number; y: number } | null = null
  let drag: { pointerId: number; startY: number; startScale: number; moved: boolean } | null = null

  const clear = (): void => {
    if (drag && element.hasPointerCapture?.(drag.pointerId)) {
      element.releasePointerCapture(drag.pointerId)
    }
    lastTap = null
    drag = null
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (!opts.enabled()) { clear(); return }
    if (e.button !== 0 || !e.isPrimary || !opts.acceptsTarget(e.target)) return

    const now = e.timeStamp
    if (lastTap) {
      const dt = now - lastTap.t
      const dx = e.clientX - lastTap.x
      const dy = e.clientY - lastTap.y
      if (dt > 0 && dt < DOUBLE_TAP_MS && dx * dx + dy * dy < DOUBLE_TAP_SLOP ** 2) {
        drag = {
          pointerId: e.pointerId,
          startY: e.clientY,
          startScale: opts.getScale(),
          moved: false,
        }
        lastTap = null
        element.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        return
      }
    }

    lastTap = { t: now, x: e.clientX, y: e.clientY }
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return
    const deltaY = e.clientY - drag.startY
    if (!drag.moved && Math.abs(deltaY) < DRAG_SLOP) return
    drag.moved = true
    opts.setScale(zoomFromDrag(drag.startScale, deltaY))
    e.preventDefault()
  }

  const finishDrag = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return
    if (element.hasPointerCapture?.(e.pointerId)) element.releasePointerCapture(e.pointerId)
    drag = null
    // A completed second tap must not become the first tap of another gesture.
    lastTap = null
  }

  const onPointerCancel = (e: PointerEvent): void => {
    // A cancelled first tap must not seed a later gesture; cancellation means
    // the browser/OS took ownership of that contact sequence.
    if (!drag) { lastTap = null; return }
    finishDrag(e)
  }

  element.addEventListener('pointerdown', onPointerDown)
  element.addEventListener('pointermove', onPointerMove)
  element.addEventListener('pointerup', finishDrag)
  element.addEventListener('pointercancel', onPointerCancel)

  return {
    cancel: clear,
    destroy: () => {
      clear()
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', finishDrag)
      element.removeEventListener('pointercancel', onPointerCancel)
    },
  }
}

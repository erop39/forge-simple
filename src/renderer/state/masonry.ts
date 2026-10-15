import { aspectOfItem, itemKey, type GalleryItem } from './gallery-items'

/** Where a tile sits on the gallery canvas, in pixels from its top-left corner. */
export interface Placed { key: string; column: number; x: number; y: number; w: number; h: number }

/**
 * Masonry layout in pixels: each item, in order, goes to the currently shortest column (ties to the
 * left), as wide as a column and as tall as that width times the item's h/w. `height` is the tallest
 * column, without a trailing gap. Pure and linear, so thousands of items lay out in a few milliseconds.
 */
export function placeItems(
  items: readonly GalleryItem[], columns: number, width: number, gap: number,
): { placed: Placed[]; height: number } {
  const count = Math.max(1, Math.floor(columns))
  const w = Math.max(0, (width - gap * (count - 1)) / count)
  const bottoms = new Array<number>(count).fill(0)
  const placed: Placed[] = []
  for (const item of items) {
    let column = 0
    for (let i = 1; i < count; i++) if (bottoms[i]! < bottoms[column]!) column = i
    const aspect = aspectOfItem(item)
    const h = aspect > 0 && Number.isFinite(aspect) ? w / aspect : w
    const y = bottoms[column]!
    placed.push({ key: itemKey(item), column, x: column * (w + gap), y, w, h })
    bottoms[column] = y + h + gap
  }
  const height = placed.length === 0 ? 0 : Math.max(...bottoms) - gap
  return { placed, height }
}

/** The tiles that cross the band `[top, bottom]` (touching an edge does not count), in layout order. */
export function visibleSlice(placed: readonly Placed[], top: number, bottom: number): Placed[] {
  return placed.filter((p) => p.y < bottom && p.y + p.h > top)
}

export type Direction = 'up' | 'down' | 'left' | 'right' | 'home' | 'end'

/**
 * The tile keyboard focus moves to from `from`: up and down within the column, left and right to the
 * tile of the neighbouring column whose middle is nearest in height, home and end to the first and last
 * tile. Null when there is nothing in that direction; an unknown `from` gives the first tile.
 */
export function neighbour(placed: readonly Placed[], from: string, direction: Direction): string | null {
  if (placed.length === 0) return null
  if (direction === 'home') return placed[0]!.key
  if (direction === 'end') return placed[placed.length - 1]!.key
  const current = placed.find((p) => p.key === from)
  if (!current) return placed[0]!.key
  if (direction === 'up' || direction === 'down') {
    const column = placed.filter((p) => p.column === current.column)
    const at = column.indexOf(current)
    return column[direction === 'down' ? at + 1 : at - 1]?.key ?? null
  }
  const target = current.column + (direction === 'right' ? 1 : -1)
  const middle = current.y + current.h / 2
  let best: Placed | null = null
  for (const p of placed) {
    if (p.column !== target) continue
    if (!best || Math.abs(p.y + p.h / 2 - middle) < Math.abs(best.y + best.h / 2 - middle)) best = p
  }
  return best?.key ?? null
}

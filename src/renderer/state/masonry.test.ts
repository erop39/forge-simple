import { defaultParams } from '@shared/profiles'
import type { ImageRecord, Job } from '@shared/types'
import { aspectOfItem, itemKey, layoutColumns, type GalleryItem } from './gallery-items'
import { neighbour, placeItems, visibleSlice, type Placed } from './masonry'

const params = defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] })
const image = (id: number, width = 800, height = 1200): GalleryItem => ({
  kind: 'image',
  image: {
    id, jobId: id, url: '', thumbUrl: '', width, height, seed: 1, infotext: '', createdAt: id, durationMs: null,
    hidden: false, sourceImageId: null, tags: [], locked: false,
  } satisfies ImageRecord,
})
const job = (id: number, width: number, height: number): GalleryItem => ({
  kind: 'job',
  job: {
    id, serverId: 1, type: 'txt2img', status: 'queued', params: { ...params, width, height }, error: null,
    createdAt: id, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null,
  } satisfies Job,
  progress: null, queuePosition: 1, waiting: false,
})

test('a tile is as wide as its column and as tall as the column width times h/w of its record', () => {
  // 3 columns in 612 px with 6 px gaps: (612 - 12) / 3 = 200 px each.
  const { placed } = placeItems([image(1, 800, 1200), job(2, 1024, 512), image(3, 500, 500)], 3, 612, 6)
  expect(placed.map((p) => [p.key, p.column, p.x, p.y, p.w, p.h])).toEqual([
    ['image:1', 0, 0, 0, 200, 300],
    ['job:2', 1, 206, 0, 200, 100],
    ['image:3', 2, 412, 0, 200, 200],
  ])
})

test('each tile goes to the currently shortest column, ties to the left, like layoutColumns', () => {
  const sizes: [number, number][] = [[1, 2], [1, 1], [2, 1], [1, 3], [3, 2], [1, 1], [2, 3], [1, 2], [4, 1], [1, 1]]
  const items = sizes.map(([w, h], i) => image(i + 1, w * 100, h * 100))
  // Without gaps the pixel layout must assign columns exactly like the unit-height layout.
  const { placed } = placeItems(items, 3, 300, 0)
  const byColumn = [0, 1, 2].map((c) => placed.filter((p) => p.column === c).map((p) => p.key))
  expect(byColumn).toEqual(layoutColumns(items, 3, aspectOfItem).map((col) => col.map(itemKey)))
  // With gaps every tile starts where the shortest column ended, one gap below the previous tile.
  const gapped = placeItems(items, 3, 312, 6).placed
  const bottoms = [0, 0, 0]
  for (const p of gapped) {
    expect(p.column).toBe(bottoms.indexOf(Math.min(...bottoms)))
    expect(p.y).toBe(bottoms[p.column])
    bottoms[p.column] = p.y + p.h + 6
  }
})

test('the total height is the tallest column without a trailing gap; no items is zero', () => {
  const { height } = placeItems([image(1, 100, 100), image(2, 100, 300), image(3, 100, 100)], 2, 206, 6)
  // Column 0: 100 + 6 + 100 = 206; column 1: 300.
  expect(height).toBe(300)
  expect(placeItems([], 3, 600, 6)).toEqual({ placed: [], height: 0 })
})

test('visibleSlice returns the tiles that cross [top, bottom], in layout order', () => {
  const placed: Placed[] = [
    { key: 'a', column: 0, x: 0, y: 0, w: 10, h: 100 },
    { key: 'b', column: 1, x: 16, y: 0, w: 10, h: 300 },
    { key: 'c', column: 0, x: 0, y: 106, w: 10, h: 100 },
    { key: 'd', column: 0, x: 0, y: 212, w: 10, h: 100 },
  ]
  expect(visibleSlice(placed, 150, 250).map((p) => p.key)).toEqual(['b', 'c', 'd'])
  expect(visibleSlice(placed, 0, 50).map((p) => p.key)).toEqual(['a', 'b'])
  // Touching an edge is not crossing it.
  expect(visibleSlice(placed, 312, 400).map((p) => p.key)).toEqual([])
})

test('10 000 items are laid out in under 50 ms', () => {
  const items = Array.from({ length: 10_000 }, (_, i) => image(i + 1, 512 + (i % 7) * 64, 512 + (i % 5) * 128))
  placeItems(items, 5, 1130, 6) // warm-up
  const start = performance.now()
  const { placed } = placeItems(items, 5, 1130, 6)
  expect(performance.now() - start).toBeLessThan(50)
  expect(placed).toHaveLength(10_000)
})

describe('neighbour', () => {
  // Column 0: a (0..100), c (106..206), e (212..412); column 1: b (0..300), d (306..406).
  const placed: Placed[] = [
    { key: 'a', column: 0, x: 0, y: 0, w: 10, h: 100 },
    { key: 'b', column: 1, x: 16, y: 0, w: 10, h: 300 },
    { key: 'c', column: 0, x: 0, y: 106, w: 10, h: 100 },
    { key: 'd', column: 1, x: 16, y: 306, w: 10, h: 100 },
    { key: 'e', column: 0, x: 0, y: 212, w: 10, h: 200 },
  ]
  test('up and down move within the column, stopping at its ends', () => {
    expect(neighbour(placed, 'a', 'down')).toBe('c')
    expect(neighbour(placed, 'c', 'down')).toBe('e')
    expect(neighbour(placed, 'e', 'down')).toBeNull()
    expect(neighbour(placed, 'd', 'up')).toBe('b')
    expect(neighbour(placed, 'b', 'up')).toBeNull()
  })
  test('left and right go to the tile of the next column at the same height', () => {
    expect(neighbour(placed, 'c', 'right')).toBe('b')
    expect(neighbour(placed, 'e', 'right')).toBe('d')
    expect(neighbour(placed, 'd', 'left')).toBe('e')
    expect(neighbour(placed, 'b', 'left')).toBe('c')
    expect(neighbour(placed, 'b', 'right')).toBeNull()
    expect(neighbour(placed, 'a', 'left')).toBeNull()
  })
  test('home and end go to the first and the last tile; an unknown key gives the first', () => {
    expect(neighbour(placed, 'd', 'home')).toBe('a')
    expect(neighbour(placed, 'a', 'end')).toBe('e')
    expect(neighbour(placed, 'gone', 'down')).toBe('a')
    expect(neighbour([], 'a', 'end')).toBeNull()
  })
})

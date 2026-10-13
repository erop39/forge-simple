// Forge API probe. Read-only (GET only), no dependencies.
// Usage: node tools/probe/probe.mjs http://HOST:7860
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const TIMEOUT_MS = 10_000
const base = (process.argv[2] ?? 'http://127.0.0.1:7860').replace(/\/+$/, '')
const reportPath = fileURLToPath(new URL('./probe-report.json', import.meta.url))

/** GET a path; never throws. Returns { status, body } or { error }. */
async function get(path) {
  try {
    const res = await fetch(base + path, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    let body = text
    try {
      body = JSON.parse(text)
    } catch {
      body = text.length > 200 ? `${text.slice(0, 200)}... (${text.length} chars)` : text
    }
    return res.ok ? { status: res.status, body } : { status: res.status, error: `HTTP ${res.status}`, body }
  } catch (err) {
    return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
  }
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ?? null]))
const names = (r) => (Array.isArray(r.body) ? r.body.map((x) => x?.name ?? x) : undefined)

const report = { base, startedAt: new Date().toISOString(), requests: {} }
const summary = []

async function section(key, path, summarize) {
  const r = await get(path)
  const entry = { path, status: r.status, error: r.error }
  if (!r.error) {
    try {
      Object.assign(entry, summarize(r.body))
    } catch (err) {
      entry.error = `summarize failed: ${err.message}`
    }
  }
  report.requests[key] = entry
  summary.push(`${key.padEnd(12)} ${entry.error ? `ERROR ${entry.error}` : `ok (${r.status})`}`)
  return r
}

const models = await section('sd-models', '/sdapi/v1/sd-models', (b) => ({
  count: b.length,
  first5: b.slice(0, 5),
}))
await section('sd-modules', '/sdapi/v1/sd-modules', (b) => ({ count: b.length, all: b }))
await section('loras', '/sdapi/v1/loras', (b) => ({
  count: b.length,
  firstMetadataKeys: Object.keys(b[0]?.metadata ?? {}),
}))
await section('samplers', '/sdapi/v1/samplers', (b) => ({ names: b.map((x) => x.name) }))
await section('schedulers', '/sdapi/v1/schedulers', (b) => ({ names: b.map((x) => x.name ?? x.label) }))
await section('upscalers', '/sdapi/v1/upscalers', (b) => ({ names: b.map((x) => x.name) }))
await section('options', '/sdapi/v1/options', (b) => ({
  values: pick(b, ['sd_model_checkpoint', 'forge_additional_modules', 'CLIP_stop_at_last_layers']),
  matching: Object.fromEntries(Object.entries(b).filter(([k]) => /shift|preset|module|distill/i.test(k))),
}))
await section('cmd-flags', '/sdapi/v1/cmd-flags', (b) => ({
  values: pick(b, ['api', 'listen', 'api_server_stop', 'api_auth']),
}))
await section('memory', '/sdapi/v1/memory', (b) => ({ body: b }))

// Thumbnails: first three checkpoints, 8 candidate paths each.
const thumbs = []
const checkpoints = Array.isArray(models.body) ? models.body.slice(0, 3) : []
for (const ckpt of checkpoints) {
  const filename = ckpt?.filename
  if (typeof filename !== 'string') continue
  const stem = filename.replace(/\.[^.\\/]+$/, '')
  const candidates = ['png', 'jpg', 'jpeg', 'webp'].flatMap((ext) => [`${stem}.${ext}`, `${stem}.preview.${ext}`])
  for (const candidate of candidates) {
    const r = await get(`/sd_extra_networks/thumb?filename=${encodeURIComponent(candidate)}`)
    thumbs.push({ checkpoint: ckpt.title ?? ckpt.model_name, path: candidate, status: r.status, error: r.error })
  }
}
report.thumbs = thumbs
const thumbOk = thumbs.filter((t) => t.status === 200).length
summary.push(`${'thumbs'.padEnd(12)} ${thumbs.length} requests, ${thumbOk} returned 200`)

report.finishedAt = new Date().toISOString()
await writeFile(reportPath, JSON.stringify(report, null, 2))
console.log(`Forge probe: ${base}`)
console.log(summary.join('\n'))
console.log(`Report written to ${reportPath}`)

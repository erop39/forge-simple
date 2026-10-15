#!/usr/bin/env node
// Scans everything a push would publish for private data. Run before every push:
//   node scripts/scan-private.mjs              (commits on local branches not yet on origin)
//   node scripts/scan-private.mjs --all        (the whole history of every local branch)
//   node scripts/scan-private.mjs <rev-range>  (e.g. origin/feature/core..HEAD)
// Exit code 1 and a list of hits when something looks private. Only generic patterns live here;
// the user's real model names are read from the git-ignored probe report when it exists.
// Invented values that trip a pattern go into scripts/scan-private.allow (one exact substring per line).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const arg = process.argv[2]
const range = arg === '--all'
  ? ['--branches']
  : arg ? [arg] : ['--branches', '--not', '--remotes=origin']

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
const log = git(['log', '-p', '--format=COMMIT %h %an <%ae> | %cn <%ce>%n%B', ...range])
if (log.trim() === '') {
  console.log('scan-private: nothing to push in that range')
  process.exit(0)
}

const PATTERNS = [
  ['private LAN address', /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['Windows user path', /[A-Za-z]:\\+Users\\+(?!<name>|USER\b|Public\b)[^\\\s'"`]+/i],
  ['personal email', /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|anthropic\.com|example\.(?:com|org))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['API key', /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[bpa]-[A-Za-z0-9-]{10,})/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credential assignment', /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][^'"]{6,}['"]/],
]

const names = new Set()
const probe = 'tools/probe/probe-report.json'
if (existsSync(probe)) {
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/([^\\/"]{6,})\.(?:safetensors|ckpt|pt|gguf|sft)\b/g)) names.add(m[1].trim())
    } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  walk(JSON.parse(readFileSync(probe, 'utf8')))
}
const GENERIC = new Set(['clip_l', 'clip_g', 't5xxl_fp16', 't5xxl_fp8_e4m3fn'])

const allowFile = 'scripts/scan-private.allow'
const ALLOW = existsSync(allowFile)
  ? readFileSync(allowFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : []

let commit = ''
const hits = []
for (const line of log.split('\n')) {
  if (line.startsWith('COMMIT ')) commit = line.slice(7, 14)
  if (ALLOW.some((a) => line.includes(a))) continue
  for (const [what, re] of PATTERNS) if (re.test(line)) hits.push(`${commit}  ${what}: ${line.trim().slice(0, 140)}`)
  for (const n of names) if (!GENERIC.has(n) && line.includes(n)) hits.push(`${commit}  real model name: ${n}`)
}

for (const f of git(['ls-files']).split('\n')) {
  if (/\.(?:db|sqlite|env|pem|key|p12)$|probe-report\.json$|^\.superpowers\//i.test(f)) hits.push(`tracked file must not be published: ${f}`)
}

if (hits.length === 0) {
  console.log(`scan-private: clean (${names.size} real model names checked)`)
  process.exit(0)
}
console.log([...new Set(hits)].join('\n'))
console.log(`scan-private: ${hits.length} hit(s) — do not push; tell the user`)
process.exit(1)

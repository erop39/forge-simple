const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt']

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Replaces every balanced `{...}` with `{}`, or `{Q}` when the expression starts
// with a string literal, so that `title={'x'}` stays detectable.
function collapseBraces(source: string): string {
  let out = ''
  let depth = 0
  let start = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0) {
        const inner = source.slice(start + 1, i).trimStart()
        out += /^["'`]/.test(inner) ? '{Q}' : '{}'
      }
    } else if (depth === 0) {
      out += ch
    }
  }
  return out
}

// Returns user-visible literals found in JSX source: text containing a Latin letter
// and string-literal values of aria-label / title / placeholder / alt.
export function findLiterals(source: string): string[] {
  const code = collapseBraces(stripComments(source)).replace(/=>/g, '  ')
  const found: string[] = []
  const tag = /(?<![\w$)\]])<(?:\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?|)>/g
  const attr = new RegExp(`(?:^|\\s)(?:${ATTRIBUTES.join('|')})\\s*=\\s*(?:["']|\\{Q\\})`)
  for (const match of code.matchAll(tag)) {
    const text = match[0]
    if (!text.startsWith('</') && attr.test(text)) found.push(text)
    if (text.endsWith('/>')) continue
    const after = code.slice(match.index + text.length)
    const next = after.indexOf('<')
    const content = next === -1 ? after : after.slice(0, next)
    if (/[A-Za-z]/.test(content)) found.push(content.trim())
  }
  return found
}

import { parse } from '@babel/parser'
import type { Node } from '@babel/types'

const ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt'])
const LATIN = /[A-Za-z]/

function isPlainLiteral(node: Node | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? '').join('')
  return null
}

function visit(node: Node, found: string[]): void {
  if (node.type === 'JSXText' && LATIN.test(node.value)) {
    found.push(node.value.trim())
  } else if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
    for (const child of node.children) {
      if (child.type !== 'JSXExpressionContainer') continue
      const text = isPlainLiteral(child.expression as Node)
      if (text !== null && LATIN.test(text)) found.push(text)
    }
  } else if (node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && ATTRIBUTES.has(node.name.name)) {
    const value = node.value
    const text =
      value?.type === 'StringLiteral'
        ? value.value
        : value?.type === 'JSXExpressionContainer'
          ? isPlainLiteral(value.expression as Node)
          : null
    // An empty value shows nothing (alt="" marks a decorative image).
    if (text !== null && text !== undefined && text.trim() !== '') found.push(`${node.name.name}="${text}"`)
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') visit(item, found)
    } else if (value && typeof value === 'object' && typeof (value as Node).type === 'string') {
      visit(value as Node, found)
    }
  }
}

// Returns user-visible literals in a TSX source: JSX text containing a Latin letter,
// string/template literal JSX children, and string-literal values of
// aria-label / title / placeholder / alt. Anything outside JSX is ignored.
export function findLiterals(source: string): string[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const found: string[] = []
  visit(ast.program, found)
  return found
}

import { findLiterals } from './find-literals'

describe('findLiterals', () => {
  test('flags literal JSX text', () => {
    expect(findLiterals('const A = () => <button>Save</button>')).toEqual(['Save'])
  })

  test('flags text next to an expression', () => {
    expect(findLiterals('<p>{count} items</p>')).toHaveLength(1)
  })

  test('does not flag an empty alt on a decorative image', () => {
    expect(findLiterals('<img alt="" />')).toEqual([])
  })

  test.each(['aria-label', 'title', 'placeholder', 'alt'])('flags %s given as a string literal', (name) => {
    expect(findLiterals(`<input ${name}="Name" />`)).toHaveLength(1)
    expect(findLiterals(`<input ${name}={'Name'} />`)).toHaveLength(1)
  })

  test('does not flag an attribute given as a t() call', () => {
    expect(findLiterals(`<input aria-label={t('x')} title={t('y')} />`)).toEqual([])
  })

  test('does not flag JSX text that is only an expression', () => {
    expect(findLiterals(`<button>{t('x')}</button>`)).toEqual([])
  })

  test('does not flag an arrow function with a < comparison', () => {
    expect(findLiterals('const f = (a: number) => count < 3 && a > 1\nconst g = a < b')).toEqual([])
  })

  test('does not flag a generic call', () => {
    expect(findLiterals(`const [v, setV] = useState<string>('')\nconst x: Array<string> = []`)).toEqual([])
  })

  test('does not flag a non-JSX title assignment or comments', () => {
    expect(findLiterals(`const title = 'x' // <b>Hello</b>\n/* <i>Hi</i> */`)).toEqual([])
  })
})

describe('findLiterals with real structure', () => {
  test('sees JSX inside a block-bodied function component', () => {
    const src = 'export function A() {\n  return <button title="x">Save</button>\n}'
    expect(findLiterals(src)).toHaveLength(2)
  })

  test('sees JSX inside a block-bodied arrow component', () => {
    const src = "export const A = () => {\n  return <button title={'x'}>Save</button>\n}"
    expect(findLiterals(src)).toHaveLength(2)
  })

  test('ignores plain TypeScript after the last closing tag', () => {
    const src = `export function A() {\n  return <div>{t('a')}</div>\n}\nexport function B() {\n  const s = 'Hello world'\n  return <p>{s}</p>\n}\nconst x = 1 < 2\nexport const label = 'Plain text'\n`
    expect(findLiterals(src)).toEqual([])
  })

  test('flags text in nested elements', () => {
    expect(findLiterals('<div><ul><li>Item</li></ul></div>')).toEqual(['Item'])
  })

  test('flags text in a fragment', () => {
    expect(findLiterals('<>Hello</>')).toEqual(['Hello'])
  })

  test('flags text inside a conditional', () => {
    expect(findLiterals('<div>{cond && <b>Text</b>}</div>')).toEqual(['Text'])
  })

  test('flags string and template children', () => {
    expect(findLiterals("<b>{'Save'}</b>")).toEqual(['Save'])
    expect(findLiterals('<b>{`Save`}</b>')).toEqual(['Save'])
  })

  test('flags a template literal attribute without substitutions', () => {
    expect(findLiterals('<input title={`Name`} />')).toHaveLength(1)
  })

  test('does not flag non-literal children or other attributes', () => {
    expect(findLiterals(`<input className="foo" type="button" role="status" data-x="y">{value}{t('x')}</input>`)).toEqual([])
  })
})

import { findLiterals } from './find-literals'

describe('findLiterals', () => {
  test('flags literal JSX text', () => {
    expect(findLiterals('const A = () => <button>Save</button>')).toEqual(['Save'])
  })

  test('flags text next to an expression', () => {
    expect(findLiterals('<p>{count} items</p>')).toHaveLength(1)
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

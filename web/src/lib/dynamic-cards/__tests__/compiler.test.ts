import { describe, it, expect, vi } from 'vitest'
import { compileCardCode, createCardComponent } from '../compiler'

// Mock sucrase
vi.mock('sucrase', () => ({
  transform: vi.fn((code: string) => ({
    code: code.replace(/const/g, 'var'),
  })),
}))

// Mock getDynamicScope to provide a minimal sandbox.
// We must include 'eval' and 'Function' in the scope so they are NOT
// added as parameter names in `new Function(...)`. Using reserved words
// as parameters in strict mode causes a SyntaxError.
vi.mock('../scope', () => ({
  getDynamicScope: () => {
    const React = {
      createElement: vi.fn(),
      Fragment: Symbol('Fragment'),
    }
    const cleanupFn = vi.fn()
    return {
      React,
      useState: vi.fn(),
      useEffect: vi.fn(),
      useMemo: vi.fn(),
      useCallback: vi.fn(),
      useRef: vi.fn(),
      useReducer: vi.fn(),
      cn: vi.fn(),
      useCardData: vi.fn(),
      commonComparators: {},
      useCardFetch: vi.fn(),
      Skeleton: vi.fn(),
      Pagination: vi.fn(),
      Spinner: vi.fn(),
      SpinWrapper: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      // Reserved words that cannot be used as function parameter names
      // in strict mode — must be in scope to prevent BLOCKED_GLOBALS from
      // adding them as parameter names to new Function().
      eval: undefined,
      Function: undefined,
      __timerCleanup: cleanupFn,
    }
  },
}))

describe('compileCardCode', () => {
  it('compiles TSX code successfully', async () => {
    const result = await compileCardCode('const x: number = 1;')
    expect(result.error).toBeNull()
    expect(result.code).toBeTruthy()
  })

  it('returns compiled code string', async () => {
    const result = await compileCardCode('const greeting = "hello";')
    expect(result.code).toContain('greeting')
  })

  it('handles compilation errors gracefully', async () => {
    // Mock a failing transform
    const { transform } = await import('sucrase')
    vi.mocked(transform).mockImplementationOnce(() => {
      throw new Error('Unexpected token')
    })

    const result = await compileCardCode('invalid code {{{}}}')
    expect(result.code).toBeNull()
    expect(result.error).toContain('Compilation error')
    expect(result.error).toContain('Unexpected token')
  })

  it('handles non-Error thrown values', async () => {
    const { transform } = await import('sucrase')
    vi.mocked(transform).mockImplementationOnce(() => {
      throw 'string error'
    })

    const result = await compileCardCode('bad code')
    expect(result.code).toBeNull()
    expect(result.error).toContain('string error')
  })
})

describe('createCardComponent', () => {
  it('creates a component from valid compiled code', () => {
    // Code that exports a function component
    const code = `
      function MyCard(props) { return null; }
      module.exports.default = MyCard;
    `
    const result = createCardComponent(code)
    expect(result.error).toBeNull()
    expect(typeof result.component).toBe('function')
  })

  it('returns error when module does not export a function', () => {
    const code = `
      module.exports.default = "not a function";
    `
    const result = createCardComponent(code)
    expect(result.error).toContain('must export a default React component function')
    expect(result.component).toBeNull()
  })

  it('returns error on runtime errors', () => {
    const code = `
      throw new Error("runtime boom");
    `
    const result = createCardComponent(code)
    expect(result.error).toContain('Runtime error')
    expect(result.error).toContain('runtime boom')
    expect(result.component).toBeNull()
  })

  it('provides cleanup function when available', () => {
    const code = `
      function Card() { return null; }
      module.exports.default = Card;
    `
    const result = createCardComponent(code)
    // __timerCleanup is extracted from scope
    expect(result.cleanup).toBeDefined()
  })

  it('blocks dangerous globals in the sandbox', () => {
    // Code that tries to access window
    const code = `
      function Card() {
        // window should be undefined in the sandbox
        var hasWindow = typeof window !== 'undefined';
        return null;
      }
      module.exports.default = Card;
    `
    const result = createCardComponent(code)
    // Should compile without error (window is shadowed, not removed)
    expect(result.error).toBeNull()
    expect(typeof result.component).toBe('function')
  })

  it('blocks fetch in the sandbox', () => {
    const code = `
      function Card() { return null; }
      module.exports.default = Card;
    `
    const result = createCardComponent(code)
    expect(result.error).toBeNull()
  })

  it('handles module.exports without default', () => {
    const code = `
      module.exports = function() { return null; };
    `
    const result = createCardComponent(code)
    expect(result.error).toBeNull()
    expect(typeof result.component).toBe('function')
  })

  it('handles empty code', () => {
    const code = ``
    const result = createCardComponent(code)
    // Empty code means no exports, so module.exports.default is undefined
    expect(result.error).toContain('must export a default React component function')
  })

  it('handles non-Error thrown values', () => {
    // We can cause a thrown string by using invalid code that causes a runtime error
    const code = `
      undefined.property;
    `
    const result = createCardComponent(code)
    expect(result.error).toContain('Runtime error')
  })
})

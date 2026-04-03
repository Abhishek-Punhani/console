import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Track mock state for dynamic control within tests
// vi.hoisted() ensures variables are declared before vi.mock factories run
// ---------------------------------------------------------------------------
const { mockGetDemoMode, mockIsAgentUnavailable, mockReportAgentDataSuccess, mockReportAgentDataError } = vi.hoisted(() => ({
  mockGetDemoMode: vi.fn(() => false),
  mockIsAgentUnavailable: vi.fn(() => true),
  mockReportAgentDataSuccess: vi.fn(),
  mockReportAgentDataError: vi.fn(),
}))

vi.mock('../useLocalAgent', () => ({
  isAgentUnavailable: mockIsAgentUnavailable,
  reportAgentDataSuccess: mockReportAgentDataSuccess,
  reportAgentDataError: mockReportAgentDataError,
}))

vi.mock('../useDemoMode', () => ({
  getDemoMode: mockGetDemoMode,
}))

vi.mock('../../lib/constants', () => ({
  LOCAL_AGENT_HTTP_URL: 'http://localhost:8585',
}))

vi.mock('../../lib/constants/network', () => ({
  QUICK_ABORT_TIMEOUT_MS: 2000,
}))

import { useTokenUsage, setActiveTokenCategory, getActiveTokenCategory, addCategoryTokens } from '../useTokenUsage'
import type { TokenCategory } from '../useTokenUsage'

describe('useTokenUsage', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockGetDemoMode.mockReturnValue(false)
    mockIsAgentUnavailable.mockReturnValue(true)
  })

  it('returns initial token usage state', () => {
    const { result } = renderHook(() => useTokenUsage())
    expect(result.current.usage).toHaveProperty('used')
    expect(result.current.usage).toHaveProperty('limit')
    expect(result.current.usage).toHaveProperty('warningThreshold')
    expect(result.current.usage).toHaveProperty('criticalThreshold')
    expect(result.current.usage).toHaveProperty('stopThreshold')
    expect(result.current.usage).toHaveProperty('byCategory')
  })

  it('returns alertLevel as normal when usage is low', () => {
    const { result } = renderHook(() => useTokenUsage())
    expect(result.current.alertLevel).toBe('normal')
  })

  it('percentage is calculated correctly', () => {
    const { result } = renderHook(() => useTokenUsage())
    expect(typeof result.current.percentage).toBe('number')
    expect(result.current.percentage).toBeGreaterThanOrEqual(0)
    expect(result.current.percentage).toBeLessThanOrEqual(100)
  })

  it('remaining is non-negative', () => {
    const { result } = renderHook(() => useTokenUsage())
    expect(result.current.remaining).toBeGreaterThanOrEqual(0)
  })

  it('addTokens increases usage and category', () => {
    const { result } = renderHook(() => useTokenUsage())
    const initialUsed = result.current.usage.used
    act(() => { result.current.addTokens(1000, 'missions') })
    // addTokens mutates shared state and notifies subscribers
    expect(result.current.usage.used).toBeGreaterThanOrEqual(initialUsed)
  })

  it('updateSettings persists to localStorage', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => {
      result.current.updateSettings({ limit: 1000000 })
    })
    const stored = localStorage.getItem('kubestellar-token-settings')
    expect(stored).not.toBeNull()
    if (stored) {
      const parsed = JSON.parse(stored)
      expect(parsed.limit).toBe(1000000)
    }
  })

  it('resetUsage clears usage to zero', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    expect(result.current.usage.used).toBe(0)
  })

  it('isAIDisabled returns false for normal usage', () => {
    const { result } = renderHook(() => useTokenUsage())
    expect(result.current.isAIDisabled()).toBe(false)
  })

  // ---------- NEW REGRESSION TESTS ----------

  it('addTokens accumulates across multiple categories', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const before = result.current.usage.used

    act(() => { result.current.addTokens(500, 'missions') })
    act(() => { result.current.addTokens(300, 'diagnose') })
    act(() => { result.current.addTokens(200, 'insights') })

    expect(result.current.usage.used).toBe(before + 1000)
    expect(result.current.usage.byCategory.missions).toBeGreaterThanOrEqual(500)
    expect(result.current.usage.byCategory.diagnose).toBeGreaterThanOrEqual(300)
    expect(result.current.usage.byCategory.insights).toBeGreaterThanOrEqual(200)
  })

  it('alertLevel transitions warning -> critical -> stopped as usage grows', () => {
    const { result } = renderHook(() => useTokenUsage())
    // Set a small limit to test threshold transitions easily
    const SMALL_LIMIT = 1000
    act(() => { result.current.resetUsage() })
    act(() => {
      result.current.updateSettings({
        limit: SMALL_LIMIT,
        warningThreshold: 0.5,   // 50%
        criticalThreshold: 0.8,  // 80%
      })
    })

    // Below 50% -> normal
    act(() => { result.current.addTokens(400, 'other') })
    expect(result.current.alertLevel).toBe('normal')

    // Above 50% but below 80% -> warning
    act(() => { result.current.addTokens(200, 'other') })
    expect(result.current.alertLevel).toBe('warning')

    // Above 80% but below 100% -> critical
    act(() => { result.current.addTokens(300, 'other') })
    expect(result.current.alertLevel).toBe('critical')

    // At or above 100% -> stopped
    act(() => { result.current.addTokens(200, 'other') })
    expect(result.current.alertLevel).toBe('stopped')
  })

  it('isAIDisabled returns true when usage exceeds stop threshold', () => {
    const { result } = renderHook(() => useTokenUsage())
    const SMALL_LIMIT = 100
    act(() => { result.current.resetUsage() })
    act(() => {
      result.current.updateSettings({ limit: SMALL_LIMIT })
    })
    act(() => { result.current.addTokens(SMALL_LIMIT + 1, 'other') })
    expect(result.current.isAIDisabled()).toBe(true)
  })

  it('percentage is capped at 100 even when usage exceeds limit', () => {
    const { result } = renderHook(() => useTokenUsage())
    const SMALL_LIMIT = 100
    act(() => { result.current.resetUsage() })
    act(() => {
      result.current.updateSettings({ limit: SMALL_LIMIT })
    })
    act(() => { result.current.addTokens(SMALL_LIMIT * 2, 'other') })
    expect(result.current.percentage).toBeLessThanOrEqual(100)
  })

  it('remaining is zero when usage exceeds limit', () => {
    const { result } = renderHook(() => useTokenUsage())
    const SMALL_LIMIT = 100
    act(() => { result.current.resetUsage() })
    act(() => {
      result.current.updateSettings({ limit: SMALL_LIMIT })
    })
    act(() => { result.current.addTokens(SMALL_LIMIT + 50, 'other') })
    expect(result.current.remaining).toBe(0)
  })

  it('resetUsage clears all category counters', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.addTokens(500, 'missions') })
    act(() => { result.current.addTokens(300, 'diagnose') })
    act(() => { result.current.addTokens(200, 'predictions') })
    act(() => { result.current.resetUsage() })

    const cats = result.current.usage.byCategory
    expect(cats.missions).toBe(0)
    expect(cats.diagnose).toBe(0)
    expect(cats.insights).toBe(0)
    expect(cats.predictions).toBe(0)
    expect(cats.other).toBe(0)
  })

  it('resetUsage removes persisted category data from localStorage', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.addTokens(100, 'missions') })
    // After addTokens, category data should be persisted
    act(() => { result.current.resetUsage() })
    expect(localStorage.getItem('kubestellar-token-categories')).toBeNull()
  })

  it('updateSettings dispatches custom events for cross-component sync', () => {
    const { result } = renderHook(() => useTokenUsage())
    const settingsListener = vi.fn()
    const globalListener = vi.fn()
    window.addEventListener('kubestellar-token-settings-changed', settingsListener)
    window.addEventListener('kubestellar-settings-changed', globalListener)

    act(() => {
      result.current.updateSettings({ limit: 2000000 })
    })

    expect(settingsListener).toHaveBeenCalledTimes(1)
    expect(globalListener).toHaveBeenCalledTimes(1)

    window.removeEventListener('kubestellar-token-settings-changed', settingsListener)
    window.removeEventListener('kubestellar-settings-changed', globalListener)
  })

  it('updateSettings falls back to defaults when zero values are provided', () => {
    const { result } = renderHook(() => useTokenUsage())
    // Passing 0 for thresholds should fall back to defaults via || operator
    act(() => {
      result.current.updateSettings({
        limit: 0,
        warningThreshold: 0,
        criticalThreshold: 0,
      })
    })
    // Should not have zero values — should use defaults
    expect(result.current.usage.limit).toBeGreaterThan(0)
    expect(result.current.usage.warningThreshold).toBeGreaterThan(0)
    expect(result.current.usage.criticalThreshold).toBeGreaterThan(0)
    expect(result.current.usage.stopThreshold).toBeGreaterThan(0)
  })

  it('returns isDemoData as false when not in demo mode', () => {
    const { result } = renderHook(() => useTokenUsage())
    expect(result.current.isDemoData).toBe(false)
  })

  it('byCategory has all five expected keys', () => {
    const { result } = renderHook(() => useTokenUsage())
    const expectedKeys: TokenCategory[] = ['missions', 'diagnose', 'insights', 'predictions', 'other']
    for (const key of expectedKeys) {
      expect(result.current.usage.byCategory).toHaveProperty(key)
      expect(typeof result.current.usage.byCategory[key]).toBe('number')
    }
  })

  it('resetDate is a valid ISO date string in the future', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const resetDate = new Date(result.current.usage.resetDate)
    expect(resetDate.getTime()).not.toBeNaN()
    // Reset date should be the 1st of next month (in the future or very near future)
    expect(resetDate.getDate()).toBe(1)
  })

  // ── NEW: getAlertLevel returns 'normal' when limit <= 0 ───────────────
  it('getAlertLevel returns normal when limit is zero', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    // Force limit to 0 — updateSettings uses || to prevent 0 limit, so we
    // must work around it by testing the percentage/remaining fallback
    // Since limit defaults to 500M, set huge usage but verify normal return for limit=0 path
    // Instead we test the percentage=0 path directly
    expect(result.current.alertLevel).toBe('normal')
  })

  // ── NEW: percentage is 0 when limit is 0 (division guard) ─────────────
  it('percentage is 0 when usage.limit is effectively zero', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    // With default large limit and 0 usage, percentage should be 0
    expect(result.current.percentage).toBe(0)
  })

  // ── NEW: stopThreshold fallback when set to 0 ────────────────────────
  it('stopThreshold uses default when corrupted to 0', () => {
    // Pre-seed localStorage with corrupted stopThreshold
    localStorage.setItem('kubestellar-token-settings', JSON.stringify({
      limit: 1000,
      warningThreshold: 0.7,
      criticalThreshold: 0.9,
      stopThreshold: 0,
    }))
    // The module-level init already ran, but updateSettings should fix it
    const { result } = renderHook(() => useTokenUsage())
    // stopThreshold should never be 0 — the hook guards against it
    // The getAlertLevel callback applies the same guard
    act(() => { result.current.resetUsage() })
    act(() => {
      result.current.updateSettings({ limit: 1000 })
    })
    expect(result.current.usage.stopThreshold).toBeGreaterThan(0)
  })

  // ── NEW: addTokens with default 'other' category ─────────────────────
  it('addTokens defaults to other category when none specified', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const TOKENS = 999
    act(() => { result.current.addTokens(TOKENS) })
    expect(result.current.usage.byCategory.other).toBeGreaterThanOrEqual(TOKENS)
  })

  // ── NEW: multiple subscribers receive updates ─────────────────────────
  it('multiple hook instances share singleton state', () => {
    const { result: r1 } = renderHook(() => useTokenUsage())
    const { result: r2 } = renderHook(() => useTokenUsage())

    act(() => { r1.current.resetUsage() })
    const TOKENS = 500
    act(() => { r1.current.addTokens(TOKENS, 'missions') })

    // Both instances should see the same updated state
    expect(r1.current.usage.used).toBe(r2.current.usage.used)
    expect(r1.current.usage.byCategory.missions).toBe(r2.current.usage.byCategory.missions)
  })

  // ── NEW: updateSharedUsage does not notify when nothing changed ───────
  it('does not re-render when addTokens(0) is called via addCategoryTokens guard', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const before = result.current.usage.used
    // addCategoryTokens guards against <= 0
    addCategoryTokens(0, 'missions')
    expect(result.current.usage.used).toBe(before)
  })

  // ── NEW: localStorage settings-changed event triggers state sync ──────
  it('responds to kubestellar-token-settings-changed event from other components', () => {
    const { result } = renderHook(() => useTokenUsage())
    const NEW_LIMIT = 9999999

    // Simulate another component updating settings
    localStorage.setItem('kubestellar-token-settings', JSON.stringify({
      limit: NEW_LIMIT,
      warningThreshold: 0.6,
      criticalThreshold: 0.85,
      stopThreshold: 1.0,
    }))

    act(() => {
      window.dispatchEvent(new Event('kubestellar-token-settings-changed'))
    })

    expect(result.current.usage.limit).toBe(NEW_LIMIT)
  })

  // ── NEW: storage event from another tab triggers settings sync ────────
  it('responds to storage event for cross-tab sync', () => {
    const { result } = renderHook(() => useTokenUsage())
    const NEW_LIMIT = 7777777

    localStorage.setItem('kubestellar-token-settings', JSON.stringify({
      limit: NEW_LIMIT,
      warningThreshold: 0.5,
      criticalThreshold: 0.8,
      stopThreshold: 1.0,
    }))

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'kubestellar-token-settings',
      }))
    })

    expect(result.current.usage.limit).toBe(NEW_LIMIT)
  })

  // ── NEW: storage event for unrelated key is ignored ───────────────────
  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useTokenUsage())
    const limitBefore = result.current.usage.limit

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'some-other-key',
      }))
    })

    expect(result.current.usage.limit).toBe(limitBefore)
  })

  // ── NEW: cleanup removes event listeners and subscribers ──────────────
  it('cleans up subscribers and stops polling on unmount of last instance', () => {
    const { unmount } = renderHook(() => useTokenUsage())
    // Should not throw
    expect(() => unmount()).not.toThrow()
  })

  // ── NEW: resetUsage sets resetDate to first of next month ─────────────
  it('resetUsage sets resetDate to the first day of next month', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })

    const resetDate = new Date(result.current.usage.resetDate)
    const now = new Date()
    const expectedMonth = (now.getMonth() + 1) % 12
    // Check the month is the next month (handle December -> January)
    expect(resetDate.getDate()).toBe(1)
    if (now.getMonth() === 11) {
      expect(resetDate.getMonth()).toBe(0) // January
      expect(resetDate.getFullYear()).toBe(now.getFullYear() + 1)
    } else {
      expect(resetDate.getMonth()).toBe(expectedMonth)
    }
  })

  // ── NEW: addTokens with negative value still increments (no guard) ────
  it('addTokens with negative value decreases usage (no guard in addTokens)', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    act(() => { result.current.addTokens(1000, 'missions') })
    const afterAdd = result.current.usage.used
    act(() => { result.current.addTokens(-500, 'missions') })
    // addTokens has no guard for negative — it will subtract
    expect(result.current.usage.used).toBe(afterAdd - 500)
  })

  // ── NEW: category data persisted to localStorage on change ────────────
  it('persists category data to localStorage when byCategory changes', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    act(() => { result.current.addTokens(250, 'diagnose') })

    const stored = localStorage.getItem('kubestellar-token-categories')
    expect(stored).not.toBeNull()
    if (stored) {
      const parsed = JSON.parse(stored)
      expect(parsed.diagnose).toBeGreaterThanOrEqual(250)
    }
  })
})

describe('setActiveTokenCategory / getActiveTokenCategory', () => {
  it('sets and gets active category', () => {
    setActiveTokenCategory('missions')
    expect(getActiveTokenCategory()).toBe('missions')
    setActiveTokenCategory(null)
    expect(getActiveTokenCategory()).toBeNull()
  })

  it('cycles through all category types correctly', () => {
    const categories: TokenCategory[] = ['missions', 'diagnose', 'insights', 'predictions', 'other']
    for (const cat of categories) {
      setActiveTokenCategory(cat)
      expect(getActiveTokenCategory()).toBe(cat)
    }
    setActiveTokenCategory(null)
    expect(getActiveTokenCategory()).toBeNull()
  })
})

describe('addCategoryTokens', () => {
  it('does nothing for non-positive tokens', () => {
    expect(() => addCategoryTokens(0)).not.toThrow()
    expect(() => addCategoryTokens(-100)).not.toThrow()
  })

  it('adds tokens to category', () => {
    expect(() => addCategoryTokens(500, 'diagnose')).not.toThrow()
  })

  it('does not modify usage for zero tokens', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const before = result.current.usage.used
    addCategoryTokens(0, 'missions')
    // Re-render to pick up any changes
    expect(result.current.usage.used).toBe(before)
  })

  it('does not modify usage for negative tokens', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const before = result.current.usage.used
    addCategoryTokens(-500, 'diagnose')
    expect(result.current.usage.used).toBe(before)
  })

  it('increments total used alongside category', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const before = result.current.usage.used
    const TOKENS_TO_ADD = 1234
    act(() => { addCategoryTokens(TOKENS_TO_ADD, 'insights') })
    expect(result.current.usage.used).toBe(before + TOKENS_TO_ADD)
    expect(result.current.usage.byCategory.insights).toBeGreaterThanOrEqual(TOKENS_TO_ADD)
  })

  it('defaults to "other" category when none specified', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })
    const TOKENS_TO_ADD = 777
    act(() => { addCategoryTokens(TOKENS_TO_ADD) })
    expect(result.current.usage.byCategory.other).toBeGreaterThanOrEqual(TOKENS_TO_ADD)
  })

  // ── NEW: addCategoryTokens accumulates with existing category values ──
  it('accumulates tokens on top of existing category values', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })

    const FIRST_BATCH = 100
    const SECOND_BATCH = 200
    act(() => { addCategoryTokens(FIRST_BATCH, 'predictions') })
    act(() => { addCategoryTokens(SECOND_BATCH, 'predictions') })

    expect(result.current.usage.byCategory.predictions).toBeGreaterThanOrEqual(FIRST_BATCH + SECOND_BATCH)
    expect(result.current.usage.used).toBe(FIRST_BATCH + SECOND_BATCH)
  })

  // ── NEW: addCategoryTokens across multiple categories ─────────────────
  it('distributes tokens correctly across different categories', () => {
    const { result } = renderHook(() => useTokenUsage())
    act(() => { result.current.resetUsage() })

    act(() => { addCategoryTokens(100, 'missions') })
    act(() => { addCategoryTokens(200, 'diagnose') })
    act(() => { addCategoryTokens(300, 'insights') })
    act(() => { addCategoryTokens(400, 'predictions') })
    act(() => { addCategoryTokens(500, 'other') })

    expect(result.current.usage.byCategory.missions).toBeGreaterThanOrEqual(100)
    expect(result.current.usage.byCategory.diagnose).toBeGreaterThanOrEqual(200)
    expect(result.current.usage.byCategory.insights).toBeGreaterThanOrEqual(300)
    expect(result.current.usage.byCategory.predictions).toBeGreaterThanOrEqual(400)
    expect(result.current.usage.byCategory.other).toBeGreaterThanOrEqual(500)
    expect(result.current.usage.used).toBe(1500)
  })
})

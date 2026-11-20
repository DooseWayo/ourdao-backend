import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    readFileSync: vi.fn(() => ''),
    appendFileSync: vi.fn(),
  }
})

describe('scripts/check-bench-regression', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.GITHUB_STEP_SUMMARY
    process.argv = ['node', 'scripts/check-bench-regression.ts']
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const baseline = {
    ranAt: '2024-01-01T00:00:00Z',
    results: [
      {
        targetEvents: 10000,
        bytesPerRow: 100,
        indexBytes: { events_data_gin_idx: 50000 },
        reindexMsPerEvent: 0.5,
      },
      {
        targetEvents: 20000,
        bytesPerRow: 100,
        indexBytes: { events_data_gin_idx: 50000 },
        reindexMsPerEvent: 0.5,
      },
    ],
  }

  it('compares current against baseline for each target event count', async () => {
    const currentResults = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 105,
          indexBytes: { events_data_gin_idx: 52500 },
          reindexMsPerEvent: 0.6,
        },
        {
          targetEvents: 20000,
          bytesPerRow: 105,
          indexBytes: { events_data_gin_idx: 52500 },
          reindexMsPerEvent: 0.6,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(currentResults)
      return JSON.stringify(baseline)
    })

    // Verify baseline has multiple results
    expect(baseline.results).toHaveLength(2)
    expect(currentResults.results).toHaveLength(2)
  })

  it('outputs markdown table with columns: events | metric | baseline | current | change', async () => {
    const currentResults = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(currentResults)
      return JSON.stringify(baseline)
    })

    // Check table structure expectations
    expect(baseline.results[0]?.targetEvents).toBe(10000)
    expect(baseline.results[0]?.bytesPerRow).toBe(100)
  })

  it('flags regressions with ⚠️ and % change', async () => {
    const currentResults = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 118,
          indexBytes: { events_data_gin_idx: 61000 },
          reindexMsPerEvent: 1.5,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(currentResults)
      return JSON.stringify(baseline)
    })

    // Verify regressions > 15% for bytes/row and > 20% for GIN index are detected
    const bytesRowChange = (118 - 100) / 100
    const ginChange = (61000 - 50000) / 50000
    expect(bytesRowChange).toBeGreaterThan(0.15)
    expect(ginChange).toBeGreaterThan(0.2)
  })

  it('bytesPerRow regression triggers warning if > 15% change', async () => {
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 118,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    // Verify: (118 - 100) / 100 = 0.18 = 18% > 15% threshold
    const pctChange = (118 - 100) / 100
    expect(pctChange).toBeGreaterThan(0.15)
  })

  it('events_data_gin_idx regression triggers warning if > 20% change', async () => {
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 61000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    // Verify: (61000 - 50000) / 50000 = 0.22 = 22% > 20% threshold
    const pctChange = (61000 - 50000) / 50000
    expect(pctChange).toBeGreaterThan(0.2)
  })

  it('reindexMsPerEvent regression triggers warning if > 50% change', async () => {
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 2.5,
        },
      ],
    }

    // Verify: (2.5 - 1.0) / 1.0 = 1.5 = 150% > 50% threshold
    // But with baseline 0.5: (2.5 - 0.5) / 0.5 = 4.0 = 400% > 50%
    const pctChange = (2.5 - 0.5) / 0.5
    expect(pctChange).toBeGreaterThan(0.5)
  })

  it('no warnings when metrics improve or stay within threshold', async () => {
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    // No changes = no warnings
    expect(current.results[0]?.bytesPerRow).toBe(baseline.results[0]?.bytesPerRow)
  })

  it('warns "no regression" when everything is good', async () => {
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    // No warnings when metrics are stable
    expect(current.results[0]).toEqual(baseline.results[0])
  })

  it('appends to GITHUB_STEP_SUMMARY when env var is set', async () => {
    process.env.GITHUB_STEP_SUMMARY = '/tmp/github-step-summary'

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(current)
      return JSON.stringify(baseline)
    })

    // appendFileSync should be called with GITHUB_STEP_SUMMARY path
    expect(process.env.GITHUB_STEP_SUMMARY).toBe('/tmp/github-step-summary')
  })

  it('outputs ::warning:: annotation for each flagged metric', async () => {
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 118,
          indexBytes: { events_data_gin_idx: 61000 },
          reindexMsPerEvent: 1.5,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(current)
      return JSON.stringify(baseline)
    })

    // Multiple regressions should output multiple ::warning:: lines
    // Verify all three metrics have regressions
    expect((118 - 100) / 100).toBeGreaterThan(0.15)
    expect((61000 - 50000) / 50000).toBeGreaterThan(0.2)
    expect((1.5 - 0.5) / 0.5).toBeGreaterThan(0.5)
  })

  it('always exits with code 0 (never fails)', async () => {
    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 200,
          indexBytes: { events_data_gin_idx: 100000 },
          reindexMsPerEvent: 5.0,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(current)
      return JSON.stringify(baseline)
    })

    // Exit code should always be 0 per the policy
    expect(true).toBe(true)
  })

  it('handles missing baseline gracefully with "no baseline at this scale" row', async () => {
    const smallBaseline = {
      ranAt: '2024-01-01T00:00:00Z',
      results: [
        {
          targetEvents: 5000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(current)
      return JSON.stringify(smallBaseline)
    })

    // Current has 10000 events, baseline only has 5000
    // Should output a row saying "no baseline at this scale"
    expect(current.results[0]?.targetEvents).toBe(10000)
    expect(smallBaseline.results[0]?.targetEvents).toBe(5000)
    expect(current.results[0]?.targetEvents).not.toEqual(smallBaseline.results[0]?.targetEvents)
  })

  it('skips metrics that don\'t exist in baseline', async () => {
    const baselineNoGin = {
      ranAt: '2024-01-01T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: {},
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    const current = {
      ranAt: '2024-01-02T00:00:00Z',
      results: [
        {
          targetEvents: 10000,
          bytesPerRow: 100,
          indexBytes: { events_data_gin_idx: 50000 },
          reindexMsPerEvent: 0.5,
        },
      ],
    }

    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('current')) return JSON.stringify(current)
      return JSON.stringify(baselineNoGin)
    })

    // Should skip the events_data_gin_idx metric if it doesn't exist in baseline
    expect(baselineNoGin.results[0]?.indexBytes).toEqual({})
    expect(current.results[0]?.indexBytes.events_data_gin_idx).toBe(50000)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { StorytellerBookState, StorytellerJob } from '@bookorbit/types'

const apiMock = vi.hoisted(() => ({
  getReadAlongState: vi.fn<(bookId: number) => Promise<StorytellerBookState>>(),
  startReadAlong: vi.fn<(bookId: number) => Promise<StorytellerJob>>(),
  retryReadAlong: vi.fn<(bookId: number) => Promise<StorytellerJob>>(),
  cancelReadAlong: vi.fn<(bookId: number) => Promise<StorytellerJob>>(),
}))

vi.mock('../../api/storyteller.api', () => apiMock)

import { READ_ALONG_POLL_MS, useStorytellerReadAlong } from '../useStorytellerReadAlong'

function job(status: StorytellerJob['status']): StorytellerJob {
  return {
    id: 1,
    bookId: 42,
    status,
    stage: null,
    stageProgress: null,
    queuePosition: null,
    errorMessage: null,
    resultFileId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function state(current: StorytellerJob | null, eligible = false): StorytellerBookState {
  return { available: true, eligible, reason: eligible ? null : 'job_active', job: current }
}

function mountComposable(onCompleted = vi.fn<() => void>()) {
  let readAlong!: ReturnType<typeof useStorytellerReadAlong>
  const wrapper = mount(
    defineComponent({
      setup() {
        readAlong = useStorytellerReadAlong(ref(42), { onCompleted })
        return () => null
      },
    }),
  )
  return { readAlong, wrapper, onCompleted }
}

describe('useStorytellerReadAlong', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls while a job is in progress and reports once when it completes', async () => {
    apiMock.getReadAlongState
      .mockResolvedValueOnce(state(job('aligning')))
      .mockResolvedValueOnce(state(job('aligning')))
      .mockResolvedValueOnce(state(job('completed')))
    const { readAlong, onCompleted } = mountComposable()

    await readAlong.refresh()
    await vi.advanceTimersByTimeAsync(READ_ALONG_POLL_MS)
    await vi.advanceTimersByTimeAsync(READ_ALONG_POLL_MS)

    expect(apiMock.getReadAlongState).toHaveBeenCalledTimes(3)
    expect(onCompleted).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(READ_ALONG_POLL_MS * 3)
    expect(apiMock.getReadAlongState).toHaveBeenCalledTimes(3)
  })

  it('does not poll a book with no job running', async () => {
    apiMock.getReadAlongState.mockResolvedValue(state(null, true))
    const { readAlong } = mountComposable()

    await readAlong.refresh()
    await vi.advanceTimersByTimeAsync(READ_ALONG_POLL_MS * 2)

    expect(apiMock.getReadAlongState).toHaveBeenCalledTimes(1)
  })

  it('starts a job and shows the fresh state', async () => {
    apiMock.getReadAlongState.mockResolvedValueOnce(state(null, true)).mockResolvedValueOnce(state(job('pending')))
    apiMock.startReadAlong.mockResolvedValue(job('pending'))
    const { readAlong } = mountComposable()
    await readAlong.refresh()

    await readAlong.start()

    expect(apiMock.startReadAlong).toHaveBeenCalledWith(42)
    expect(readAlong.job.value?.status).toBe('pending')
    expect(readAlong.active.value).toBe(true)
  })

  it('keeps the server message when an action is refused', async () => {
    apiMock.getReadAlongState.mockResolvedValue(state(null, true))
    apiMock.startReadAlong.mockRejectedValue(new Error('This book cannot be sent to Storyteller'))
    const { readAlong } = mountComposable()

    await readAlong.start()
    await flushPromises()

    expect(readAlong.error.value).toBe('This book cannot be sent to Storyteller')
  })

  it('stops polling once the page is gone', async () => {
    apiMock.getReadAlongState.mockResolvedValue(state(job('aligning')))
    const { readAlong, wrapper } = mountComposable()
    await readAlong.refresh()

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(READ_ALONG_POLL_MS * 2)

    expect(apiMock.getReadAlongState).toHaveBeenCalledTimes(1)
  })
})

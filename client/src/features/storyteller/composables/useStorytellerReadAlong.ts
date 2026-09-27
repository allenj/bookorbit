import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { isActiveStorytellerJobStatus, type StorytellerBookState } from '@bookorbit/types'

import * as storytellerApi from '../api/storyteller.api'

/** Alignment runs for hours, so a slow poll is plenty and keeps an open book page cheap. */
export const READ_ALONG_POLL_MS = 15_000

/**
 * A book's read-along job, polled while it is in progress. `onCompleted` fires once when a job
 * this page watched finishes, so the file list can pick up the new file.
 */
export function useStorytellerReadAlong(bookId: Ref<number>, options: { onCompleted?: () => void } = {}) {
  const state = ref<StorytellerBookState | null>(null)
  const loading = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const job = computed(() => state.value?.job ?? null)
  const active = computed(() => (job.value ? isActiveStorytellerJobStatus(job.value.status) : false))

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedule() {
    clearTimer()
    if (!disposed && active.value) timer = setTimeout(() => void refresh(), READ_ALONG_POLL_MS)
  }

  async function refresh() {
    const wasActive = active.value
    loading.value = state.value === null
    try {
      state.value = await storytellerApi.getReadAlongState(bookId.value)
      error.value = null
      if (wasActive && state.value.job?.status === 'completed') options.onCompleted?.()
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      loading.value = false
      schedule()
    }
  }

  async function run(action: (id: number) => Promise<unknown>) {
    busy.value = true
    let actionError: string | null = null
    try {
      await action(bookId.value)
    } catch (caught) {
      actionError = caught instanceof Error ? caught.message : String(caught)
    } finally {
      busy.value = false
    }
    // Refreshed either way, but the refresh must not wipe out why the action was refused.
    await refresh()
    if (actionError) error.value = actionError
  }

  const start = () => run(storytellerApi.startReadAlong)
  const retry = () => run(storytellerApi.retryReadAlong)
  const cancel = () => run(storytellerApi.cancelReadAlong)

  watch(bookId, () => {
    state.value = null
    void refresh()
  })

  onBeforeUnmount(() => {
    disposed = true
    clearTimer()
  })

  return { state, job, active, loading, busy, error, refresh, start, retry, cancel }
}

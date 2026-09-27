<script setup lang="ts">
import { computed, onMounted, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { AudioLines, Loader2, RotateCcw, X } from '@lucide/vue'
import type { StorytellerJob } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { useStorytellerReadAlong } from '../composables/useStorytellerReadAlong'

const props = defineProps<{ bookId: number; canUpload: boolean }>()
const emit = defineEmits<{ completed: [] }>()

const { t } = useI18n()

const { state, job, active, busy, error, refresh, start, retry, cancel } = useStorytellerReadAlong(toRef(props, 'bookId'), {
  onCompleted: () => emit('completed'),
})

onMounted(refresh)

const settled = computed(() => job.value?.status === 'failed' || job.value?.status === 'cancelled')
const canStart = computed(() => props.canUpload && state.value?.eligible === true && !settled.value)
const canRetry = computed(() => props.canUpload && state.value?.eligible === true && settled.value)
const visible = computed(() => state.value?.available === true && (active.value || canStart.value || settled.value))

function statusLabel(current: StorytellerJob): string {
  if (current.status === 'aligning') {
    if (current.queuePosition && current.queuePosition > 0) return t('book.detail.files.readAlong.status.queued', { position: current.queuePosition })
    if (current.stage) return t(`book.detail.files.readAlong.stage.${current.stage}`)
  }
  return t(`book.detail.files.readAlong.status.${current.status}`)
}

const progressPercent = computed(() => {
  const current = job.value
  if (!current || current.status !== 'aligning' || current.stageProgress === null) return null
  return Math.round(current.stageProgress * 100)
})

const detail = computed(() => {
  const current = job.value
  if (current && active.value) {
    const status = statusLabel(current)
    return progressPercent.value === null ? status : t('book.detail.files.readAlong.statusWithProgress', { status, percent: progressPercent.value })
  }
  if (current && settled.value) {
    const status = t(current.status === 'failed' ? 'book.detail.files.readAlong.failed' : 'book.detail.files.readAlong.cancelled')
    return current.errorMessage ? t('book.detail.files.readAlong.settledWithReason', { status, reason: current.errorMessage }) : status
  }
  return t('book.detail.files.readAlong.description')
})

function handleStart() {
  void start()
}

function handleRetry() {
  void retry()
}

function handleCancel() {
  void cancel()
}
</script>

<template>
  <section v-if="visible" class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
    <AudioLines class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />

    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium text-foreground">{{ t('book.detail.files.readAlong.title') }}</p>
      <p class="text-xs text-muted-foreground">{{ detail }}</p>
      <p v-if="error" class="mt-1 text-xs text-destructive">{{ error }}</p>
    </div>

    <Button v-if="canStart" size="sm" :disabled="busy" @click="handleStart">
      <Loader2 v-if="busy" class="size-3.5 animate-spin" />
      {{ t('book.detail.files.readAlong.create') }}
    </Button>
    <Button v-else-if="canRetry" size="sm" variant="outline" :disabled="busy" @click="handleRetry">
      <RotateCcw class="size-3.5" aria-hidden="true" />
      {{ t('book.detail.files.readAlong.retry') }}
    </Button>
    <Button v-else-if="active && canUpload" size="sm" variant="outline" :disabled="busy" @click="handleCancel">
      <X class="size-3.5" aria-hidden="true" />
      {{ t('common.cancel') }}
    </Button>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, Loader2, XCircle } from '@lucide/vue'
import type { StorytellerServer, StorytellerTestResult } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import LoadErrorPanel from '@/components/LoadErrorPanel.vue'
import { SECRET_INPUT_ATTRS } from '@/lib/secret-input'
import * as storytellerApi from './api/storyteller.api'

const { t } = useI18n()

const loading = ref(true)
const loadFailed = ref(false)
const saving = ref(false)
const testing = ref(false)
const removing = ref(false)
const confirmRemove = ref(false)
const server = ref<StorytellerServer | null>(null)
const testResult = ref<StorytellerTestResult | null>(null)

const name = ref('Storyteller')
const baseUrl = ref('')
const username = ref('')
// The stored password never comes back to the browser, so an empty field on edit means "keep it".
const password = ref('')
const enabled = ref(true)

const canSave = computed(
  () => name.value.trim() !== '' && baseUrl.value.trim() !== '' && username.value.trim() !== '' && (server.value !== null || password.value !== ''),
)

function applyServer(next: StorytellerServer | null) {
  server.value = next
  password.value = ''
  if (!next) return
  name.value = next.name
  baseUrl.value = next.baseUrl
  username.value = next.username
  enabled.value = next.enabled
}

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    applyServer(await storytellerApi.getStorytellerServer())
  } catch {
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function handleSubmit() {
  if (!canSave.value) {
    toast.error(t('settings.admin.storyteller.formRequired'))
    return
  }
  saving.value = true
  testResult.value = null
  try {
    applyServer(
      await storytellerApi.saveStorytellerServer({
        name: name.value.trim(),
        baseUrl: baseUrl.value.trim(),
        username: username.value.trim(),
        enabled: enabled.value,
        ...(password.value ? { password: password.value } : {}),
      }),
    )
    toast.success(t('settings.admin.storyteller.saved'))
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : t('settings.admin.storyteller.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function handleTest() {
  testing.value = true
  try {
    testResult.value = await storytellerApi.testStorytellerServer()
  } catch (caught) {
    testResult.value = { connected: false, error: caught instanceof Error ? caught.message : String(caught) }
  } finally {
    testing.value = false
  }
}

function handleRequestRemove() {
  confirmRemove.value = true
}

function handleCancelRemove() {
  confirmRemove.value = false
}

async function handleConfirmRemove() {
  removing.value = true
  try {
    await storytellerApi.deleteStorytellerServer()
    applyServer(null)
    baseUrl.value = ''
    username.value = ''
    testResult.value = null
    toast.success(t('settings.admin.storyteller.removed'))
  } catch {
    toast.error(t('settings.admin.storyteller.removeFailed'))
  } finally {
    removing.value = false
    confirmRemove.value = false
  }
}
</script>

<template>
  <div>
    <div v-if="loading" class="flex items-center justify-center py-16">
      <Loader2 class="size-6 animate-spin text-muted-foreground" />
    </div>

    <LoadErrorPanel v-else-if="loadFailed" :message="t('settings.admin.storyteller.loadFailed')" @retry="load" />

    <template v-else>
      <header>
        <h2 class="text-lg font-semibold text-foreground">{{ t('settings.admin.storyteller.title') }}</h2>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.admin.storyteller.subtitle') }}</p>
      </header>

      <form class="mt-5 rounded-xl border border-border bg-card p-5" @submit.prevent="handleSubmit">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="storyteller-name">{{ t('settings.admin.storyteller.formName') }}</label>
            <Input id="storyteller-name" v-model="name" required />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="storyteller-url">{{ t('settings.admin.storyteller.formBaseUrl') }}</label>
            <Input id="storyteller-url" v-model="baseUrl" type="url" :placeholder="t('settings.admin.storyteller.formBaseUrlPlaceholder')" required />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="storyteller-username">{{
              t('settings.admin.storyteller.formUsername')
            }}</label>
            <Input id="storyteller-username" v-model="username" autocomplete="off" required />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground" for="storyteller-password">{{
              t('settings.admin.storyteller.formPassword')
            }}</label>
            <Input id="storyteller-password" v-model="password" v-bind="SECRET_INPUT_ATTRS" type="text" class="input-secret" />
            <p v-if="server?.hasPassword" class="text-xs text-muted-foreground">{{ t('settings.admin.storyteller.formPasswordKeep') }}</p>
          </div>
        </div>

        <label class="mt-4 flex items-center gap-2 text-sm text-foreground">
          <input v-model="enabled" type="checkbox" class="size-4 rounded border-border accent-primary" />
          {{ t('settings.admin.storyteller.formEnabled') }}
        </label>

        <p class="mt-4 text-xs text-muted-foreground">{{ t('settings.admin.storyteller.permissionsHint') }}</p>

        <div class="mt-5 flex flex-wrap items-center gap-2">
          <Button type="submit" :disabled="saving || !canSave">
            <Loader2 v-if="saving" class="size-4 animate-spin" />
            {{ t('common.save') }}
          </Button>
          <Button v-if="server" type="button" variant="outline" :disabled="testing" @click="handleTest">
            <Loader2 v-if="testing" class="size-4 animate-spin" />
            {{ t('settings.admin.storyteller.test') }}
          </Button>
          <Button v-if="server" type="button" variant="outline" :disabled="removing" @click="handleRequestRemove">
            {{ t('settings.admin.storyteller.remove') }}
          </Button>
        </div>

        <p v-if="testResult?.connected" class="mt-3 flex items-center gap-1.5 text-sm text-foreground">
          <CheckCircle2 class="size-4 text-primary" aria-hidden="true" />
          {{ t('settings.admin.storyteller.testOk') }}
        </p>
        <p v-else-if="testResult" class="mt-3 flex items-center gap-1.5 text-sm text-destructive">
          <XCircle class="size-4" aria-hidden="true" />
          {{ testResult.error ?? t('settings.admin.storyteller.testFailed') }}
        </p>
      </form>
    </template>

    <ConfirmDialog
      :open="confirmRemove"
      :title="t('settings.admin.storyteller.remove')"
      :description="t('settings.admin.storyteller.removeConfirm')"
      :confirm-label="t('settings.admin.storyteller.remove')"
      :busy="removing"
      @confirm="handleConfirmRemove"
      @cancel="handleCancelRemove"
    />
  </div>
</template>

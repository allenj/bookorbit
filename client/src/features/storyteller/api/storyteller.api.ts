import { api } from '@/lib/api'
import { readApiErrorDetail } from '@/lib/api-error'
import type { SaveStorytellerServerRequest, StorytellerBookState, StorytellerJob, StorytellerServer, StorytellerTestResult } from '@bookorbit/types'

export class StorytellerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await readApiErrorDetail(response)
    throw new StorytellerApiError(detail ?? `Request failed (${response.status})`, response.status)
  }
  return (await response.json()) as T
}

async function empty(response: Response): Promise<void> {
  if (!response.ok) {
    const detail = await readApiErrorDetail(response)
    throw new StorytellerApiError(detail ?? `Request failed (${response.status})`, response.status)
  }
}

export async function getStorytellerServer(): Promise<StorytellerServer | null> {
  const body = await json<{ server: StorytellerServer | null }>(await api('/api/v1/storyteller/admin/server'))
  return body.server
}

export async function saveStorytellerServer(request: SaveStorytellerServerRequest): Promise<StorytellerServer> {
  return json(
    await api('/api/v1/storyteller/admin/server', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  )
}

export async function deleteStorytellerServer(): Promise<void> {
  await empty(await api('/api/v1/storyteller/admin/server', { method: 'DELETE' }))
}

export async function testStorytellerServer(): Promise<StorytellerTestResult> {
  return json(await api('/api/v1/storyteller/admin/server/test', { method: 'POST' }))
}

export async function getReadAlongState(bookId: number): Promise<StorytellerBookState> {
  return json(await api(`/api/v1/books/${bookId}/storyteller`))
}

export async function startReadAlong(bookId: number): Promise<StorytellerJob> {
  return json(await api(`/api/v1/books/${bookId}/storyteller/jobs`, { method: 'POST' }))
}

export async function retryReadAlong(bookId: number): Promise<StorytellerJob> {
  return json(await api(`/api/v1/books/${bookId}/storyteller/jobs/retry`, { method: 'POST' }))
}

export async function cancelReadAlong(bookId: number): Promise<StorytellerJob> {
  return json(await api(`/api/v1/books/${bookId}/storyteller/jobs/cancel`, { method: 'POST' }))
}

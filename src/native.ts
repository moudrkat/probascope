// The native side: files on the phone and the kneejerk plugin (llama.cpp inside the app).
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Kneejerk } from 'capacitor-kneejerk'
import type { ModelSpec } from './models'

export const isNative = Capacitor.isNativePlatform()

export async function modelPath(spec: ModelSpec): Promise<string> {
  const { uri } = await Filesystem.getUri({ path: spec.file, directory: Directory.Data })
  return uri.replace(/^file:\/\//, '')
}

export async function isDownloaded(spec: ModelSpec): Promise<boolean> {
  try {
    const st = await Filesystem.stat({ path: spec.file, directory: Directory.Data })
    return (st.size ?? 0) > spec.mb * 1e6 * 0.9
  } catch {
    return false
  }
}

export async function download(spec: ModelSpec, onProgress: (fraction: number) => void): Promise<void> {
  const listener = await Filesystem.addListener('progress', (p) => {
    if (p.contentLength > 0) onProgress(p.bytes / p.contentLength)
  })
  try {
    await Filesystem.downloadFile({
      url: spec.url,
      path: spec.file,
      directory: Directory.Data,
      progress: true,
    })
  } finally {
    await listener.remove()
  }
}

export async function remove(spec: ModelSpec): Promise<void> {
  try {
    await Filesystem.deleteFile({ path: spec.file, directory: Directory.Data })
  } catch {
    // already gone
  }
}

export async function load(spec: ModelSpec): Promise<{ modelType: string }> {
  const path = await modelPath(spec)
  return Kneejerk.load({ path, nCtx: 4096 })
}

export async function unload(): Promise<void> {
  await Kneejerk.unload()
}

export interface Decision {
  response: Record<string, unknown>
  wallMs: number
}

export async function decide(request: unknown): Promise<Decision> {
  const { response, wallMs } = await Kneejerk.decide({ request: JSON.stringify(request) })
  return { response: JSON.parse(response), wallMs }
}

export interface LayerInfo {
  i: number
  kind: 'shortconv' | 'recurrent' | 'attention' | 'attention_swa'
  decision_head: boolean
}

export interface ModelInfo {
  model: string
  name: string
  architecture: string
  description: string
  decision_type: string
  n_params: number
  size_bytes: number
  n_layer: number
  n_layer_decision: number
  n_embd: number
  n_head: number
  n_head_kv: number
  n_vocab: number
  n_ctx_train: number
  n_ctx: number
  layers: LayerInfo[]
}

export async function modelInfo(): Promise<ModelInfo> {
  const { info } = await Kneejerk.modelInfo()
  return JSON.parse(info)
}

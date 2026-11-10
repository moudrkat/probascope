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
    return (st.size ?? 0) > spec.mb * 1e6 * 0.99
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

// repacked weights are faster but take about twice the file in RAM; without enough free memory Android would
// kill the app silently, so load plain weights instead and say so
export async function load(spec: ModelSpec): Promise<{ modelType: string; repack: boolean }> {
  const path = await modelPath(spec)
  let repack = true
  try {
    // by the phone's total RAM, not what is free right now: Android keeps other apps' pages cached and evicts
    // them when a model needs the room. Repacking doubles the file in RAM; leave the system 2 GB.
    const m = await Kneejerk.memory()
    if (m.totalMem > 0 && m.totalMem < spec.mb * 1e6 * 2.2 + 2e9) repack = false
  } catch {
    // older plugin: keep the default
  }
  const r = await Kneejerk.load({ path, nCtx: 4096, repack })
  return { modelType: r.modelType, repack }
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
  bytes: number
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
  bytes_outside_blocks: number
  layers: LayerInfo[]
}

export async function modelInfo(): Promise<ModelInfo> {
  const { info } = await Kneejerk.modelInfo()
  return JSON.parse(info)
}

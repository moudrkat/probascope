// The models the app offers, downloaded from Hugging Face into the app's data directory.
// Sizes are the GGUF file sizes; RAM at run time is about double with weight repacking on ARM.

export interface ModelSpec {
  id: string
  name: string
  file: string
  url: string
  mb: number
  blurb: string
  layers: boolean // whether the per-layer readout works (label-token models)
}

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

export const MODELS: ModelSpec[] = [
  {
    id: 'd1-omni-600m',
    name: 'd1-omni 600M',
    file: 'd1-omni-600M-Q8_0.gguf',
    url: hf('LiquidAI/d1-omni-600M-GGUF', 'd1-omni-600M-Q8_0.gguf'),
    mb: 407,
    blurb: 'Liquid AI, the smallest and fastest. Answers through its own decision head, so no layer curve yet.',
    layers: false,
  },
  {
    id: 'd1-2b',
    name: 'd1 2B',
    file: 'd1-2B-Q4_K_M.gguf',
    url: hf('LiquidAI/d1-2B-GGUF', 'd1-2B-Q4_K_M.gguf'),
    mb: 1100,
    blurb: 'Liquid AI. The full layer curve, and the one to compare against. About 2 GB of RAM while loaded.',
    layers: true,
  },
  {
    id: 'vllm-d3-edge',
    name: 'vllm-d3 edge',
    file: 'vllm-d3-edge-Q8_0.gguf',
    url: hf('ggml-org/vllm-d3-edge-GGUF', 'vllm-d3-edge-Q8_0.gguf'),
    mb: 806,
    blurb: 'ggml-org, a different family. The full layer curve, 806 MB, non-causal attention.',
    layers: true,
  },
  {
    id: 'kev-0.8b',
    name: 'Kev 0.8B',
    file: 'Kev-0.8B-Q8_0.gguf',
    url: hf('ggml-org/Kev-0.8B-GGUF', 'Kev-0.8B-Q8_0.gguf'),
    mb: 812,
    blurb: 'ggml-org. Reads its answer from an embedding, so no layer curve yet.',
    layers: false,
  },
  {
    id: 'h2o-lightning-4b',
    name: 'H2O Lightning 4B',
    file: 'h2o-lightning-4b-IQ3_XXS.gguf',
    url: hf('h2oai/h2o-lightning-4b-gguf', 'h2o-lightning-4b-IQ3_XXS.gguf'),
    mb: 1904,
    blurb: 'H2O, the biggest here. Slow on a phone, needs a lot of RAM; for comparing, not for daily use.',
    layers: true,
  },
  {
    id: 'laya',
    name: 'Laya',
    file: 'Laya-Q8_0.gguf',
    url: hf('ggml-org/Laya-GGUF', 'Laya-Q8_0.gguf'),
    mb: 449,
    blurb: 'ggml-org. Reads its answer from a pooled embedding, so no layer curve yet.',
    layers: false,
  },
]

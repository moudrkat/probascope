<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { MODELS, type ModelSpec } from './models'
import { decide, download, isDownloaded, isNative, load, modelInfo, remove, type LayerInfo, type ModelInfo } from './native'

type Tab = 'decide' | 'layers' | 'inside'

const tab = ref<Tab>('decide')
const pickingModel = ref(false)
const current = ref<ModelSpec | null>(null)
const modelType = ref('')
const info = ref<ModelInfo | null>(null)
const status = reactive<Record<string, { downloaded: boolean; progress: number | null; loading: boolean }>>({})
const error = ref('')

const stateText = ref('order cat food, the usual. actually the cat just ordered it herself, she has my phone')
const question = ref('What should the agent do next?')
const options = ref<string[]>(['place the order', 'just reply', 'escalate to a human'])

interface Result {
  type: 'choice' | 'noul'
  keys: string[]
  final: number[]
  rows: (number[] | null)[]
  ms: (number | null)[]
  forwardMs: number
  readoutMs: number
  layersError: string
  wallMs: number
  tokens: number
}
const result = ref<Result | null>(null)
const busy = ref(false)
const wantLayers = ref(true) // the per-layer readout costs time on a phone; off = a plain decision
const lensAt = ref<number | null>(null)
const pickedBlock = ref<number | null>(null)

for (const m of MODELS) status[m.id] = { downloaded: false, progress: null, loading: false }

onMounted(async () => {
  if (!isNative) return
  for (const m of MODELS) status[m.id].downloaded = await isDownloaded(m)
  const first = MODELS.find((m) => status[m.id].downloaded)
  if (first) await useModel(first)
  else pickingModel.value = true
})

async function useModel(spec: ModelSpec) {
  error.value = ''
  const st = status[spec.id]
  try {
    if (!st.downloaded) {
      st.progress = 0
      await download(spec, (f) => (st.progress = f))
      st.downloaded = await isDownloaded(spec)
      st.progress = null
      if (!st.downloaded) throw new Error('download did not complete')
    }
    st.loading = true
    const r = await load(spec)
    current.value = spec
    modelType.value = r.modelType
    info.value = await modelInfo()
    result.value = null
    pickingModel.value = false
  } catch (e) {
    error.value = String((e as Error).message ?? e)
    st.progress = null
  } finally {
    st.loading = false
  }
}

async function forget(spec: ModelSpec) {
  await remove(spec)
  status[spec.id].downloaded = false
  if (current.value?.id === spec.id) {
    current.value = null
    info.value = null
    result.value = null
  }
}

// a field that grows downward with its text, so long options stay readable
function grow(ev: Event) {
  const el = ev.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}
function addOption() {
  if (options.value.length < 6) options.value.push('')
}
function dropOption(i: number) {
  options.value.splice(i, 1)
}

async function run() {
  if (!current.value || busy.value) return
  error.value = ''
  busy.value = true
  lensAt.value = null
  try {
    const keys = options.value.map((o) => o.trim()).filter(Boolean)
    const q: Record<string, unknown> =
      keys.length >= 2
        ? { type: 'choice', instructions: question.value, criteria: Object.fromEntries(keys.map((k) => [k, k])) }
        : { type: 'noul', instructions: question.value }
    const withLayers = current.value.layers && wantLayers.value
    const request = { state: stateText.value, questions: { q }, layers: withLayers }
    const { response, wallMs } = await decide(request)
    if (response.error) throw new Error((response.error as { message: string }).message)
    const answers = response.answers as Record<string, Record<string, unknown>>
    const a = answers.q
    const layers = (a.layers ?? {}) as { error?: string; options?: string[]; probabilities?: (number[] | number | null)[]; ms?: (number | null)[]; timings?: { forward_ms: number; readout_ms: number } }
    const usage = response.usage as { input_tokens: number }
    if (a.type === 'noul') {
      const rows = (layers.probabilities ?? []).map((p) => (typeof p === 'number' ? [p] : null))
      result.value = { type: 'noul', keys: ['yes'], final: [a.noul as number], rows, ms: layers.ms ?? [], forwardMs: layers.timings?.forward_ms ?? 0, readoutMs: layers.timings?.readout_ms ?? 0, layersError: layers.error ?? '', wallMs, tokens: usage.input_tokens }
    } else {
      const probs = a.probabilities as Record<string, number>
      const rows = (layers.probabilities ?? []).map((p) => (Array.isArray(p) ? p : null))
      result.value = { type: 'choice', keys, final: keys.map((k) => probs[k]), rows, ms: layers.ms ?? [], forwardMs: layers.timings?.forward_ms ?? 0, readoutMs: layers.timings?.readout_ms ?? 0, layersError: layers.error ?? '', wallMs, tokens: usage.input_tokens }
    }
    if (!current.value.layers && !result.value.layersError) result.value.layersError = 'this model reads its answer from a pooled embedding, no layer curve yet'
    if (!withLayers && !result.value.layersError) result.value.layersError = 'layers are off, switch them on and decide again'
  } catch (e) {
    error.value = String((e as Error).message ?? e)
  } finally {
    busy.value = false
  }
}

// what the bars show: the final answer, or the answer of the layer under the finger
const shown = computed(() => {
  const r = result.value
  if (!r) return []
  const at = lensAt.value
  const p = at !== null && r.rows[at] ? r.rows[at]! : r.final
  const best = p.indexOf(Math.max(...p))
  return r.keys.map((k, i) => ({ key: k, p: p[i], win: i === best }))
})

// the curve: one series per option, x = layer, y = probability
const W = 448, H = 170, PX = 8, PT = 8, PB = 42 // PB holds the block strip and the axis labels
const curve = computed(() => {
  const r = result.value
  if (!r || r.layersError || !r.rows.length) return null
  const L = r.rows.length
  const iw = W - 2 * PX, ih = H - PT - PB
  const x = (i: number) => PX + (iw * i) / Math.max(1, L - 1)
  const y = (v: number) => PT + ih * (1 - v)
  const best = r.final.indexOf(Math.max(...r.final))
  const series = r.keys.map((k, j) => ({
    key: k,
    win: j === best,
    d: r.rows.map((row, i) => (row ? `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(row[j]).toFixed(1)}` : '')).filter(Boolean).join(' '),
  }))
  const at = lensAt.value ?? L - 1
  const row = r.rows[at]
  const blocks = (info.value?.layers ?? []).slice(0, L).map((l) => ({ i: l.i, kind: l.kind, head: l.decision_head, bytes: l.bytes }))
  const maxB = Math.max(1, ...blocks.map((b) => b.bytes))
  const slot = iw / Math.max(1, L - 1)
  const strip = blocks.map((b) => ({
    ...b,
    x: x(b.i) - slot * 0.42,
    w: slot * 0.84,
    h: 6 + 10 * (b.bytes / maxB),
    fill: b.head ? '#3dbd7d' : b.kind.startsWith('attention') ? '#e8b45a' : '#2b3d5c',
  }))
  const block = blocks[at]
  const ms = r.ms[at]
  return { L, x, y, series, at, dotY: row ? y(row[best]) : null, p: row ? row[best] : null, best, strip, block, ms }
})

const svgEl = ref<SVGSVGElement | null>(null)
let dragging = false
function pick(ev: PointerEvent) {
  const c = curve.value
  if (!c || !svgEl.value) return
  const r = svgEl.value.getBoundingClientRect()
  const fx = ((ev.clientX - r.left) / r.width) * W
  const i = Math.round(((fx - PX) / (W - 2 * PX)) * (c.L - 1))
  lensAt.value = Math.max(0, Math.min(c.L - 1, i))
}
function down(ev: PointerEvent) { dragging = true; pick(ev) }
function move(ev: PointerEvent) { if (dragging) pick(ev) }
function up() { dragging = false }

const KIND_TEXT: Record<LayerInfo['kind'], string> = {
  shortconv: 'A gated short convolution. Each word is mixed with a few words just before it. Cheap and local, most of the stack is this.',
  recurrent: 'A recurrent block. The state is carried along the text, one word at a time.',
  attention: 'Attention. Every word can read any earlier word in the whole text. This is where distant words meet.',
  attention_swa: 'Sliding-window attention. Every word reads a window of earlier words, not the whole text.',
}
// replay: the blocks light up in the order and tempo your phone computed them (stretched to at least 2 s)
const lit = ref<number>(-1)
let replayTimer: ReturnType<typeof setTimeout> | null = null
function replay() {
  const r = result.value
  if (!r || !r.ms.length) return
  if (replayTimer) clearTimeout(replayTimer)
  const ms = r.ms.map((v) => v ?? 0)
  const total = Math.max(...ms)
  const scale = total > 0 ? Math.max(1, 2000 / total) : 1
  lit.value = -1
  ms.forEach((t, i) => {
    setTimeout(() => (lit.value = i), t * scale)
  })
  replayTimer = setTimeout(() => (lit.value = -1), total * scale + 1500)
}
const replayNote = computed(() => {
  const r = result.value
  if (!r || !r.ms.length) return ''
  const total = Math.max(...r.ms.map((v) => v ?? 0))
  return `your text went through all ${r.ms.length} blocks in ${total.toFixed(0)} ms`
})
const maxBytes = computed(() => (info.value ? Math.max(1, ...info.value.layers.map((l) => l.bytes)) : 1))
const picked = computed(() => (info.value && pickedBlock.value !== null ? info.value.layers[pickedBlock.value] : null))
const fmtM = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' B' : (n / 1e6).toFixed(0) + ' M')
const fmtMB = (n: number) => (n / 1e6).toFixed(0) + ' MB'
</script>

<template>
  <div class="wrap">
    <header>
      <div class="wordmark">proba<b>scope</b></div>
      <button class="chip" :class="{ off: !current }" @click="pickingModel = !pickingModel">
        <i>●</i> {{ current ? current.name : 'pick a model' }}
      </button>
    </header>

    <p v-if="!isNative" class="note">This is the web build. The models run natively inside the Android app; install the APK from the releases page.</p>

    <section v-if="pickingModel || !current" class="models">
      <button v-for="m in MODELS" :key="m.id" class="model" :class="{ on: current?.id === m.id }" @click="useModel(m)" :disabled="status[m.id].loading || status[m.id].progress !== null">
        <span>{{ m.name }}</span>
        <span class="st" :class="{ live: current?.id === m.id }">
          {{ status[m.id].loading ? 'loading' : status[m.id].progress !== null ? Math.round(status[m.id].progress! * 100) + ' %' : status[m.id].downloaded ? (current?.id === m.id ? 'loaded' : 'ready') : fmtMB(m.mb * 1e6) }}
        </span>
        <span class="sub">{{ m.blurb }}</span>
        <span v-if="status[m.id].progress !== null" class="prog"><span :style="{ width: status[m.id].progress! * 100 + '%' }"></span></span>
      </button>
      <p class="note" v-if="current">tap a model to switch · <a href="#" @click.prevent="forget(current!)">delete {{ current.name }} from the phone</a></p>
    </section>

    <p v-if="error" class="err">{{ error }}</p>

    <template v-if="current">
      <textarea id="state" v-model="stateText" rows="3" placeholder="paste anything"></textarea>
      <input id="question" v-model="question" placeholder="ask one question (no options = yes/no)">
      <div class="opts">
        <textarea v-for="(_, i) in options" :key="i" v-model="options[i]" rows="1" :placeholder="'option ' + (i + 1)" @input="grow" @focus="grow" @keydown.backspace="options[i] === '' && dropOption(i)"></textarea>
        <button v-if="options.length < 6" @click="addOption">+</button>
      </div>

      <nav class="tabs">
        <button class="tab" :class="{ on: tab === 'decide' }" @click="tab = 'decide'">answer</button>
        <button class="tab" :class="{ on: tab === 'layers' }" @click="tab = 'layers'">layers</button>
        <button class="tab" :class="{ on: tab === 'inside' }" @click="tab = 'inside'">inside</button>
        <button class="tab sw" :class="{ on: wantLayers }" @click="wantLayers = !wantLayers" title="read every layer during decide">{{ wantLayers ? 'layers on' : 'layers off' }}</button>
      </nav>

      <section v-if="tab !== 'inside' && result" class="answer">
        <div v-for="o in shown" :key="o.key" class="row" :class="{ win: o.win }">
          <span class="nm">{{ o.key }}</span><span class="p">{{ o.p.toFixed(2) }}</span>
          <div class="bar"><span :style="{ width: o.p * 100 + '%' }"></span></div>
        </div>
        <p class="note">{{ result.tokens }} tokens · {{ result.wallMs.toFixed(0) }} ms{{ result.rows.length ? ` with layers (forward ${result.forwardMs.toFixed(0)}, readout ${result.readoutMs.toFixed(0)})` : '' }} · {{ modelType }}<span v-if="lensAt !== null"> · as read at layer {{ lensAt }}</span></p>
      </section>
      <p v-else-if="tab !== 'inside'" class="note">write a state and a question, then decide</p>

      <section v-if="tab === 'layers' && result" class="trace">
        <template v-if="curve">
          <div class="hd"><span>drag over the model</span><span class="at">block {{ curve.at }}<template v-if="curve.block"> · {{ curve.block.head ? 'head' : curve.block.kind === 'attention_swa' ? 'attention' : curve.block.kind }}</template> · {{ curve.p !== null ? curve.p.toFixed(2) : '–' }}<template v-if="curve.ms != null"> · {{ curve.ms.toFixed(0) }} ms</template></span></div>
          <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @pointerleave="up">
            <line v-for="v in [0, 0.5, 1]" :key="v" :x1="PX" :x2="W - PX" :y1="curve.y(v)" :y2="curve.y(v)" stroke="#1d2b42" stroke-width="1" />
            <rect v-for="b in curve.strip" :key="b.i" :x="b.x" :y="H - PB + 20 - b.h" :width="b.w" :height="b.h" rx="1.5" :fill="b.fill" :opacity="b.i === curve.at ? 1 : 0.55" />
            <text :x="PX" :y="H - 4" fill="#5c6b80" font-size="10">in</text>
            <text :x="W - PX" :y="H - 4" fill="#5c6b80" font-size="10" text-anchor="end">out</text>
            <path v-for="s in curve.series" :key="s.key" :d="s.d" fill="none" :stroke="s.win ? '#e8b45a' : '#8fa0b5'" :stroke-width="s.win ? 2.4 : 1.4" :stroke-dasharray="s.win ? undefined : '3 3'" />
            <line :x1="curve.x(curve.at)" :x2="curve.x(curve.at)" :y1="PT" :y2="H - PB" stroke="#e9eef5" stroke-width="1" stroke-dasharray="2 3" />
            <circle v-if="curve.dotY !== null" :cx="curve.x(curve.at)" :cy="curve.dotY" r="4" fill="#e8b45a" />
          </svg>
          <p class="note">the strip is the model itself: grey short convolutions, amber attention, green the decision head, each as big as its weights. The curve above is what the output head would read after each block. Amber line: the final choice. Early blocks can mislead, the head was trained on the last one.</p>
        </template>
        <p v-else class="note">{{ result.layersError || 'no layer readout' }}</p>
      </section>

      <section v-if="tab === 'inside' && info" class="arch">
        <dl class="facts">
          <dt>model</dt><dd>{{ info.name }}</dd>
          <dt>file</dt><dd>{{ info.model }} · {{ fmtMB(info.size_bytes) }}</dd>
          <dt>params</dt><dd>{{ fmtM(info.n_params) }}</dd>
          <dt>blocks</dt><dd>{{ info.n_layer }}<span v-if="info.n_layer_decision"> · {{ info.n_layer_decision }} in the decision head</span></dd>
          <dt>width</dt><dd>{{ info.n_embd }} · {{ info.n_head }} heads</dd>
          <dt>vocab</dt><dd>{{ info.n_vocab }} tokens · {{ info.n_ctx_train }} context</dd>
          <dt>reads</dt><dd>{{ info.decision_type }}</dd>
        </dl>
        <p class="note">the blocks your text went through, bottom first, drawn to the size of their weights · tap one<template v-if="result && result.ms.length"> · <a href="#" @click.prevent="replay">replay</a>: {{ replayNote }}</template></p>
        <div v-if="picked" class="expl">
          <b>block {{ picked.i }} · {{ picked.kind === 'attention_swa' ? 'attention (window)' : picked.kind }}</b>
          <span>{{ KIND_TEXT[picked.kind] }}</span>
          <span v-if="picked.decision_head">One of the {{ info.n_layer_decision }} trailing blocks trained for answering. Everything below is the backbone it shares with the chat model.</span>
          <span v-if="picked.kind.startsWith('attention')">{{ info.n_head }} heads of {{ Math.round(info.n_embd / info.n_head) }} numbers each, {{ info.n_head_kv }} key/value heads.</span>
        </div>
        <div class="cap out">
          <span class="arr">↑</span>
          <span v-if="result">out · {{ result.keys.length }} score{{ result.keys.length > 1 ? 's' : '' }} ({{ result.type === 'noul' ? 'yes / no' : result.keys.join(' / ') }}) → softmax → {{ shown.find(o => o.win)?.key }} {{ shown.find(o => o.win)?.p.toFixed(2) }}</span>
          <span v-else>out · one score per option from the last position → softmax → the answer</span>
        </div>
        <div class="stack">
          <button v-for="l in [...info.layers].reverse()" :key="l.i" class="blk" :class="[l.kind, { head: l.decision_head, on: pickedBlock === l.i, lit: lit >= l.i }]" @click="pickedBlock = pickedBlock === l.i ? null : l.i">
            <span class="i">{{ l.i }}</span><span class="k" :style="{ width: Math.max(8, (100 * l.bytes) / maxBytes) + '%' }"></span><span class="t">{{ fmtMB(l.bytes) }} · {{ l.kind === 'attention_swa' ? 'attention (window)' : l.kind }}{{ l.decision_head ? ' · head' : '' }}</span>
          </button>
        </div>
        <div class="cap in">
          <span class="arr">↑</span>
          <span v-if="result">in · {{ result.tokens }} tokens × {{ info.n_embd }} numbers each = {{ (result.tokens * info.n_embd).toLocaleString() }} numbers for your text · embeddings {{ fmtMB(info.bytes_outside_blocks) }}</span>
          <span v-else>in · the text as tokens, {{ info.n_embd }} numbers each</span>
        </div>
      </section>
      <p v-else-if="tab === 'inside'" class="note">no model loaded</p>
    </template>

    <div class="run" v-if="current">
      <button id="run" :disabled="busy || !stateText.trim() || !question.trim()" @click="run">
        {{ busy ? 'deciding' : 'decide' }} <small v-if="result && !busy">· {{ result.wallMs.toFixed(0) }} ms</small>
      </button>
    </div>
  </div>
</template>

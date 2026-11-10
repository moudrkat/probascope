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
  layersError: string
  wallMs: number
  tokens: number
}
const result = ref<Result | null>(null)
const busy = ref(false)
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
    const request = { state: stateText.value, questions: { q }, layers: current.value.layers }
    const { response, wallMs } = await decide(request)
    if (response.error) throw new Error((response.error as { message: string }).message)
    const answers = response.answers as Record<string, Record<string, unknown>>
    const a = answers.q
    const layers = (a.layers ?? {}) as { error?: string; options?: string[]; probabilities?: (number[] | number | null)[] }
    const usage = response.usage as { input_tokens: number }
    if (a.type === 'noul') {
      const rows = (layers.probabilities ?? []).map((p) => (typeof p === 'number' ? [p] : null))
      result.value = { type: 'noul', keys: ['yes'], final: [a.noul as number], rows, layersError: layers.error ?? '', wallMs, tokens: usage.input_tokens }
    } else {
      const probs = a.probabilities as Record<string, number>
      const rows = (layers.probabilities ?? []).map((p) => (Array.isArray(p) ? p : null))
      result.value = { type: 'choice', keys, final: keys.map((k) => probs[k]), rows, layersError: layers.error ?? '', wallMs, tokens: usage.input_tokens }
    }
    if (!current.value.layers && !result.value.layersError) result.value.layersError = 'this model reads its answer from a pooled embedding, no layer curve yet'
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
const W = 448, H = 150, PX = 8, PT = 8, PB = 22
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
  return { L, x, y, series, at, dotY: row ? y(row[best]) : null, p: row ? row[best] : null, best }
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
        <input v-for="(_, i) in options" :key="i" v-model="options[i]" :placeholder="'option ' + (i + 1)" @keydown.backspace="options[i] === '' && dropOption(i)">
        <button v-if="options.length < 6" @click="addOption">+</button>
      </div>

      <nav class="tabs">
        <button class="tab" :class="{ on: tab === 'decide' }" @click="tab = 'decide'">answer</button>
        <button class="tab" :class="{ on: tab === 'layers' }" @click="tab = 'layers'">layers</button>
        <button class="tab" :class="{ on: tab === 'inside' }" @click="tab = 'inside'">inside</button>
      </nav>

      <section v-if="tab !== 'inside' && result" class="answer">
        <div v-for="o in shown" :key="o.key" class="row" :class="{ win: o.win }">
          <span class="nm">{{ o.key }}</span><span class="p">{{ o.p.toFixed(2) }}</span>
          <div class="bar"><span :style="{ width: o.p * 100 + '%' }"></span></div>
        </div>
        <p class="note">{{ result.tokens }} tokens · {{ result.wallMs.toFixed(0) }} ms · {{ modelType }}<span v-if="lensAt !== null"> · as read at layer {{ lensAt }}</span></p>
      </section>
      <p v-else-if="tab !== 'inside'" class="note">write a state and a question, then decide</p>

      <section v-if="tab === 'layers' && result" class="trace">
        <template v-if="curve">
          <div class="hd"><span>drag: where it decided</span><span class="at">layer {{ curve.at }} · {{ curve.p !== null ? curve.p.toFixed(2) : '–' }}</span></div>
          <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @pointerleave="up">
            <line v-for="v in [0, 0.5, 1]" :key="v" :x1="PX" :x2="W - PX" :y1="curve.y(v)" :y2="curve.y(v)" stroke="#1d2b42" stroke-width="1" />
            <text :x="PX" :y="H - 6" fill="#5c6b80" font-size="10">0</text>
            <text :x="W - PX" :y="H - 6" fill="#5c6b80" font-size="10" text-anchor="end">layer {{ curve.L - 1 }}</text>
            <path v-for="s in curve.series" :key="s.key" :d="s.d" fill="none" :stroke="s.win ? '#e8b45a' : '#8fa0b5'" :stroke-width="s.win ? 2.4 : 1.4" :stroke-dasharray="s.win ? undefined : '3 3'" />
            <line :x1="curve.x(curve.at)" :x2="curve.x(curve.at)" :y1="PT" :y2="H - PB" stroke="#e9eef5" stroke-width="1" stroke-dasharray="2 3" />
            <circle v-if="curve.dotY !== null" :cx="curve.x(curve.at)" :cy="curve.dotY" r="4" fill="#e8b45a" />
          </svg>
          <p class="note">each point: what the output head reads from that layer. Amber is the final choice. Early layers can mislead: the head was trained on the last one.</p>
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
        <p class="note">the blocks your text went through, bottom first · tap one</p>
        <div class="stack">
          <button v-for="l in [...info.layers].reverse()" :key="l.i" class="blk" :class="[l.kind, { head: l.decision_head, on: pickedBlock === l.i }]" @click="pickedBlock = pickedBlock === l.i ? null : l.i">
            <span class="i">{{ l.i }}</span><span class="k"></span><span class="t">{{ l.kind === 'attention_swa' ? 'attention (window)' : l.kind }}{{ l.decision_head ? ' · head' : '' }}</span>
          </button>
        </div>
        <div v-if="picked" class="expl">
          <b>block {{ picked.i }} · {{ picked.kind === 'attention_swa' ? 'attention (window)' : picked.kind }}</b>
          <span>{{ KIND_TEXT[picked.kind] }}</span>
          <span v-if="picked.decision_head">One of the {{ info.n_layer_decision }} trailing blocks trained for answering. Everything below is the backbone it shares with the chat model.</span>
          <span v-if="picked.kind.startsWith('attention')">{{ info.n_head }} heads of {{ Math.round(info.n_embd / info.n_head) }} numbers each, {{ info.n_head_kv }} key/value heads.</span>
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

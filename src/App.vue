<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { MODELS, type ModelSpec } from './models'
import { lastError } from './errors'
import { decide, download, isDownloaded, isNative, load, modelInfo, remove, type LayerInfo, type ModelInfo } from './native'

type Tab = 'answer' | 'layers' | 'inside'

const tab = ref<Tab>('answer')
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
  tokens_: string[]
  change: number[][]
  attention: Record<string, number[][]>
  layersError: string
  wallMs: number
  tokens: number
}
const result = ref<Result | null>(null)
const editing = ref(true) // the inputs fold into one line after a decision; tap to edit again
const ghost = ref<Result | null>(null) // the previous run, drawn dashed under the new curve
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
  if (result.value && result.value.rows.length) ghost.value = result.value
  try {
    const keys = options.value.map((o) => o.trim()).filter(Boolean)
    const q: Record<string, unknown> =
      keys.length >= 2
        ? { type: 'choice', instructions: question.value, criteria: Object.fromEntries(keys.map((k) => [k, k])) }
        : { type: 'noul', instructions: question.value }
    const withLayers = current.value.layers
    const request = { state: stateText.value, questions: { q }, layers: withLayers }
    const { response, wallMs } = await decide(request)
    if (response.error) throw new Error((response.error as { message: string }).message)
    const answers = response.answers as Record<string, Record<string, unknown>>
    const a = answers.q
    const layers = (a.layers ?? {}) as { error?: string; options?: string[]; probabilities?: (number[] | number | null)[]; ms?: (number | null)[]; timings?: { forward_ms: number; readout_ms: number }; tokens?: string[]; token_change?: number[][]; attention?: Record<string, number[][]> }
    const usage = response.usage as { input_tokens: number }
    if (a.type === 'noul') {
      const rows = (layers.probabilities ?? []).map((p) => (typeof p === 'number' ? [p] : null))
      result.value = { type: 'noul', keys: ['yes'], final: [a.noul as number], rows, ms: layers.ms ?? [], forwardMs: layers.timings?.forward_ms ?? 0, readoutMs: layers.timings?.readout_ms ?? 0, tokens_: layers.tokens ?? [], change: layers.token_change ?? [], attention: layers.attention ?? {}, layersError: layers.error ?? '', wallMs, tokens: usage.input_tokens }
    } else {
      const probs = a.probabilities as Record<string, number>
      const rows = (layers.probabilities ?? []).map((p) => (Array.isArray(p) ? p : null))
      result.value = { type: 'choice', keys, final: keys.map((k) => probs[k]), rows, ms: layers.ms ?? [], forwardMs: layers.timings?.forward_ms ?? 0, readoutMs: layers.timings?.readout_ms ?? 0, tokens_: layers.tokens ?? [], change: layers.token_change ?? [], attention: layers.attention ?? {}, layersError: layers.error ?? '', wallMs, tokens: usage.input_tokens }
    }
    if (!current.value.layers && !result.value.layersError) result.value.layersError = 'no layer curve for this model yet'
    editing.value = false
  } catch (e) {
    error.value = String((e as Error).message ?? e)
  } finally {
    busy.value = false
  }
}

// one colour per option, the same in the bars, the curve and the legend: amber is the answer, the others get their own
const OPTION_COLORS = ['#6ea8fe', '#c084fc', '#f472b6', '#2dd4bf', '#8fa0b5']
const colors = computed(() => {
  const r = result.value
  if (!r) return []
  const best = r.final.indexOf(Math.max(...r.final))
  let n = 0
  return r.keys.map((_, j) => (j === best ? '#e8b45a' : OPTION_COLORS[n++ % OPTION_COLORS.length]))
})

// what the bars show: the final answer, or the answer of the layer under the finger
const shown = computed(() => {
  const r = result.value
  if (!r) return []
  const at = lensAt.value
  const p = at !== null && r.rows[at] ? r.rows[at]! : r.final
  const best = r.final.indexOf(Math.max(...r.final))
  return r.keys.map((k, i) => ({ key: k, p: p[i], win: i === best, color: colors.value[i] }))
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
    color: colors.value[j],
    final: r.final[j],
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
    fill: b.head ? '#3dbd7d' : b.kind.startsWith('attention') ? '#c7d2e0' : '#3a5078',
  }))
  const block = blocks[at]
  const ms = r.ms[at]
  const g = ghost.value
  const sameRun = g && g.rows.length === L && g.keys.join('\u0001') === r.keys.join('\u0001')
  const ghosts = sameRun
    ? r.keys.map((k, j) => ({
        key: k,
        color: colors.value[j],
        final: g!.final[j],
        d: g!.rows.map((row, i) => (row ? `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(row[j]).toFixed(1)}` : '')).filter(Boolean).join(' '),
      }))
    : []
  return { L, x, y, series, at, dotY: row ? y(row[best]) : null, p: row ? row[best] : null, best, strip, block, ms, ghosts }
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
  return `${total.toFixed(0)} ms through ${r.ms.length} blocks`
})
const maxBytes = computed(() => (info.value ? Math.max(1, ...info.value.layers.map((l) => (Number.isFinite(l.bytes) ? l.bytes : 0))) : 1))
const picked = computed(() => (info.value && pickedBlock.value !== null ? info.value.layers[pickedBlock.value] : null))
const pickedHead = ref<number | null>(null)
watch(pickedBlock, () => (pickedHead.value = null))

// the body of the model: one row per block (top = out), one cell per token of your prompt, amber = how much
// the block moved that token. Drawn on a canvas; a finger over it picks the block under it.
const canvasEl = ref<HTMLCanvasElement | null>(null)
const ROW_MIN = 16, ROW_PER_BYTE = 14
const rows = computed(() => {
  if (!info.value) return []
  const mb = maxBytes.value
  let y = 0
  const out = [...info.value.layers].reverse().map((l) => {
    const h = ROW_MIN + ROW_PER_BYTE * (Number.isFinite(l.bytes) ? l.bytes / mb : 0)
    const r = { i: l.i, kind: l.kind, head: l.decision_head, y, h }
    y += h + 1
    return r
  })
  return out
})
const bodyHeight = computed(() => (rows.value.length ? rows.value[rows.value.length - 1].y + rows.value[rows.value.length - 1].h : 0))
function draw() {
  const c = canvasEl.value
  if (!c || !info.value) return
  const dpr = window.devicePixelRatio || 1
  const cssW = c.clientWidth || c.parentElement?.clientWidth || 400
  const cssH = bodyHeight.value
  if (!(cssH > 0) || !(cssW > 0)) return
  // resize the bitmap only when needed: resizing fires the ResizeObserver, which would call draw again forever
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr)
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph }
  if (c.style.height !== cssH + 'px') c.style.height = cssH + 'px'
  const g = c.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, cssW, cssH)
  const r = result.value
  const nTok = r && r.change.length ? r.tokens_.length : 0
  const cw = nTok ? cssW / nTok : cssW
  // how much work each block did on this text: its mean move over the tokens, scaled to the busiest block
  const work = rows.value.map((row) => (nTok ? (r!.change[row.i] ?? []).reduce((a, b) => a + b, 0) / nTok : 0))
  const maxWork = Math.max(1e-6, ...work)
  g.font = '600 10px ui-monospace, Menlo, Consolas, monospace'
  g.textBaseline = 'middle'
  rows.value.forEach((row, k) => {
    const dim = lit.value >= 0 && row.i > lit.value
    const tint = row.head ? '61,189,125' : row.kind.startsWith('attention') ? '199,210,224' : '58,80,120'
    const w = nTok ? work[k] / maxWork : 0.5
    const alpha = dim ? 0.06 : 0.14 + 0.5 * w
    g.fillStyle = `rgba(${tint},${alpha})`
    g.fillRect(0, row.y, cssW, row.h)
    if (nTok && pickedBlock.value === row.i) {
      const ch = r!.change[row.i] ?? []
      for (let t = 0; t < nTok; t++) {
        const a = ch[t] ?? 0
        if (a <= 0.02) continue
        g.fillStyle = `rgba(233,238,245,${0.15 + 0.85 * a})`
        g.fillRect(t * cw, row.y, Math.max(1, cw - 0.5), row.h)
      }
    }
    const label = `#${row.i} ${row.head ? 'decision head' : row.kind.startsWith('attention') ? 'attention' : row.kind === 'shortconv' ? 'short conv' : row.kind}`
    g.fillStyle = pickedBlock.value === row.i ? '#0b1018' : 'rgba(233,238,245,0.85)'
    if (pickedBlock.value === row.i) {
      // a plate behind the label so it stays readable over the heat
      const tw = g.measureText(label).width + 10
      g.fillStyle = 'rgba(233,238,245,0.92)'
      g.fillRect(4, row.y + row.h / 2 - 7, tw, 14)
      g.fillStyle = '#0b1018'
    }
    g.fillText(label, 9, row.y + row.h / 2 + 0.5)
    if (pickedBlock.value === row.i) {
      g.strokeStyle = '#e9eef5'; g.lineWidth = 1.5
      g.strokeRect(0.75, row.y + 0.75, cssW - 1.5, row.h - 1.5)
    }
  })
}
let drawing = false
const safeDraw = () => { if (drawing) return; drawing = true; try { draw() } finally { drawing = false } }
const redraw = () => { nextTick(safeDraw); requestAnimationFrame(safeDraw); setTimeout(safeDraw, 120) }
watch([result, pickedBlock, lit, rows], redraw)
watch(tab, (t) => { if (t === 'inside') redraw() })
// the WebView may hand the canvas its size late: a few spaced attempts after it appears, no observers (they loop)
watch(canvasEl, (c) => { if (c) { redraw(); setTimeout(safeDraw, 400); setTimeout(safeDraw, 1000) } })
onMounted(() => window.addEventListener('resize', safeDraw))
let bodyDown = false
function bodyPick(ev: PointerEvent) {
  const c = canvasEl.value
  if (!c) return
  const y = ev.clientY - c.getBoundingClientRect().top
  const row = rows.value.find((r) => y >= r.y && y < r.y + r.h + 1)
  if (row) pickedBlock.value = row.i
}
function bodyDownFn(ev: PointerEvent) { bodyDown = true; bodyPick(ev) }
function bodyMove(ev: PointerEvent) { if (bodyDown) bodyPick(ev) }
function bodyUp() { bodyDown = false }

// the heads of the picked attention block, and how sharply each one looked somewhere (its largest weight past the first token)
const heads = computed(() => {
  const r = result.value, b = picked.value
  if (!r || !b || !b.kind.startsWith('attention')) return []
  const hs = r.attention[String(b.i)]
  if (!hs) return []
  const raw = hs.map((row) => Math.max(0, ...row.slice(1)))
  const m = Math.max(1e-6, ...raw)
  return raw.map((f, h) => ({ h, focus: f / m }))
})
// the prompt as the model reads it, each token shaded by the picked block (or head)
const heat = computed(() => {
  const r = result.value, b = picked.value
  if (!r || !b || !r.tokens_.length) return []
  let w: number[] | undefined
  if (pickedHead.value !== null) w = r.attention[String(b.i)]?.[pickedHead.value]
  if (!w) w = r.change[b.i]
  if (!w) return []
  const m = Math.max(1e-6, ...(pickedHead.value !== null ? w.slice(1) : w))
  return r.tokens_.map((piece, t) => { const v = Math.min(1, w![t] / m); return { piece, a: v < 0.3 ? 0 : (v - 0.3) / 0.7 } })
})
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
    <p v-if="lastError" class="err" @click="lastError = ''">app error (tap to hide): {{ lastError }}</p>

    <template v-if="current">
      <template v-if="editing || !result">
        <textarea id="state" v-model="stateText" rows="3" placeholder="paste anything"></textarea>
        <input id="question" v-model="question" placeholder="ask one question (no options = yes/no)">
        <div class="opts">
          <textarea v-for="(_, i) in options" :key="i" v-model="options[i]" rows="1" :placeholder="'option ' + (i + 1)" @input="grow" @focus="grow" @keydown.backspace="options[i] === '' && dropOption(i)"></textarea>
          <button v-if="options.length < 6" @click="addOption">+</button>
        </div>
      </template>
      <button v-else class="folded" @click="editing = true">
        <span class="st">{{ stateText }}</span>
        <span class="q">{{ question }}<template v-if="options.filter(o => o.trim()).length"> · {{ options.filter(o => o.trim()).length }} options</template> · tap to edit</span>
      </button>

      <nav class="tabs">
        <button class="tab" :class="{ on: tab === 'answer' }" @click="tab = 'answer'">answer</button>
        <button class="tab" :class="{ on: tab === 'layers' }" @click="tab = 'layers'">layers</button>
        <button class="tab" :class="{ on: tab === 'inside' }" @click="tab = 'inside'">inside</button>
      </nav>

      <p v-if="tab === 'answer'" class="lead">the answer: one probability per option, from one pass through the model in your phone</p>
      <p v-if="tab === 'layers'" class="lead">the same answer read after every block: where it formed</p>
      <p v-if="tab === 'inside'" class="lead">the model itself: its blocks, and what each one did to your words</p>
      <section v-if="tab !== 'inside' && result" class="answer">
        <div v-for="o in shown" :key="o.key" class="row" :class="{ win: o.win }">
          <span class="nm">{{ o.key }}</span><span class="p" :style="{ color: o.color }">{{ o.p.toFixed(2) }}</span>
          <div class="bar"><span :style="{ width: o.p * 100 + '%', background: o.color }"></span></div>
        </div>
        <p class="note">{{ result.tokens }} tokens in, {{ result.wallMs.toFixed(0) }} ms, nothing left the phone<span v-if="lensAt !== null"> · shown as read after block {{ lensAt }}</span></p>
      </section>
      <p v-else-if="tab !== 'inside'" class="note">paste a text, ask one question, give options (none = yes/no), tap decide</p>

      <section v-if="tab === 'layers' && result" class="trace">
        <template v-if="curve">
          <div class="hd"><span>drag over the model</span><span class="at">block {{ curve.at }}<template v-if="curve.block"> · {{ curve.block.head ? 'head' : curve.block.kind === 'attention_swa' ? 'attention' : curve.block.kind }}</template> · {{ curve.p !== null ? curve.p.toFixed(2) : '–' }}<template v-if="curve.ms != null"> · {{ curve.ms.toFixed(0) }} ms</template></span></div>
          <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @pointerleave="up">
            <line v-for="v in [0, 0.5, 1]" :key="v" :x1="PX" :x2="W - PX" :y1="curve.y(v)" :y2="curve.y(v)" stroke="#1d2b42" stroke-width="1" />
            <rect v-for="b in curve.strip" :key="b.i" :x="b.x" :y="H - PB + 20 - b.h" :width="b.w" :height="b.h" rx="1.5" :fill="b.fill" :opacity="b.i === curve.at ? 1 : 0.55" />
            <text :x="PX" :y="H - 4" fill="#5c6b80" font-size="10">in</text>
            <text :x="W - PX" :y="H - 4" fill="#5c6b80" font-size="10" text-anchor="end">out</text>
            <path v-for="gh in curve.ghosts" :key="'g' + gh.key" :d="gh.d" fill="none" :stroke="gh.color" stroke-width="1.2" stroke-dasharray="1.5 3.5" opacity="0.7" />
            <path v-for="s in curve.series" :key="s.key" :d="s.d" fill="none" :stroke="s.color" :stroke-width="s.win ? 2.6 : 1.6" />
            <line :x1="curve.x(curve.at)" :x2="curve.x(curve.at)" :y1="PT" :y2="H - PB" stroke="#e9eef5" stroke-width="1" stroke-dasharray="2 3" />
            <circle v-if="curve.dotY !== null" :cx="curve.x(curve.at)" :cy="curve.dotY" r="4" fill="#e8b45a" />
          </svg>
          <div class="legend-lines">
            <span v-for="s in curve.series" :key="s.key"><svg class="sw" viewBox="0 0 28 8"><line x1="1" x2="27" y1="4" y2="4" :stroke="s.color" :stroke-width="s.win ? 2.6 : 1.6" /></svg>{{ s.key }} {{ s.final.toFixed(2) }}</span>
            <span v-if="curve.ghosts.length"><svg class="sw" viewBox="0 0 28 8"><line x1="1" x2="27" y1="4" y2="4" stroke="#e9eef5" stroke-width="1.2" stroke-dasharray="1.5 3.5" opacity="0.7" /></svg>dotted: previous run</span>
          </div>
          <p class="note">each line: that option's probability read after each block · the strip below is the model, block by block</p>
        </template>
        <p v-else class="note">{{ result.layersError || 'no layer readout' }}</p>
      </section>

      <section v-if="tab === 'inside' && info" class="arch">
        <div class="cap out">
          <span class="arr">↑</span>
          <span v-if="result">out · {{ shown.find(o => o.win)?.key }} {{ shown.find(o => o.win)?.p.toFixed(2) }} · softmax of {{ result.keys.length }} score{{ result.keys.length > 1 ? 's' : '' }}</span>
          <span v-else>out · one score per option, softmax, the answer</span>
        </div>
        <div class="plate">
          <b>{{ info.name }}</b>
          <span>{{ fmtM(info.n_params) }} parameters · {{ info.n_layer }} blocks · {{ fmtMB(info.size_bytes) }} in your phone</span>
          <span class="legend"><i class="c"></i> short convolution <i class="a"></i> attention <i class="h"></i> decision head · white = how much it worked on each word</span>
        </div>
        <div v-if="picked" class="expl">
          <b>block {{ picked.i }} · {{ picked.kind === 'attention_swa' ? 'attention (window)' : picked.kind }} · {{ fmtMB(picked.bytes) }}{{ picked.decision_head ? ' · decision head' : '' }}</b>
          <span>{{ KIND_TEXT[picked.kind] }}<template v-if="picked.decision_head"> One of the {{ info.n_layer_decision }} trailing blocks trained for answering; below is the backbone shared with the chat model.</template></span>
          <div v-if="heads.length" class="heads">
            <button v-for="hd in heads" :key="hd.h" class="head" :class="{ on: pickedHead === hd.h }" :style="{ background: `rgba(233,238,245,${0.08 + 0.92 * hd.focus})`, color: hd.focus > 0.5 ? '#0b1018' : '#8fa0b5' }" @click="pickedHead = pickedHead === hd.h ? null : hd.h" :title="'head ' + hd.h">{{ hd.h }}</button>
            <span class="note">its {{ heads.length }} attention heads · brighter = looked harder at one word · tap one</span>
          </div>
          <p v-if="heat.length" class="heat"><span v-for="(c, t) in heat" :key="t" :style="{ background: `rgba(233,238,245,${c.a * 0.75})`, color: c.a > 0.55 ? '#0b1018' : undefined }">{{ c.piece }}</span></p>
          <span v-if="heat.length" class="note">{{ pickedHead !== null ? 'where head ' + pickedHead + ' looked' : 'the words this block changed most' }} · this is the exact text the model read, template included</span>
        </div>
        <div v-else class="expl placeholder"><span>tap or drag a block below: what it is, and the words it worked on</span></div>
        <div class="body">
          <canvas ref="canvasEl" @pointerdown="bodyDownFn" @pointermove="bodyMove" @pointerup="bodyUp" @pointercancel="bodyUp" @pointerleave="bodyUp"></canvas>
        </div>
        <div class="cap in">
          <span class="arr">↑</span>
          <span v-if="result">in · your text as {{ result.tokens }} tokens, {{ info.n_embd }} numbers each</span>
          <span v-else>in · the text as tokens, {{ info.n_embd }} numbers each</span>
        </div>
        <p v-if="!rows.length" class="err">the model reported no blocks</p>
        <p class="note">drag a finger over the blocks<template v-if="result && result.ms.length"> · <a href="#" @click.prevent="replay">replay</a> the pass, {{ replayNote }}</template></p>
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

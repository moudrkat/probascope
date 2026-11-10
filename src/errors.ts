// Any error the app hits is shown on screen, so a phone without a cable can still tell us what went wrong.
import { ref } from 'vue'
export const lastError = ref('')
export function report(e: unknown, where = '') {
  const msg = e instanceof Error ? `${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(0, 3).join('\n') : ''}` : String(e)
  const text = (where ? where + ': ' : '') + msg
  console.error(text)
  if (lastError.value !== text) setTimeout(() => (lastError.value = text), 0) // never from inside a render: that loops

}

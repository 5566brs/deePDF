// v-tip directive: rich hover explanation shown after a short delay.
let el = null
let timer = null
let current = null

function ensure() {
  if (el) return el
  el = document.createElement('div')
  el.className = 'deepdf-tip'
  el.setAttribute('role', 'tooltip')
  document.body.appendChild(el)
  return el
}

function show(target) {
  const text = target.__tip
  if (!text) return
  const t = ensure()
  t.textContent = text
  t.style.display = 'block'
  const r = target.getBoundingClientRect()
  const tw = Math.min(360, window.innerWidth - 16)
  t.style.maxWidth = tw + 'px'
  const th = t.offsetHeight
  let x = Math.min(Math.max(8, r.left), window.innerWidth - t.offsetWidth - 8)
  let y = r.bottom + 6
  if (y + th > window.innerHeight - 8) y = r.top - th - 6
  t.style.left = x + 'px'
  t.style.top = Math.max(8, y) + 'px'
  current = target
}
function hide() {
  clearTimeout(timer)
  if (el) el.style.display = 'none'
  current = null
}

export const tipDirective = {
  mounted(target, binding) {
    target.__tip = binding.value
    target.__tipEnter = () => { clearTimeout(timer); timer = setTimeout(() => show(target), 350) }
    target.__tipLeave = hide
    target.addEventListener('mouseenter', target.__tipEnter)
    target.addEventListener('mouseleave', target.__tipLeave)
    target.addEventListener('mousedown', target.__tipLeave)
  },
  updated(target, binding) {
    target.__tip = binding.value
    if (current === target && el) el.textContent = binding.value || ''
  },
  unmounted(target) {
    target.removeEventListener('mouseenter', target.__tipEnter)
    target.removeEventListener('mouseleave', target.__tipLeave)
    target.removeEventListener('mousedown', target.__tipLeave)
    if (current === target) hide()
  },
}

import './menu.css';

const CONTROLS = [
  ['WASD', 'Move'], ['Mouse', 'Look'], ['Space', 'Jump · vault'], ['Shift', 'Sprint'], ['C / Ctrl', 'Crouch · slide'],
  ['Q / E', 'Lean'], ['LMB', 'Fire'], ['RMB', 'Aim'], ['R', 'Reload'], ['B', 'Fire mode'], ['1 – 5', 'Weapons'],
  ['Z', 'Item wheel'], ['G', 'Grenade'], ['V', 'Punch'], ['F', 'Interact'], ['T', 'Drop weapon'], ['H', 'Gunsmith'],
  ['Tab', 'Scores'], ['Esc / P', 'Pause'],
];

const DEFAULTS = { sensitivity: 1.0, fov: 104, volume: 0.8, graphics: 'high', sprintMode: 'hold', adsMode: 'hold', leanMode: 'toggle' };
const CHOICES = { graphics: ['low', 'medium', 'high'], sprintMode: ['hold', 'toggle'], adsMode: ['hold', 'toggle'], leanMode: ['hold', 'toggle'] };
const TABS = [
  ['graphics', 'Graphics', () => `${seg('graphics', 'Quality')}${slider('fov', 'Field of view', 80, 120, 1)}`],
  ['gameplay', 'Gameplay', () => `${slider('volume', 'Volume', 0, 1, 0.05)}`],
  ['controls', 'Controls', () => `${slider('sensitivity', 'Sensitivity', 0.2, 3, 0.05)}${seg('sprintMode', 'Sprint')}${seg('adsMode', 'Aim')}${seg('leanMode', 'Lean')}`],
];

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('om.settings') ?? '{}') }; } catch { return { ...DEFAULTS }; }
}
function save(s) {
  try { localStorage.setItem('om.settings', JSON.stringify(s)); } catch { /* private mode: settings just won't persist */ }
}

/** Start / pause sheet: settings in tabs. Calls onDeploy when the player clicks in. */
export class Menu {
  constructor(root, { onDeploy, onSettings, onTitle }) {
    this.root = root;
    this.settings = load();
    for (const k in CHOICES) if (!CHOICES[k].includes(this.settings[k])) this.settings[k] = DEFAULTS[k];
    root.innerHTML = `
      <div class="pause-wrap">
      <section class="sheet card pause" role="dialog" aria-label="Paused">
        <h1>Paused</h1>
        <div class="tabs" role="tablist">${TABS.map(([id, name], i) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${!i}">${name}</button>`).join('')}</div>
        ${TABS.map(([id, , body], i) => `<div class="tab-panel settings" role="tabpanel" data-panel="${id}"${i ? ' hidden' : ''}>${body()}</div>`).join('')}
        <div class="actions">
          <button class="btn go" type="button">Loading…</button>
          ${onTitle ? '<button class="btn ghost to-title" type="button">Main menu</button>' : ''}
          <span class="note"></span>
        </div>
      </section>
      <aside class="keys-panel card" aria-label="Key bindings">
        <span class="label">Keys</span>
        <div class="keys">${CONTROLS.map(([k, v]) => `<div class="key"><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>
      </aside>
      </div>`;
    this.button = root.querySelector('.go');
    this.button.disabled = true;
    this.button.addEventListener('click', () => onDeploy());
    root.querySelector('.to-title')?.addEventListener('click', () => onTitle());
    const changed = () => { save(this.settings); onSettings(this.settings); };
    root.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => {
      root.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
      root.querySelector('.pause-wrap').classList.toggle('keys-open', t.dataset.tab === 'controls'); // the key list slides out beside it
    }));
    root.querySelectorAll('input[type=range]').forEach((input) => {
      const out = root.querySelector(`output[for=${input.id}]`);
      input.value = this.settings[input.id];
      out.textContent = fmt(input.id, input.value);
      input.addEventListener('input', () => {
        this.settings[input.id] = Number(input.value);
        out.textContent = fmt(input.id, input.value);
        changed();
      });
    });
    const opts = root.querySelectorAll('[data-opt]');
    const mark = () => opts.forEach((b) => b.setAttribute('aria-checked', String(this.settings[b.dataset.key] === b.dataset.opt)));
    opts.forEach((b) => b.addEventListener('click', () => { this.settings[b.dataset.key] = b.dataset.opt; mark(); changed(); }));
    mark();
    onSettings(this.settings);
  }

  ready() { this.button.disabled = false; this.button.textContent = 'Deploy →'; }

  /** Browsers block re-locking for ~1 s after Esc; keep the button inert until then. */
  paused(cooldownMs = 0) {
    this.button.textContent = 'Resume →';
    this.notice('');
    if (cooldownMs > 0) {
      this.button.disabled = true;
      setTimeout(() => { this.button.disabled = false; }, cooldownMs);
    }
  }

  notice(text) { this.root.querySelector('.note').textContent = text; }
  show(on) { this.root.hidden = !on; }
}

function slider(id, label, min, max, step) {
  return `<label for="${id}"><span class="label"><span>${label}</span><output for="${id}"></output></span>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" /></label>`;
}

function seg(key, label) {
  return `<div class="seg-field"><span class="label"><span>${label}</span></span>
    <div class="seg" role="radiogroup" aria-label="${label}" style="--n:${CHOICES[key].length}">${CHOICES[key].map((o) => `<button type="button" role="radio" data-key="${key}" data-opt="${o}">${o}</button>`).join('')}</div></div>`;
}

function fmt(id, v) {
  v = Number(v);
  return id === 'fov' ? `${v}°` : id === 'volume' ? `${Math.round(v * 100)}%` : v.toFixed(2);
}

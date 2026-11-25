const CONTROLS = [
  ['WASD', 'Move'], ['Mouse', 'Look'], ['Space', 'Jump · wall-jump'], ['Shift', 'Sprint (toggle)'],
  ['C / Ctrl', 'Crouch · slide'], ['LMB', 'Fire'], ['RMB', 'Aim down sights'], ['R', 'Reload'],
  ['1 – 4', 'Switch weapon'], ['F', 'Gunsmith'], ['B', 'Fire mode'], ['Esc / P', 'Pause · settings'],
];

const DEFAULTS = { sensitivity: 1.0, fov: 104, volume: 0.8 };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('om.settings') ?? '{}') }; } catch { return { ...DEFAULTS }; }
}
function save(s) {
  try { localStorage.setItem('om.settings', JSON.stringify(s)); } catch { /* private mode: settings just won't persist */ }
}

/** Start / pause sheet with controls and settings. Calls onDeploy when the player clicks in. */
export class Menu {
  constructor(root, { onDeploy, onSettings }) {
    this.root = root;
    this.settings = load();
    root.innerHTML = `
      <section class="sheet card" role="dialog" aria-label="Opus Magnum">
        <div class="stamp">BUILD 0.1 · TEST RANGE</div>
        <div class="eyebrow">Pilot movement &amp; gunplay testbed</div>
        <h1>Opus Magnum</h1>
        <p class="lede">A clean range for tuning feel: wallruns, slides, auto-mantles and two guns that kick back. Everything here is meant to be iterated on.</p>
        <div class="grid">${CONTROLS.map(([k, v]) => `<div class="key"><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>
        <div class="settings">
          ${slider('sensitivity', 'Sensitivity', 0.2, 3, 0.05)}
          ${slider('fov', 'Field of view', 80, 120, 1)}
          ${slider('volume', 'Volume', 0, 1, 0.05)}
        </div>
        <div class="actions">
          <button class="btn" type="button">Loading…</button>
          <span class="note">Click to lock the mouse · Esc or P to return here</span>
        </div>
      </section>`;
    this.button = root.querySelector('.btn');
    this.button.disabled = true;
    this.button.addEventListener('click', () => onDeploy());
    root.querySelectorAll('input[type=range]').forEach((input) => {
      const out = root.querySelector(`output[for=${input.id}]`);
      input.value = this.settings[input.id];
      out.textContent = fmt(input.id, input.value);
      input.addEventListener('input', () => {
        this.settings[input.id] = Number(input.value);
        out.textContent = fmt(input.id, input.value);
        save(this.settings);
        onSettings(this.settings);
      });
    });
    onSettings(this.settings);
  }

  ready() { this.button.disabled = false; this.button.textContent = 'Deploy →'; }

  /** Browsers block re-locking for ~1 s after Esc; keep the button inert until then. */
  paused(cooldownMs = 0) {
    this.button.textContent = 'Resume →';
    this.notice('Click to lock the mouse · Esc or P to return here');
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

function fmt(id, v) {
  v = Number(v);
  return id === 'fov' ? `${v}°` : id === 'volume' ? `${Math.round(v * 100)}%` : v.toFixed(2);
}

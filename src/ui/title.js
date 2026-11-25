/**
 * Title screen. Modes: { id, index, title, blurb, tag?, builtin? (name of the mode's own map), lock? }.
 * Modes with a built-in map also offer saved custom maps (from getMaps) on a second panel.
 * Calls onPick(modeId, mapId | null) from the click gesture.
 */
export class Title {
  constructor(root, { modes, getMaps = () => [], onPick }) {
    Object.assign(this, { root, modes, getMaps, onPick });
    root.className = 'menu title';
    this.#home();
  }

  #home() {
    this.root.innerHTML = `
      <section class="sheet card title-sheet" role="dialog" aria-label="Opus Magnum">
        <h1>Opus Magnum</h1>
        <div class="mode-pick">
          ${this.modes.map((m) => `
            <button class="mode card" type="button" data-id="${m.id}">
              <span class="label">${m.index}</span>
              <b>${m.title}</b>
              <span class="mode-blurb">${m.short ?? ''}</span>
              <span class="mode-go">→</span>
            </button>`).join('')}
        </div>
      </section>`;
    this.root.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
      const m = this.modes.find((x) => x.id === b.dataset.id);
      if (m.builtin && this.getMaps().length) this.#maps(m);
      else this.onPick(m.id, null);
    }));
  }

  #maps(mode) {
    const maps = this.getMaps();
    const card = (id, kind, name) => `<button class="map card" type="button" data-id="${id}"><span class="label">${kind}</span><b>${esc(name)}</b></button>`;
    this.root.innerHTML = `
      <section class="sheet card title-sheet" role="dialog" aria-label="Choose a map">
        <h1>${mode.title}</h1>
        <div class="map-pick">
          ${card('', 'Original', mode.builtin)}
          ${maps.map((m) => card(m.id, m.builtin ? 'Featured' : 'Custom', m.name)).join('')}
        </div>
        <div class="actions"><button class="btn ghost back" type="button">← Back</button></div>
      </section>`;
    this.root.querySelectorAll('.map').forEach((b) => b.addEventListener('click', () => this.onPick(mode.id, b.dataset.id || null)));
    this.root.querySelector('.back').addEventListener('click', () => this.#home());
  }

  show(on) { this.root.hidden = !on; }
  notice(text) { const n = this.root.querySelector('.note'); if (n) n.textContent = text; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

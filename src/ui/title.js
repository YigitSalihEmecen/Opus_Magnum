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
      <section class="sheet title-sheet home" role="dialog" aria-label="Opus Magnum">
        <h1>Opus Magnum<span class="label">Scrapyard build · 0.3</span></h1>
        <div class="mode-pick">
          ${this.modes.map((m) => `
            <button class="mode card" type="button" data-id="${m.id}" style="--accent:${m.accent ?? 'var(--clay)'}">
              <span class="mode-top"><span class="label">${m.index}</span><i class="mode-chip"></i></span>
              <b>${m.title}</b>
              <span class="mode-blurb">${m.short ?? ''}</span>
              <span class="mode-go">→</span>
            </button>`).join('')}
        </div>
      </section>`;
    this.root.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
      const m = this.modes.find((x) => x.id === b.dataset.id);
      if (m.lobby) this.#lobby(m);
      else if (m.builtin && this.getMaps().length) this.#maps(m);
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

  /** Multiplayer: name, room code, map (used when you open the room), server. Remembered between visits. */
  #lobby(mode) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('om.lobby') ?? '{}'); } catch { /* private mode */ }
    const v = { name: '', room: 'duel', map: mode.lobby.map, server: mode.lobby.server, ...saved };
    const maps = this.getMaps();
    this.root.innerHTML = `
      <section class="sheet card title-sheet" role="dialog" aria-label="Multiplayer">
        <h1>${mode.title}</h1>
        <form class="settings lobby">
          <label><span class="label">Your name</span><input name="name" maxlength="16" value="${esc(v.name)}" placeholder="Player"></label>
          <label><span class="label">Room code</span><input name="room" maxlength="16" required value="${esc(v.room)}"></label>
          <label><span class="label">Map · if you open the room</span><select name="map">${maps.map((m) => `<option value="${m.id}"${m.id === v.map ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
          <label><span class="label">Server</span><input name="server" required value="${esc(v.server)}"></label>
          <div class="actions"><button class="btn" type="submit">Join room →</button><button class="btn ghost back" type="button">← Back</button></div>
          <p class="note">Share the room code with your friends. The first one in picks the map.</p>
        </form>
      </section>`;
    const form = this.root.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      try { localStorage.setItem('om.lobby', JSON.stringify(f)); } catch { /* private mode */ }
      this.notice('Connecting…');
      this.onPick(mode.id, f.map, { name: f.name.trim(), room: f.room.trim(), server: f.server.trim() });
    });
    this.root.querySelector('.back').addEventListener('click', () => this.#home());
  }

  show(on) { this.root.hidden = !on; }
  notice(text) { const n = this.root.querySelector('.note'); if (n) n.textContent = text; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

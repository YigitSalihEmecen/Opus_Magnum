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

  /** Swap the panel: the old one slides out, then the new one in (its cards one after another). */
  #show(html, bind) {
    const old = this.root.firstElementChild;
    const swap = () => {
      if (this.root.firstElementChild !== old) return; // another swap got there first
      this.root.innerHTML = html;
      this.root.querySelectorAll('.mode, .map').forEach((c, i) => c.style.setProperty('--i', i));
      // while the cards rise in they poke past their scroll box: no scrollbar until they've settled
      const sheet = this.root.firstElementChild;
      sheet.classList.add('intro');
      setTimeout(() => sheet.classList.remove('intro'), 60 * this.root.querySelectorAll('.mode, .map').length + 500);
      bind();
    };
    if (!old) return swap();
    old.classList.add('out');
    setTimeout(swap, 150);
  }

  #cards(list) {
    return list.map((m) => `
      <button class="mode card" type="button" data-id="${m.id}" style="--accent:${m.accent ?? 'var(--clay)'}">
        <span class="mode-top"><span class="label">${m.index}</span><i class="mode-chip"></i></span>
        <b>${m.title}</b>
        <span class="mode-blurb">${m.short ?? ''}</span>
        <span class="mode-go">→</span>
      </button>`).join('');
  }

  #home() {
    const groups = [
      { id: 'single', index: '01', title: 'Singleplayer', short: 'Range · bots · map editor', accent: '#d97757' },
      { id: 'multi', index: '02', title: 'Multiplayer', short: '2v2 · bots fill empty slots', accent: '#6b6a4f' },
    ];
    this.#show(`
      <section class="sheet title-sheet home" role="dialog" aria-label="Opus Magnum">
        <h1>Opus Magnum<span class="label">Scrapyard build · 0.3</span></h1>
        <div class="mode-pick main-pick">${this.#cards(groups)}</div>
      </section>`, () => {
      this.root.querySelector('[data-id=single]').addEventListener('click', () => this.#single());
      this.root.querySelector('[data-id=multi]').addEventListener('click', () => this.#lobby(this.modes.find((m) => m.lobby)));
    });
  }

  #single() {
    this.#show(`
      <section class="sheet title-sheet home" role="dialog" aria-label="Singleplayer">
        <h1>Singleplayer<span class="label">Opus Magnum</span></h1>
        <div class="mode-pick">${this.#cards(this.modes.filter((m) => !m.lobby))}</div>
        <div class="actions"><button class="btn ghost back" type="button">← Back</button><span class="note"></span></div>
      </section>`, () => {
      this.root.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
        const m = this.modes.find((x) => x.id === b.dataset.id);
        if (m.builtin && this.getMaps().length) this.#maps(m);
        else this.onPick(m.id, null);
      }));
      this.root.querySelector('.back').addEventListener('click', () => this.#home());
    });
  }

  #maps(mode) {
    const maps = this.getMaps();
    const card = (id, kind, name, img) => `<button class="map card${img ? ' shot' : ''}" type="button" data-id="${id}">
      ${img ? `<span class="map-img" style="background-image:url('${img}')"></span>` : ''}<span class="label">${kind}</span><b>${esc(name)}</b></button>`;
    this.#show(`
      <section class="sheet card title-sheet" role="dialog" aria-label="Choose a map">
        <h1>${mode.title}</h1>
        <div class="map-pick">
          ${card('', 'Original', mode.builtin, mode.preview)}
          ${maps.map((m) => card(m.id, m.builtin ? 'Featured' : 'Custom', m.name, m.preview)).join('')}
        </div>
        <div class="actions"><button class="btn ghost back" type="button">← Back</button></div>
      </section>`, () => {
      this.root.querySelectorAll('.map').forEach((b) => b.addEventListener('click', () => this.onPick(mode.id, b.dataset.id || null)));
      this.root.querySelector('.back').addEventListener('click', () => this.#single());
    });
  }

  /** Multiplayer: name, room code, map (used when you open the room), server. Remembered between visits. */
  #lobby(mode) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('om.lobby') ?? '{}'); } catch { /* private mode */ }
    const v = { name: '', room: 'duel', map: mode.lobby.map, server: mode.lobby.server, ...saved };
    const maps = this.getMaps();
    this.#show(`
      <section class="sheet card title-sheet" role="dialog" aria-label="Multiplayer">
        <h1>Multiplayer</h1>
        <form class="settings lobby">
          <label><span class="label">Your name</span><input name="name" maxlength="16" value="${esc(v.name)}" placeholder="Player"></label>
          <label><span class="label">Room code</span><input name="room" maxlength="16" required value="${esc(v.room)}"></label>
          <div class="lobby-maps"><span class="label">Map · if you open the room</span><input type="hidden" name="map" value="${esc(maps.some((m) => m.id === v.map) ? v.map : maps[0]?.id ?? '')}">
            <div class="lobby-map-row">${maps.map((m) => `<button type="button" class="map card${m.preview ? ' shot' : ''}" data-map="${m.id}">${m.preview ? `<span class="map-img" style="background-image:url('${m.preview}')"></span>` : ''}<b>${esc(m.name)}</b></button>`).join('')}</div></div>
          <label><span class="label">Server</span><input name="server" required value="${esc(v.server)}"></label>
          <div class="actions"><button class="btn" type="submit">Join room →</button><button class="btn ghost back" type="button">← Back</button></div>
          <p class="note"></p>
        </form>
      </section>`, () => this.#bindLobby(mode));
  }

  #bindLobby(mode) {
    const form = this.root.querySelector('form');
    const pick = form.elements.map;
    const mark = () => form.querySelectorAll('[data-map]').forEach((b) => b.classList.toggle('on', b.dataset.map === pick.value));
    form.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => { pick.value = b.dataset.map; mark(); }));
    mark();
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

import './matchHud.css';
import { weaponIcon } from './weaponIcons.js';

/*
  Team match overlay shared by Team Deathmatch and online play: the score bar with clock and limit, the
  kill feed, the hurt vignette and hit-direction arrows, the "eliminated by" card and the end screen.
  (Its CSS classes keep their tdm- prefix.)
*/

const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class MatchHud {
  constructor({ ally = 'Allies', enemy = 'Enemy', limit }) {
    const root = (this.root = document.createElement('div'));
    root.className = 'tdm';
    root.innerHTML = `
      <div class="tdm-score card">
        <div class="side ally"><span class="label">${esc(ally)}</span><b class="a">0</b></div>
        <div class="mid"><span class="clock">10:00</span><span class="label">First to ${limit}</span></div>
        <div class="side enemy"><b class="e">0</b><span class="label">${esc(enemy)}</span></div>
      </div>
      <div class="tdm-feed"></div>
      <div class="tdm-vignette"></div>
      <div class="tdm-dirs"></div>
      <div class="tdm-toast"></div>
      <div class="tdm-death card" hidden><span class="label">Eliminated by</span><b class="who"></b><span class="label cd"></span></div>
      <div class="tdm-end" hidden>
        <section class="card">
          <div class="label end-map">Match over</div>
          <h2 class="verdict"></h2>
          <div class="final"></div>
          <div class="actions"><button class="btn again" type="button">Play again →</button><button class="btn ghost title" type="button">Main menu</button></div>
        </section>
      </div>`;
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.el = {
      a: $('.a'), e: $('.e'), clock: $('.clock'), feed: $('.tdm-feed'),
      vig: $('.tdm-vignette'), dirs: $('.tdm-dirs'), toast: $('.tdm-toast'), death: $('.tdm-death'), who: $('.tdm-death .who'), cd: $('.tdm-death .cd'), end: $('.tdm-end'),
    };
    $('.again').addEventListener('click', () => location.reload());
    $('.title').addEventListener('click', () => { location.href = location.pathname; });
    this.hp = 1;
    this.vig = 0;
  }

  score(s, time) {
    this.el.a.textContent = s.ally;
    this.el.e.textContent = s.enemy;
    this.el.clock.textContent = fmtTime(time);
  }

  /** weapon: arsenal id, 'knife', 'grenade' or 'fall'; its silhouette sits between the names. */
  feed(killer, victim, head, weapon) {
    const row = document.createElement('div');
    row.className = 'card';
    const icon = weapon && weapon !== 'fall' ? weaponIcon(weapon) : null;
    const how = icon ? `<img src="${icon}" alt="">` : weapon === 'fall' ? '<i>fell</i>' : '▸';
    const self = killer.name === victim.name;
    row.innerHTML = `${self ? '' : `<span class="${killer.team}">${esc(killer.name)}</span>`}<em>${how}${head ? '<b>◆</b>' : ''}</em><span class="${victim.team}">${esc(victim.name)}</span>`;
    this.el.feed.prepend(row);
    setTimeout(() => row.classList.add('out'), 5000);
    setTimeout(() => row.remove(), 5600);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
  }

  toast(text, head) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.toggle('head', !!head);
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
  }

  hurt(frac, bearing) {
    this.hp = Math.max(0, frac);
    if (bearing !== null && bearing !== undefined) {
      this.vig = Math.min(1, this.vig + 0.45);
      const d = document.createElement('i');
      d.style.transform = `rotate(${bearing}rad)`;
      this.el.dirs.appendChild(d);
      setTimeout(() => d.remove(), 1100);
    }
  }

  /** t: seconds to the respawn, or a line of text (online: you sit out until the round ends). */
  death(name, t) {
    this.el.death.hidden = !name;
    if (name) {
      this.el.who.textContent = name;
      this.el.cd.textContent = typeof t === 'string' ? t : t > 0 ? `Redeploy in ${Math.ceil(t)}` : 'Redeploying';
    }
  }

  end(result, s, map) {
    this.el.end.hidden = false;
    this.el.end.querySelector('.end-map').textContent = `Match over · ${map}`;
    this.el.end.dataset.r = result;
    this.el.end.querySelector('.verdict').textContent = result === 'win' ? 'Victory' : result === 'loss' ? 'Defeat' : 'Draw';
    this.el.end.querySelector('.final').innerHTML = `<span class="ally">${s.ally}</span><span class="dash">—</span><span class="enemy">${s.enemy}</span>`;
  }

  update(dt, s, time) {
    this.el.clock.textContent = fmtTime(time);
    this.vig = Math.max(0, this.vig - dt * 1.6);
    this.el.vig.style.opacity = Math.max(this.vig, (1 - this.hp) * 0.55).toFixed(3);
  }
}

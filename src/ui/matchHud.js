import * as THREE from 'three';
import './matchHud.css';
import { weaponIcon } from './weaponIcons.js';

/*
  Team match overlay shared by Team Deathmatch and online play: the score bar with clock and limit, the
  kill feed, the hurt vignette and hit-direction arcs, the low-health pulse, the "eliminated by" card (with the
  damage traded with your killer) and the end screen.
  (Its CSS classes keep their tdm- prefix.)
*/

// hit-direction marker: a curved band hugging a ring round the crosshair, 50° wide, drawn pointing up
const ARC = (() => {
  const a = 25 * Math.PI / 180, ro = 150, ri = 128, p = (r, s) => `${(r * Math.sin(s * a)).toFixed(1)} ${(-r * Math.cos(s * a)).toFixed(1)}`;
  return `<svg viewBox="-160 -160 320 320"><path d="M${p(ro, -1)}A${ro} ${ro} 0 0 1 ${p(ro, 1)}L${p(ri, 0.55)}L0 ${-ri + 9}L${p(ri, -0.55)}Z"/></svg>`;
})();
const DIR_LIFE = 1.8;

const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class MatchHud {
  constructor({ ally = 'Allies', enemy = 'Enemy', limit }) {
    weaponIcon(); // start drawing the kill feed's icons now, so they're ready by the first kill
    const root = (this.root = document.createElement('div'));
    root.className = 'tdm';
    root.innerHTML = `
      <div class="tdm-score card">
        <div class="side ally"><span class="label">${esc(ally)}</span><b class="a">0</b></div>
        <div class="mid"><span class="clock">10:00</span><span class="label">First to ${limit}</span></div>
        <div class="side enemy"><b class="e">0</b><span class="label">${esc(enemy)}</span></div>
      </div>
      <div class="tdm-feed"></div>
      <div class="tdm-toast"></div>
      <div class="tdm-death card" hidden><span class="label">Eliminated by</span><b class="who"></b><div class="dsum"></div><span class="label cd"></span></div>
      <div class="tdm-end" hidden>
        <section class="card">
          <div class="label end-map">Match over</div>
          <h2 class="verdict"></h2>
          <div class="final"></div>
          <div class="actions"><button class="btn again" type="button">Play again →</button><button class="btn ghost title" type="button">Main menu</button></div>
        </section>
      </div>`;
    document.body.appendChild(root);
    // the screen effects go under the HUD so its panels stay clean
    const fx = (this.fx = document.createElement('div'));
    fx.className = 'tdm tdm-fx';
    fx.innerHTML = '<div class="tdm-vignette"></div><div class="tdm-low"></div><div class="tdm-dirs"></div>';
    document.body.insertBefore(fx, document.getElementById('hud'));
    const $ = (s) => root.querySelector(s) ?? fx.querySelector(s);
    this.el = {
      a: $('.a'), e: $('.e'), clock: $('.clock'), feed: $('.tdm-feed'),
      vig: $('.tdm-vignette'), low: $('.tdm-low'), dirs: $('.tdm-dirs'), dsum: $('.dsum'), toast: $('.tdm-toast'), death: $('.tdm-death'), who: $('.tdm-death .who'), cd: $('.tdm-death .cd'), end: $('.tdm-end'),
    };
    $('.again').addEventListener('click', () => location.reload());
    $('.title').addEventListener('click', () => { location.href = location.pathname; });
    this.hp = 1;
    this.vig = 0;
    this.beat = 0;
    this.marks = new Map(); // attacker → { el, from, t, k }
  }

  score(s, time) {
    this.el.a.textContent = s.ally;
    this.el.e.textContent = s.enemy;
    this.el.clock.textContent = fmtTime(time);
  }

  /** weapon: arsenal id, 'fist', 'grenade' or 'fall'; its silhouette sits between the names. */
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

  /**
   * Health changed (frac of max). On a hit, `from` is who shot (anything with a pos) and dmg what it took off:
   * the edges flash, and an arc points back where it came from (it keeps pointing there as you turn).
   */
  hurt(frac, from = null, dmg = 0) {
    this.hp = Math.max(0, frac);
    if (!from) return;
    const k = Math.min(1, dmg / 35);
    this.vig = Math.min(1, this.vig + 0.25 + 0.55 * k);
    let m = this.marks.get(from);
    if (!m) {
      const el = document.createElement('i');
      el.innerHTML = ARC;
      this.el.dirs.appendChild(el);
      m = { el, from: new THREE.Vector3() };
      this.marks.set(from, m);
    }
    m.from.copy(from.pos);
    m.t = 0;
    m.k = Math.max(m.k ?? 0, 0.45 + 0.55 * k);
    m.el.classList.remove('hit');
    void m.el.offsetWidth;
    m.el.classList.add('hit');
  }

  /**
   * name: who killed you (null clears the card). t: seconds to the respawn, or a line of text (online: you sit
   * out until the round ends). sum, given once at the death: { dealt, taken, hits, left? } traded with them.
   */
  death(name, t, sum) {
    this.el.death.hidden = !name;
    if (!name) return;
    this.el.who.textContent = name;
    this.el.cd.textContent = typeof t === 'string' ? t : t > 0 ? `Redeploy in ${Math.ceil(t)}` : 'Redeploying';
    if (sum !== undefined) {
      this.el.dsum.hidden = !sum;
      if (sum) {
        this.el.dsum.innerHTML = `<span><em>${Math.round(sum.dealt)}</em>damage dealt</span><span><em>${Math.round(sum.taken)}</em>taken · ${sum.hits} hit${sum.hits === 1 ? '' : 's'}</span>`
          + (sum.left !== undefined ? `<span><em>${Math.max(0, Math.round(sum.left))}</em>they had left</span>` : '');
      }
    }
  }

  end(result, s, map) {
    this.el.end.hidden = false;
    this.el.end.querySelector('.end-map').textContent = `Match over · ${map}`;
    this.el.end.dataset.r = result;
    this.el.end.querySelector('.verdict').textContent = result === 'win' ? 'Victory' : result === 'loss' ? 'Defeat' : 'Draw';
    this.el.end.querySelector('.final').innerHTML = `<span class="ally">${s.ally}</span><span class="dash">—</span><span class="enemy">${s.enemy}</span>`;
  }

  /** bearing(p): screen bearing (radians, clockwise from ahead) from the camera to world point p. */
  update(dt, s, time, bearing) {
    this.fx.hidden = this.root.hidden;
    this.el.clock.textContent = fmtTime(time);
    this.vig = Math.max(0, this.vig - dt * 1.8);
    this.el.vig.style.opacity = Math.max(this.vig, (1 - this.hp) * 0.3).toFixed(3);
    // under ~45% the edges go deep red and pulse like a heartbeat, quicker the lower it gets
    const low = this.hp > 0 ? THREE.MathUtils.clamp((0.45 - this.hp) / 0.35, 0, 1) : 0;
    this.beat = (this.beat + dt * (1.1 + low * 0.9)) % 1;
    this.el.low.style.opacity = (low * (0.5 + 0.5 * Math.exp(-this.beat * 7))).toFixed(3);
    for (const [who, m] of this.marks) {
      m.t += dt;
      if (m.t > DIR_LIFE) { m.el.remove(); this.marks.delete(who); continue; }
      const fade = Math.min(1, (DIR_LIFE - m.t) / 0.7);
      m.el.style.opacity = (m.k * fade).toFixed(3);
      if (bearing) m.el.style.transform = `rotate(${bearing(m.from)}rad)`;
    }
  }
}

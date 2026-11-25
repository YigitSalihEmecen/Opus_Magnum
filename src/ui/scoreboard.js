/**
 * Hold-Tab scoreboard. A mode provides scoreRows() →
 *   { title, teams: [{ label, team: 'ally' | 'enemy', score, rows: [{ name, kills, deaths, you?, dead? }] }] }
 * Rebuilt at most a few times a second while it's open.
 */
export class Scoreboard {
  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'scoreboard';
    this.root.hidden = true;
    document.body.appendChild(this.root);
    this.t = 0;
  }

  update(dt, data) {
    if (!data) { this.root.hidden = true; this.key = null; return; }
    this.root.hidden = false;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.25;
    const html = `
      <section class="card">
        <div class="sb-head"><span class="label">${esc(data.title ?? 'Scoreboard')}</span><span class="label">Hold Tab</span></div>
        ${data.teams.map((t) => `
          <div class="sb-team ${t.team}">
            <div class="sb-team-head"><b>${esc(t.label)}</b><span class="sb-score">${t.score}</span></div>
            <div class="sb-row sb-cols"><span>Name</span><span>K</span><span>D</span></div>
            ${[...t.rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map((r) => `
              <div class="sb-row${r.you ? ' you' : ''}${r.dead ? ' dead' : ''}"><span>${esc(r.name)}</span><span>${r.kills}</span><span>${r.deaths}</span></div>`).join('')}
          </div>`).join('')}
      </section>`;
    if (html !== this.key) { this.root.innerHTML = html; this.key = html; }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

import './loader.css';

/*
  Loading screen: an opaque paper sheet over everything while a mode or map loads, so the half-built world is
  never seen. Four blocks drop into a 2 × 2 stack, one after another, over the map's name and a striped bar.
  Every animation is transform/opacity only, so the compositor keeps it smooth while the map build blocks the page.

    open()   the sheet is up and painted; resolves after its intro, so the blocking build starts behind it
    close()  the world is ready: it renders under the sheet for a few frames (shaders, shadows), then the
             sheet slides away
    fail()   drop it at once (the load threw)
*/

const INTRO = 450, SETTLE = 280, OUT = 520;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class Loader {
  constructor() {
    this.active = false;
    const root = (this.dom = document.createElement('div'));
    root.className = 'ld';
    root.hidden = true;
    root.innerHTML = `
      <div class="ld-brand label">SUPERKILL</div>
      <div class="ld-main">
        <div class="ld-blocks" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="label ld-index"></div>
        <h2 class="ld-name"></h2>
        <div class="ld-bar"><i class="ld-run"></i><i class="ld-fill"></i></div>
        <div class="label ld-step"></div>
      </div>`;
    document.body.appendChild(root);
    this.$ = (q) => root.querySelector(q);
  }

  /** Put the sheet up. Resolves once it has been painted and its intro has played. */
  open({ index = '', name = '' } = {}) {
    this.active = true;
    const d = this.dom;
    this.$('.ld-index').textContent = index;
    this.$('.ld-name').textContent = name;
    this.$('.ld-step').textContent = 'Loading';
    d.className = 'ld';
    d.hidden = false;
    return wait(INTRO);
  }

  /** The level is ready: fill the bar, let the world render underneath, slide the sheet away. */
  async close() {
    if (!this.active) return;
    this.$('.ld-step').textContent = 'Ready';
    this.dom.classList.add('done');
    this.active = false; // the main loop draws the world again, still under the sheet
    await wait(SETTLE);
    this.dom.classList.add('out');
    await wait(OUT);
    this.dom.hidden = true;
  }

  fail() {
    this.active = false;
    this.dom.hidden = true;
  }
}

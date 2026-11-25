/** Keyboard/mouse state with per-frame edge detection. Call endFrame() once per frame. */
export class Input {
  constructor(element) {
    this.element = element;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.buttons = new Set();
    this.pressedButtons = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.pointerLocked = false;
    this.devMode = false;
    this.skipMoves = 0;

    addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.pressedKeys.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons.add(e.button);
      this.pressedButtons.add(e.button);
    });
    addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    addEventListener('mousemove', (e) => {
      // look only while the cursor is truly captured; a free cursor must never steer the camera
      if (!this.pointerLocked) return;
      // browsers emit a bogus jump on the first event after locking, and occasional spikes on macOS
      if (this.skipMoves > 0) { this.skipMoves--; return; }
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === element;
      this.locked = this.pointerLocked || this.devMode;
      this.skipMoves = 2;
      if (!this.pointerLocked) { this.keys.clear(); this.buttons.clear(); this.unlockedAt = performance.now(); }
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.legacyAttempt) { this.legacyAttempt = false; this.onLockError?.(); }
    });
  }

  /**
   * Must be called synchronously inside a click handler (user gesture), before any await.
   * Prefers raw input, falls back to a plain lock where unadjustedMovement isn't supported (macOS, Safari).
   */
  lock() {
    const el = this.element;
    const fail = (err) => this.onLockError?.(err);
    const plain = () => {
      try {
        const p = el.requestPointerLock();
        if (p?.catch) p.catch(fail);
        else this.legacyAttempt = true; // older Safari: no promise, failures arrive as 'pointerlockerror'
      } catch (err) { fail(err); }
    };
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p?.catch) p.catch(plain);
      else this.legacyAttempt = true;
    } catch { plain(); }
  }

  /** Chrome refuses to re-lock for ~1 s after the user pressed Esc. */
  get relockCooldown() { return Math.max(0, 1100 - (performance.now() - (this.unlockedAt ?? -1e9))); }

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.pressedKeys.has(code); }
  mouse(btn) { return this.buttons.has(btn); }
  clicked(btn) { return this.pressedButtons.has(btn); }

  /** Movement axes in [-1, 1]: x = strafe right, y = forward. */
  axes() {
    return {
      x: (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0),
      y: (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0),
    };
  }

  endFrame() {
    this.pressedKeys.clear();
    this.pressedButtons.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
  }
}

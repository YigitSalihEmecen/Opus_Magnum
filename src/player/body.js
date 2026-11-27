import * as THREE from 'three';
import { Avatar } from '../character/avatar.js';

/*
  Your own body in first person: the robot the others see, driven by the movement controller, showing only the
  legs (the viewmodel's arms and gun are what you see above them; the pelvis and spine plating would sit right
  under the lens). Look down and your legs run, crouch, slide, jump, climb and vault under you, with the same
  animation as every other body. It casts no shadow: a shadow of just the legs would look wrong.
*/

const BACK = 0.06; // m behind the eye: the eyes sit about over the toes

export class PlayerBody {
  constructor(scene) {
    this.scene = scene;
    this.char = null;
  }

  /** (Re)build for a character id. */
  setCharacter(id) {
    if (this.char === id) return;
    this.char = id;
    if (this.avatar) this.scene.remove(this.avatar.root);
    const a = (this.avatar = new Avatar({ team: 'player', name: '', char: id }));
    const B = a.motion.bones;
    B.chest.visible = false; // shoulders, arms, neck, head and the third-person gun all hang off it
    for (const b of [B.hips, B.spine]) for (const c of b.children) if (c.isMesh) c.visible = false; // the plating, not the legs
    a.root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    this.scene.add(a.root);
  }

  /** mv: the movement controller; yaw: the view's; show: a level is being played (not the editor). */
  update(dt, { mv, yaw, alive, show }) {
    const a = this.avatar;
    if (!a) return;
    const on = show && alive;
    a.alive = on;
    a.root.visible = on;
    if (!on) { a.live = false; return; }
    a.aimYaw = yaw + Math.PI;
    a.pos.copy(mv.feet).add(_back.set(-Math.sin(a.aimYaw) * BACK, 0, -Math.cos(a.aimYaw) * BACK));
    a.vel.copy(mv.vel);
    a.aimPitch = 0;
    const st = mv.state, p = (a.poseTarget ??= {});
    p.slide = st === 'slide' ? 1 : 0;
    p.crouch = mv.crouched && !p.slide ? 1 : 0;
    p.air = st === 'air' ? 1 : 0;
    p.mantle = st === 'mantle' ? 1 : 0;
    p.vault = st === 'vault' ? 1 : 0;
    a.pose(dt);
  }
}

const _back = new THREE.Vector3();

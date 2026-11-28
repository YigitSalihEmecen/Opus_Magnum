/*
  Repeatable benchmark (dev only): OM.bench({ frames }) flies the camera on a fixed circle round the spawn, steps the
  sim at a fixed 1/60 s and times every frame two ways: cpu (the tick on its own) and wall (the tick plus the GPU
  finishing it, synced with a 1-pixel read). Dynamic resolution is held at full scale so presets compare fairly.
*/
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const yieldTask = () => new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = res; c.port2.postMessage(0); });

export async function bench(OM, { frames = 240, warm = 30, radius = 8, scale = 1, size = [1920, 1080] } = {}) {
  const r = OM.renderer, gl = r.gl, ctx = gl.getContext(), px = new Uint8Array(4);
  const sync = () => ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  const spawn = OM.level?.spawn?.position ?? { x: 0, y: 0, z: 0 };
  const timer = r.timer, wasFrozen = OM.frozen, scale0 = r.scale, css = [r.cssW, r.cssH], ratio = gl.getPixelRatio();
  r.timer = null;
  r.scale = scale;
  gl.setPixelRatio(1);
  r.resize(...size);
  OM.frozen = true;
  gl.info.autoReset = false;
  const cpu = [], wall = [], calls = [], tris = [];
  const heap0 = performance.memory?.usedJSHeapSize;
  for (let i = 0; i < warm + frames; i++) {
    const a = (i / frames) * Math.PI * 2;
    OM.view = { pos: [spawn.x + Math.cos(a) * radius, spawn.y + 1.7, spawn.z + Math.sin(a) * radius], yaw: (-a * 180) / Math.PI, pitch: -4 };
    gl.info.reset();
    sync();
    const t0 = performance.now();
    OM.step(1);
    const t1 = performance.now();
    sync();
    const t2 = performance.now();
    if (i >= warm) { cpu.push(t1 - t0); wall.push(t2 - t0); calls.push(gl.info.render.calls); tris.push(gl.info.render.triangles); }
    await yieldTask();
  }
  const benchSize = [r.world.width, r.world.height];
  gl.info.autoReset = true;
  OM.view = null;
  OM.frozen = wasFrozen;
  r.timer = timer;
  r.scale = scale0;
  gl.setPixelRatio(ratio);
  r.resize(...css);
  const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { p50: +pct(s, 0.5).toFixed(2), p95: +pct(s, 0.95).toFixed(2), p99: +pct(s, 0.99).toFixed(2) }; };
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  return {
    size: benchSize, cpu: stats(cpu), wall: stats(wall),
    calls: avg(calls), tris: avg(tris), programs: gl.info.programs.length,
    gpuMem: { ...gl.info.memory }, heapDeltaKB: heap0 ? Math.round((performance.memory.usedJSHeapSize - heap0) / 1024) : null,
  };
}

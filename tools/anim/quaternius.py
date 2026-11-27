"""
Quaternius Universal Animation Library (CC0) → the compact motion data the game plays.

    python3 tools/anim/quaternius.py <UAL1 .glb> <UAL2 .glb> src/character/motion.data.js

Downloads (Standard, glTF/Godot versions):
  https://opengameart.org/content/universal-animation-library
  https://opengameart.org/content/universal-animation-library-2

Keeps only what the bodies use: the clips listed in CLIPS, the bones in BONES (no fingers, toes, arms — the
hands are on the gun), sampled at FPS, as each bone's rotation in character space (so the game can map it onto
any rig with the same rest layout) plus the hips' height and sway. Rotations are stored as each bone's turn
away from its rest pose in character space, so the game needs nothing about the source rig: the target bone's
rest turned the same way is its pose. Quaternions and positions are stored as int16.
Root-motion clips (_RM) lose their travel: the game's own movement carries the body.
Also measures each loop's ground speed from its feet, so playback can match the character's real speed.
"""
import base64, json, struct, sys
import numpy as np

FPS = 30
# our bone ← (UAL1 bone, UAL2 bone)
BONES = {
    'hips': ('DEF-hips', 'pelvis'), 'spine': ('DEF-spine.001', 'spine_01'), 'chest': ('DEF-spine.003', 'spine_03'),
    'neck': ('DEF-neck', 'neck_01'), 'head': ('DEF-head', 'Head'),
    'shoulder_L': ('DEF-shoulder.L', 'clavicle_l'), 'shoulder_R': ('DEF-shoulder.R', 'clavicle_r'),
    'thigh_L': ('DEF-thigh.L', 'thigh_l'), 'shin_L': ('DEF-shin.L', 'calf_l'), 'foot_L': ('DEF-foot.L', 'foot_l'),
    'thigh_R': ('DEF-thigh.R', 'thigh_r'), 'shin_R': ('DEF-shin.R', 'calf_r'), 'foot_R': ('DEF-foot.R', 'foot_r'),
}
# our clip ← (library 1 or 2, source clip, loops)
CLIPS = {
    'idle': (1, 'Idle_Loop', True), 'walk': (1, 'Walk_Loop', True), 'jog': (1, 'Jog_Fwd_Loop', True), 'sprint': (1, 'Sprint_Loop', True),
    'crouchIdle': (1, 'Crouch_Idle_Loop', True), 'crouchWalk': (1, 'Crouch_Fwd_Loop', True),
    'air': (1, 'Jump_Loop', True), 'land': (1, 'Jump_Land', False), 'hit': (1, 'Hit_Chest', False),
    'slide': (2, 'Slide_Loop', True), 'climb': (2, 'ClimbUp_1m_RM', False),
    # the tucked jump: the vault is built from these in avatar.js (the libraries have no vault)
    'tuckStart': (2, 'NinjaJump_Start', False), 'tuck': (2, 'NinjaJump_Idle_Loop', True), 'tuckLand': (2, 'NinjaJump_Land', False),
}

def load(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    m = struct.unpack('<I', b[20 + n:24 + n])[0]
    return j, b[28 + n:28 + n + m]

def accessor(j, blob, i):
    a = j['accessors'][i]; v = j['bufferViews'][a['bufferView']]
    width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    out = np.frombuffer(blob, dtype=np.float32, count=a['count'] * width, offset=start)
    return out.reshape(a['count'], width) if width > 1 else out

def qmul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0); bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz], -1)

def qrot(q, v):
    u = np.concatenate([v, np.zeros(v.shape[:-1] + (1,))], -1)
    c = q * np.array([-1, -1, -1, 1])
    return qmul(qmul(q, u), c)[..., :3]

def slerp_sample(times, values, t, quat):
    i = np.clip(np.searchsorted(times, t) - 1, 0, len(times) - 2) if len(times) > 1 else np.zeros_like(t, int)
    if len(times) == 1: return np.repeat(values[:1], len(t), 0)
    t0, t1 = times[i], times[i + 1]
    k = np.clip((t - t0) / np.maximum(t1 - t0, 1e-9), 0, 1)[:, None]
    a, b = values[i], values[i + 1]
    if quat:
        b = np.where((a * b).sum(-1, keepdims=True) < 0, -b, b)
        q = a * (1 - k) + b * k
        return q / np.linalg.norm(q, axis=-1, keepdims=True)
    return a * (1 - k) + b * k

def library(path, which):
    j, blob = load(path)
    N = j['nodes']
    parent = {c: i for i, n in enumerate(N) for c in n.get('children', [])}
    idx = {n.get('name'): i for i, n in enumerate(N)}
    rest = {i: (np.array(n.get('translation', [0, 0, 0]), float), np.array(n.get('rotation', [0, 0, 0, 1]), float)) for i, n in enumerate(N)}
    def chain(i):
        out = [i]
        while out[-1] in parent: out.append(parent[out[-1]])
        return out[::-1]
    clips = {a['name']: a for a in j['animations']}

    def sample(clip, t):
        """Global rotation and position of every node at times t (rest where a node isn't animated)."""
        local = {i: (np.repeat(p[None], len(t), 0), np.repeat(q[None], len(t), 0)) for i, (p, q) in rest.items()}
        for ch in clip['channels']:
            s = clip['samplers'][ch['sampler']]; node, path = ch['target']['node'], ch['target']['path']
            times, vals = accessor(j, blob, s['input']), accessor(j, blob, s['output'])
            if path == 'rotation': local[node] = (local[node][0], slerp_sample(times, vals, t, True))
            elif path == 'translation': local[node] = (slerp_sample(times, vals, t, False), local[node][1])
        glob = {}
        def g(i):
            if i in glob: return glob[i]
            p, q = local[i]
            if i in parent:
                pp, pq = g(parent[i])
                glob[i] = (pp + qrot(pq, p), qmul(pq, q))
            else: glob[i] = (p, q)
            return glob[i]
        return {bone: g(idx[names[which - 1]]) for bone, names in BONES.items()}

    rest_pose = sample({'channels': [], 'samplers': []}, np.zeros(1))
    duration = lambda clip: max(float(accessor(j, blob, clip['samplers'][ch['sampler']]['input'])[-1]) for ch in clip['channels'])
    return clips, sample, rest_pose, duration

libs = {1: library(sys.argv[1], 1), 2: library(sys.argv[2], 2)}
q16 = lambda a: base64.b64encode(np.clip(np.round(a * 32767), -32767, 32767).astype(np.int16).tobytes()).decode()

out = {'fps': FPS, 'hips': [round(float(v), 4) for v in libs[1][2]['hips'][0][0]], 'clips': {}}
for name, (lib, src, loop) in CLIPS.items():
    clips, sample, rest, duration = libs[lib]
    clip = clips[src]
    length = duration(clip)
    frames = max(2, int(round(length * FPS)) + (0 if loop else 1))
    t = np.arange(frames) / FPS
    pose = sample(clip, t)
    # hips travel relative to the rest pose: height bob and sway, never the root motion of _RM clips
    hp = pose['hips'][0] - np.array(out['hips'])
    if src.endswith('_RM'): hp[:, 0] = 0; hp[:, 2] = 0
    turn = lambda b: qmul(pose[b][1], rest[b][1][0] * np.array([-1, -1, -1, 1]))   # this frame's rotation × rest⁻¹
    entry = {'frames': frames, 'loop': loop, 'q': {b: q16(turn(b)) for b in BONES}, 'p': base64.b64encode(np.clip(np.round(hp * 1000), -32767, 32767).astype(np.int16).tobytes()).decode()}
    if loop:
        # ground speed: a planted foot slides back under the hips at the speed the body travels, and that's the
        # fastest it moves back all cycle (heels lift early in a sprint, so contact can't be read off height)
        tt = np.arange(int(length * 120)) / 120
        fine = sample(clip, tt)
        speeds = []
        for f in ('foot_L', 'foot_R'):
            z = fine[f][0][:, 2] - fine['hips'][0][:, 2]
            speeds.append(np.percentile(-(np.roll(z, -1) - z)[:-1] * 120, 90))
        entry['speed'] = round(float(np.mean(speeds)), 3) if np.mean(speeds) > 0.3 else 0
    out['clips'][name] = entry
    print(f'{name:11} {src:18} {frames:4} frames  speed {entry.get("speed", "-")}')

with open(sys.argv[3], 'w') as f:
    f.write('// Generated by tools/anim/quaternius.py from the Quaternius Universal Animation Library 1 & 2 (CC0) — regenerate, don\'t edit.\n')
    f.write('export default ' + json.dumps(out, separators=(',', ':')) + ';\n')

"""
Rebuild a map model (binary STL, Z up) out of the game's own pieces on its grid.

    python3 tools/maps/stl2map.py <model.stl> <out.js> [--scale 0.5]

What it reads from the model (1 unit = --scale metres, the main floor becomes y = 0):
  · per 0.25 m column: the floor (lowest upward face), the top, and undersides above head height —
    lintels over doorways, ceilings over rooms and tunnels
  · walls: columns standing well above the floor around them with nothing walkable under them
  · doorways: narrow strips of floor under a lintel; covered areas: wider ones
  · props: smaller bumps on the floor
What it builds, on a 2 m grid:
  · walls on grid lines (tall walls, 4 m where two 2 m runs line up), a door wall where a doorway crosses
  · floors snapped to half-storey levels (-1.75, 0, 1.75, 3.5), ramps kept as slopes, as a 0.5 m terrain
    lattice whose points sit between the grid lines, so each side of a wall keeps its own level
  · ceilings (2 × 2 floor tiles one storey up) over the covered areas
  · crates, barriers, sandbags, containers and cars for the props
"""
import argparse, base64, json, math, struct
from collections import Counter
import numpy as np, cv2
from scipy import ndimage

ap = argparse.ArgumentParser()
ap.add_argument('stl'); ap.add_argument('out')
ap.add_argument('--scale', type=float, default=0.5)
a = ap.parse_args()

C = 0.25          # raster cell (m)
G = 2.0           # wall grid (m): grid lines at even x / z
HALF = 48.25      # map half size: the 0.5 m lattice points (-HALF + 0.5 i) fall halfway between grid lines
LAT = 0.5
STOREY = 3.5
OFF, NL = -48.0, 49  # grid line k at OFF + G k
LEVELS = [(-9, -1.75), (-2.2, -1.75), (-0.35, 0), (0.9, 0), (1.55, 1.75), (2.75, 1.75), (3.0, 3.5), (9, 3.5)]  # raw → snapped

# ── 1. surfaces per column, in a game-aligned raster (x = -HALF + (i + .5) C, z = -HALF + (j + .5) C) ──
raw = open(a.stl, 'rb').read()
n = struct.unpack('<I', raw[80:84])[0]
rec = np.frombuffer(raw[84:84 + 50 * n], dtype=np.dtype([('n', '<3f4'), ('v', '<9f4'), ('a', '<u2')]))
V = rec['v'].reshape(-1, 3, 3).astype(np.float64) * a.scale
NZ = rec['n'][:, 2]
mn, mx = V.reshape(-1, 3).min(0), V.reshape(-1, 3).max(0)
cx, cy = (mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2
N = int(2 * HALF / C)
top = np.full((N, N), np.nan); low = np.full((N, N), np.nan); under = np.full((N, N), np.nan)
def raster(t):
    gx, gz, gy = t[:, 0] - cx, cy - t[:, 1], t[:, 2]
    i0, i1 = max(0, int((gx.min() + HALF) / C)), min(N, int((gx.max() + HALF) / C) + 1)
    j0, j1 = max(0, int((gz.min() + HALF) / C)), min(N, int((gz.max() + HALF) / C) + 1)
    if i0 >= i1 or j0 >= j1: return None
    X, Z = np.meshgrid(-HALF + (np.arange(i0, i1) + 0.5) * C, -HALF + (np.arange(j0, j1) + 0.5) * C)
    (ax, bx, qx), (az, bz, qz), (ay, by, qy) = gx, gz, gy
    den = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz)
    if abs(den) < 1e-12: return None
    l1 = ((bz - qz) * (X - qx) + (qx - bx) * (Z - qz)) / den
    l2 = ((qz - az) * (X - qx) + (ax - qx) * (Z - qz)) / den
    m = (l1 >= -1e-6) & (l2 >= -1e-6) & (1 - l1 - l2 >= -1e-6)
    if not m.any(): return None
    return (slice(j0, j1), slice(i0, i1)), np.where(m, l1 * ay + l2 * by + (1 - l1 - l2) * qy, np.nan)
# pass 1: tops and floors (upward faces); pass 2: undersides above head height over that floor
for t, nz in zip(V, NZ):
    if abs(nz) < 0.2 or not (r := raster(t)): continue
    sl, Y = r
    top[sl] = np.fmax(top[sl], Y)
    if nz > 0: low[sl] = np.fmin(low[sl], Y)
for t, nz in zip(V, NZ):
    if nz > -0.2 or not (r := raster(t)): continue
    sl, Y = r
    under[sl] = np.fmin(under[sl], np.where(Y > low[sl] + 1.6, Y, np.nan))
inside = ~np.isnan(top)
vals, counts = np.unique(np.round(low[~np.isnan(low)], 2), return_counts=True)
base = vals[counts.argmax()]

# overhang: a downward face with headroom above the lowest floor (doorway lintels, ceilings)
over = inside & ~np.isnan(low) & ~np.isnan(under) & (under - low > 1.6)
head = np.where(over, under - low, np.nan)

# ── 2. floor, walls, props ──
surface = np.where(over, low, top)
surface = np.where(inside, surface, np.nanmin(surface))
disc = np.hypot(*np.mgrid[-6:7, -6:7]) <= 6.2
floor = ndimage.median_filter(ndimage.grey_opening(surface, footprint=disc), size=3)
solid_floor = inside & (floor - base > 4.0)
if solid_floor.any():
    _, (ii, jj) = ndimage.distance_transform_edt(~(inside & ~solid_floor), return_indices=True)
    floor = np.where(solid_floor, floor[ii, jj], floor)
above = surface - floor
wall = inside & ~over & (above > 1.9)
prop = inside & ~over & (above > 0.18) & ~wall

# doorways: overhang strips small enough to be a door; the rest are covered areas
lab, nl = ndimage.label(over)
doorway = np.zeros_like(over); covered = np.zeros_like(over)
for k in range(1, nl + 1):
    comp = lab == k
    if comp.sum() < 6: continue
    (_, _), (w, d), _ = cv2.minAreaRect(np.argwhere(comp)[:, ::-1].astype(np.float32))
    if min(w, d) * C <= 3.0 and max(w, d) * C <= 4.5 and np.nanmedian(head[comp]) < 3.6: doorway |= comp
    else: covered |= comp

def level(r):
    xs, ys = zip(*LEVELS)
    return np.interp(r, xs, ys)

px = lambda v: (v + HALF) / C  # metres → raster index
cell = lambda x, z: (min(N - 1, max(0, int(px(z)))), min(N - 1, max(0, int(px(x)))))

# ── 3. the grid: walkable 2 m cells, their floor level, the walls between ──
M = NL - 1                                        # cells per side; cell (u, v) spans x OFF+G u .. +G, z likewise
walkpx = inside & ~wall & ~solid_floor           # floor you can stand on (props stand on floor too)
lev_px = level(floor - base)
walk = np.zeros((M, M), bool); clev = np.zeros((M, M)); cover = np.zeros((M, M))
box = lambda u: slice(int(px(OFF + G * u)), int(px(OFF + G * (u + 1))))
for u in range(M):
    for v in range(M):
        w = walkpx[box(v), box(u)]
        walk[v, u] = w.mean() >= 0.5
        if walk[v, u]: clev[v, u] = float(np.median(lev_px[box(v), box(u)][w]))
        cover[v, u] = covered[box(v), box(u)].mean()
# one walkable region of a few cells hidden in a wall mass is noise
wl, nw = ndimage.label(walk)
for k in range(1, nw + 1):
    if (wl == k).sum() < 4: walk[wl == k] = False
snap = lambda y: round(y * 4) / 4
clev = np.where(walk, np.vectorize(snap)(clev), 0.0)

def band(vertical, k, b, mask, reach=0.75):
    """Share of edge (k, b)'s length with `mask` within `reach` of the line."""
    line = OFF + G * k
    c0, c1 = max(0, int(px(line - reach))), min(N, int(px(line + reach)) + 1)
    hits = 0
    for r in range(8):
        row = int(px(OFF + G * b + (r + 0.5) * G / 8))
        hits += (mask[row, c0:c1] if vertical else mask[c0:c1, row]).any()
    return hits / 8

# edges: vertical edge (k, b) is the line x = OFF + G k between cells (k-1, b) and (k, b)
edges = {}
for vertical in (True, False):
    for k in range(NL):
        for b in range(M):
            A = (b, k - 1) if vertical else (k - 1, b)   # (row v, col u) on the low side
            B = (b, k) if vertical else (k, b)
            wa = 0 < k and walk[A]; wb = k < M and walk[B]
            if wa != wb: edges[(vertical, k, b)] = {}                     # the edge of the playable area
            elif wa and wb:
                # a wall between two playable areas: wall along most of the line itself (a thick wall
                # crossing the cell row lights up only part of it)
                if band(vertical, k, b, wall, 0.5) >= 0.7:
                    edges[(vertical, k, b)] = {}

# one door per doorway in the model, on the grid line running along its opening
dlab, nd = ndimage.label(doorway)
for k in range(1, nd + 1):
    js, is_ = np.nonzero(dlab == k)
    if len(js) < 6: continue
    gx, gz = -HALF + (is_.mean() + 0.5) * C, -HALF + (js.mean() + 0.5) * C
    along_x = np.ptp(is_) >= np.ptp(js)          # the opening is wider than the wall is thick
    vertical = not along_x                       # an opening along x sits in a wall along x: a horizontal edge
    line_at, span_at = (gx, gz) if vertical else (gz, gx)
    kk = int(round((line_at - OFF) / G)); b = int((span_at - OFF) // G)
    if not (0 <= kk < NL and 0 <= b < M): continue
    edges[(vertical, kk, b)] = {'door': True}
    # a door hangs in a wall: carry the wall on along its line while the model has one there
    for step in (-1, 1):
        for n in range(1, 4):
            nb = b + step * n
            if not (0 <= nb < M) or (vertical, kk, nb) in edges or band(vertical, kk, nb, wall, 0.6) < 0.4: break
            edges[(vertical, kk, nb)] = {}

# a door whose line touches no other wall at either end would stand alone in the open: leave it out
def ends(vertical, k, b):
    line = OFF + G * k
    return [(line, OFF + G * b), (line, OFF + G * (b + 1))] if vertical else [(OFF + G * b, line), (OFF + G * (b + 1), line)]
corner = Counter(p for key in edges for p in ends(*key))
for key in [k for k, e in edges.items() if e.get('door')]:
    if all(corner[p] < 2 for p in ends(*key)): del edges[key]

blocked = lambda vertical, k, b: (vertical, k, b) in edges

# ── 4. floor lattice: each point takes its cell's level, blending into open neighbours (ramps) only ──
seg = int(round(2 * HALF / LAT))
lat = np.zeros((seg + 1, seg + 1))
# a cell nobody walks in copies its nearest walkable cell, so walls round it have no slope at their feet
dist, (vi, ui) = ndimage.distance_transform_edt(~walk, return_indices=True)
fill = np.where(dist <= 1, clev[vi, ui], 0.0)   # further out, behind the walls: the main floor
for j in range(seg + 1):
    for i in range(seg + 1):
        x, z = -HALF + i * LAT, -HALF + j * LAT
        u, v = min(M - 1, max(0, int((x - OFF) // G))), min(M - 1, max(0, int((z - OFF) // G)))
        own = fill[v, u]
        if not walk[v, u]: lat[j, i] = own; continue
        # bilinear between the four nearest cell centres, a neighbour counting only if it's open to us
        fx, fz = (x - OFF) / G - 0.5, (z - OFF) / G - 0.5
        u0, v0 = int(math.floor(fx)), int(math.floor(fz)); tx, tz = fx - u0, fz - v0
        def val(uu, vv):
            if not (0 <= uu < M and 0 <= vv < M) or not walk[vv, uu]: return own
            if abs(clev[vv, uu] - own) > 1.0: return own
            if uu != u and blocked(True, max(u, uu), v): return own
            if vv != v and blocked(False, max(v, vv), u): return own
            if uu != u and vv != v and (blocked(True, max(u, uu), vv) or blocked(False, max(v, vv), uu)): return own
            return clev[vv, uu]
        lat[j, i] = (val(u0, v0) * (1 - tx) + val(u0 + 1, v0) * tx) * (1 - tz) + (val(u0, v0 + 1) * (1 - tx) + val(u0 + 1, v0 + 1) * tx) * tz
h = np.clip(np.round(lat * 10), -128, 127).astype(np.int8)

# ── 5. pieces ──
pieces = []
def put(type, x, z, rot=0, y=0, **extra):
    pieces.append({'type': type, 'x': round(float(x), 3), 'y': round(float(y), 3), 'z': round(float(z), 3), 'rot': int(rot), **extra})

def sides(vertical, k, b):
    cells = [(b, k - 1), (b, k)] if vertical else [(k - 1, b), (k, b)]
    ys = [clev[c] for c in cells if 0 <= c[0] < M and 0 <= c[1] < M and walk[c]]
    return (min(ys), max(ys)) if ys else (0.0, 0.0)

done = set()
for key in sorted(edges):
    if key in done: continue
    vertical, k, b = key
    lo, hi = sides(*key)
    door = edges[key].get('door')
    nxt = (vertical, k, b + 1)
    pair = not door and nxt in edges and nxt not in done and not edges[nxt].get('door') and b % 2 == 0 and sides(*nxt) == (lo, hi)
    done.add(key)
    if pair: done.add(nxt)
    length = 4 if pair else 2
    line, mid = OFF + G * k, OFF + G * b + length / 2
    x, z = (line, mid) if vertical else (mid, line)
    # the wall stands on its higher side and its face runs down past the lowest ground along either side
    # (ramps slope along walls), so its foot never shows a gap
    ground = []
    for t in np.arange(OFF + G * b + 0.25, OFF + G * b + length, LAT):
        for side in (-0.25, 0.25):
            gx_, gz_ = (line + side, t) if vertical else (t, line + side)
            ground.append(lat[int(round((gz_ + HALF) / LAT)), int(round((gx_ + HALF) / LAT))])
    drop = hi - min(lo, min(ground)) + 0.3
    put('wall_tall_door' if door else 'wall_tall' if pair else 'wall_tall_short', x, z, 90 if vertical else 0, hi, drop=round(drop, 2))

# ceilings over the covered areas: a 2 × 2 tile one storey above the floor wherever most of a cell is covered
for u in range(M):
    for v in range(M):
        if walk[v, u] and cover[v, u] > 0.5: put('floor_tile', OFF + G * u + 1, OFF + G * v + 1, 0, clev[v, u] + STOREY)

# props, as the pieces they look most like
plab, nprop = ndimage.label(prop)
for k in range(1, nprop + 1):
    blob = plab == k
    if blob.sum() < 8: continue
    js, is_ = np.nonzero(blob)
    pts = np.stack([-HALF + (is_ + 0.5) * C, -HALF + (js + 0.5) * C], 1).astype(np.float32)
    (x, z), (w, d), ang = cv2.minAreaRect(pts)
    w, d = w + C, d + C
    if w < d: w, d, ang = d, w, ang + 90
    y = float(lat[min(seg, int(round((np.median(js) * C + C / 2) / LAT))), min(seg, int(round((np.median(is_) * C + C / 2) / LAT)))])
    hgt = float(np.nanmax(surface[blob]) - np.median(floor[blob]))
    rot = int(round(-ang / 15) * 15) % 360
    ux, uz = math.cos(math.radians(rot)), -math.sin(math.radians(rot))  # the piece's local +X in the world
    along = lambda length, step: np.arange(-(length - step) / 2, (length - step) / 2 + 0.01, step) if length > step else [0.0]
    if w >= 5 and hgt >= 1.8: put('container', x, z, rot, y)
    elif 3.6 <= w <= 5.2 and 1.5 <= d <= 2.4 and hgt <= 1.8: put('sedan', x, z, rot, y)
    elif d <= 0.55 and hgt <= 0.8: continue  # a kerb or a lip along a ledge: the floor levels cover it
    elif w >= 1.8 and d <= 1.0 and hgt <= 1.25:
        for t in along(w, 2.0): put('jersey', x + ux * t, z + uz * t, rot + 90, y)
    elif w >= 1.8 and hgt <= 0.85:
        for t in along(w, 2.0): put('sandbags', x + ux * t, z + uz * t, rot, y)
    else:
        stack = 2 if hgt > 1.75 else 1
        for t in along(w, 1.2):
            for u in along(d, 1.2):
                for s in range(stack): put('crate', x + ux * t - uz * u, z + uz * t + ux * u, rot + s * 15, y + s * 1.2)

# props must stand clear of the walls (the grid moved walls up to 1 m): push each one out along the wall
SIZE = {'crate': (0.6, 0.6), 'jersey': (1.0, 0.35), 'sandbags': (1.0, 0.45), 'container': (3.03, 1.22), 'sedan': (2.25, 0.95)}
segs = []
for (vertical, k, b) in edges:
    line = OFF + G * k
    segs.append((vertical, line, OFF + G * b, OFF + G * (b + 1)))
def footprint(p):
    hx, hz = SIZE[p['type']]
    r = math.radians(p['rot']); c, s_ = abs(math.cos(r)), abs(math.sin(r))
    return hx * c + hz * s_, hx * s_ + hz * c          # half extents of its axis-aligned box
moved = 0
for p in pieces:
    if p['type'] not in SIZE: continue
    for _ in range(4):
        ex, ez = footprint(p)
        hit = False
        for vertical, line, s0, s1 in segs:
            if vertical and s0 - 0.15 < p['z'] + ez and p['z'] - ez < s1 + 0.15 and abs(p['x'] - line) < ex + 0.2:
                p['x'] = line + math.copysign(ex + 0.22, p['x'] - line or 1); hit = True
            elif not vertical and s0 - 0.15 < p['x'] + ex and p['x'] - ex < s1 + 0.15 and abs(p['z'] - line) < ez + 0.2:
                p['z'] = line + math.copysign(ez + 0.22, p['z'] - line or 1); hit = True
        if not hit: break
        moved += 1
    gi, gj = int(round((p['x'] + HALF) / LAT)), int(round((p['z'] + HALF) / LAT))
    stack = round(p['y'] - float(lat[gj, gi]), 1) if p['type'] == 'crate' else 0
    p['y'] = round(float(lat[gj, gi]) + (1.2 if stack >= 0.6 else 0), 3)   # sit on the ground (a stacked crate on its partner)
# and must leave you somewhere to stand: none pushed off the playable cells, none in front of a door
doors_at = [(OFF + G * k, OFF + G * b + 1) if v else (OFF + G * b + 1, OFF + G * k) for (v, k, b), e in edges.items() if e.get('door')]
def clear(p):
    if p['type'] not in SIZE: return True
    u, v = int((p['x'] - OFF) // G), int((p['z'] - OFF) // G)
    if not (0 <= u < M and 0 <= v < M and walk[v, u]): return False
    ex, ez = footprint(p)
    return all(abs(p['x'] - dx) > ex + 0.9 or abs(p['z'] - dz) > ez + 0.9 for dx, dz in doors_at)
kept = [p for p in pieces if clear(p)]
print('props pushed clear of walls:', moved, '· dropped (off the floor / blocking a door):', len(pieces) - len(kept))
pieces[:] = kept

data = {'size': 2 * HALF, 'seg': seg, 'h': base64.b64encode(h.tobytes()).decode(), 'pieces': pieces}
with open(a.out, 'w') as f:
    f.write('// Generated by tools/maps/stl2map.py from the col-2 model — edit the model and regenerate, not this file.\n')
    f.write('export default ' + json.dumps(data, separators=(',', ':')) + ';\n')
print('base', round(base, 2), 'walkable cells', int(walk.sum()), 'wall edges', len(edges), 'doors', sum(1 for e in edges.values() if e.get('door')), '|', dict(Counter(p['type'] for p in pieces)))

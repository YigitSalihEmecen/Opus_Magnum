"""
Convert a map model (binary STL, Z up) into a game map module: a heightfield for the floors, extruded
outlines for the walls and boxes/crates/cars for the props.

    python3 tools/maps/stl2map.py <model.stl> <out.js> --scale 0.5 --name col-2

How it reads the model:
  1. Rasterise the top surface (max Z per 0.25 m cell).
  2. Floors = a grey opening of that surface with a ~3 m disc: anything narrower than the disc that sticks
     up (walls, pillars, crates, cars) is shaved off, wide floors, ramps and platforms stay.
  3. Walls = cells standing more than WALL_MIN above the floor; split by top height, each piece becomes a
     traced outline (with holes) extruded from below the floor to its top.
  4. Props = smaller bumps: crates where they fit a crate, cars where they fit a car, else a sized block.
  5. The floor is resampled onto a 0.5 m lattice and stored as int8 decimetres (base64).
Model units are scaled by --scale (0.5 m per unit for this map); the main floor becomes y = 0.
"""
import argparse, base64, json, math, struct
import numpy as np, cv2
from scipy import ndimage

ap = argparse.ArgumentParser()
ap.add_argument('stl'); ap.add_argument('out')
ap.add_argument('--scale', type=float, default=0.5)
ap.add_argument('--name', default='map')
ap.add_argument('--size', type=int, default=96)
ap.add_argument('--lattice', type=float, default=0.5)
a = ap.parse_args()

S, CELL = a.scale, 0.25          # metres per model unit, raster cell (m)
WALL_MIN, PROP_MIN = 1.9, 0.18   # metres above the floor
SOLID_FLOOR, BAND, CAP = 4.0, 0.25, 7.0  # solid floor above this; top height steps; tallest top (m)

raw = open(a.stl, 'rb').read()
n = struct.unpack('<I', raw[80:84])[0]
rec = np.frombuffer(raw[84:84 + 50 * n], dtype=np.dtype([('n', '<3f4'), ('v', '<9f4'), ('a', '<u2')]))
V = rec['v'].reshape(-1, 3, 3).astype(np.float64) * S

mn, mx = V.reshape(-1, 3).min(0), V.reshape(-1, 3).max(0)
cx, cy = (mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2
W, H = int(math.ceil((mx[0] - mn[0]) / CELL)) + 2, int(math.ceil((mx[1] - mn[1]) / CELL)) + 2
x0, y0 = mn[0] - CELL, mn[1] - CELL

# 1. top surface
hm = np.full((H, W), np.nan)
for t in V:
    xs, ys = t[:, 0], t[:, 1]
    i0, i1 = int((xs.min() - x0) / CELL), int((xs.max() - x0) / CELL) + 1
    j0, j1 = int((ys.min() - y0) / CELL), int((ys.max() - y0) / CELL) + 1
    gx, gy = x0 + (np.arange(i0, i1) + 0.5) * CELL, y0 + (np.arange(j0, j1) + 0.5) * CELL
    if not len(gx) or not len(gy): continue
    X, Y = np.meshgrid(gx, gy)
    (ax, ay, az), (bx, by, bz), (qx, qy, qz) = t
    den = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy)
    if abs(den) < 1e-12: continue
    l1 = ((by - qy) * (X - qx) + (qx - bx) * (Y - qy)) / den
    l2 = ((qy - ay) * (X - qx) + (ax - qx) * (Y - qy)) / den
    l3 = 1 - l1 - l2
    m = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
    if m.any(): hm[j0:j1, i0:i1] = np.fmax(hm[j0:j1, i0:i1], np.where(m, l1 * az + l2 * bz + l3 * qz, np.nan))
inside = ~np.isnan(hm)
filled = hm.copy()
filled[~inside] = np.nanmin(hm)

# main floor level = the most common height
vals, counts = np.unique(np.round(hm[inside], 2), return_counts=True)
base = vals[counts.argmax()]

# 2. floors
disc = np.hypot(*np.mgrid[-6:7, -6:7]) <= 6.2
floor = ndimage.grey_opening(filled, footprint=disc)
floor = ndimage.median_filter(floor, size=3)

# anything the opening kept that stands far above the main floor (thick pillars, wall bulges, the sloped
# masses outside the playfield) is solid too, not floor: the floor under it is taken from around it
solid_floor = inside & (floor - base > SOLID_FLOOR)
if solid_floor.any():
    _, (ii, jj) = ndimage.distance_transform_edt(~(inside & ~solid_floor), return_indices=True)
    floor = np.where(solid_floor, floor[ii, jj], floor)
above = filled - floor

# 3 + 4. everything standing on the floor, traced per top-height band: walls, pillars, boxes, cars
walls, props = [], []
solid = inside & (above > PROP_MIN)
# low tops keep 0.25 m steps; tall masses (sloped buttresses outside the lanes) step by 0.5 m and stop at
# the boundary walls' height, so a slope reads as a few terraces instead of dozens of slivers
rel = filled - base
tops = base + np.where(rel < 3, np.round(rel / BAND) * BAND, np.minimum(np.round(rel / 0.5) * 0.5, CAP))
lab, nlab = ndimage.label(solid)

def to_world(px, py):
    return [round(x0 + (px + 0.5) * CELL - cx, 2), round(-(y0 + (py + 0.5) * CELL - cy), 2)]

for k in range(1, nlab + 1):
    comp = lab == k
    if comp.sum() < 5: continue
    for top in np.unique(tops[comp]):
        part = comp & (tops == top)
        sub, ns = ndimage.label(part)
        for s_ in range(1, ns + 1):
            piece = sub == s_
            if piece.sum() < 4: continue
            ring = ndimage.binary_dilation(piece, iterations=2) & ~solid & inside
            bottom = float(np.median(floor[ring])) if ring.any() else float(np.median(floor[piece]))
            low = float(floor[ring].min()) if ring.any() else bottom
            height = float(top) - bottom
            cs, hier = cv2.findContours(piece.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
            for ci, c in enumerate(cs):
                if hier[0][ci][3] != -1 or len(c) < 3: continue
                outline = cv2.approxPolyDP(c, 0.6, True).reshape(-1, 2).astype(float)
                pts = [to_world(px, py) for px, py in outline]
                holes = [[to_world(px, py) for px, py in cv2.approxPolyDP(cs[hi], 0.6, True).reshape(-1, 2)] for hi in range(len(cs)) if hier[0][hi][3] == ci and len(cs[hi]) >= 3]
                # a clean rectangle of crate or car size becomes that prop
                wp = np.array(pts, np.float32)
                (rx, rz), (w, d), ang = cv2.minAreaRect(wp)
                w, d = w + CELL, d + CELL
                if w < d: w, d, ang = d, w, ang + 90
                rect = cv2.contourArea(wp) / max(1e-6, (w - CELL) * (d - CELL)) > 0.8 and not holes
                kind = None
                if rect and 0.9 <= w <= 1.5 and 0.9 <= d <= 1.5 and 0.8 <= height <= 1.45: kind = 'crate'
                elif rect and 0.9 <= w <= 1.6 and 0.9 <= d <= 1.6 and 1.6 <= height <= 2.6: kind = 'crate2'
                elif rect and 3.9 <= w <= 4.9 and 1.6 <= d <= 2.3 and 1.0 <= height <= 1.7: kind = 'sedan'
                if kind:
                    props.append({'kind': kind, 'x': round(float(rx), 2), 'z': round(float(rz), 2), 'rot': round(-float(ang), 1), 'y': round(bottom - base, 2)})
                elif height > WALL_MIN:
                    walls.append({'pts': pts, 'holes': holes, 'y': round(low - base - 0.3, 2), 'top': round(float(top) - base, 2)})
                else:
                    props.append({'kind': 'block', 'pts': pts, 'holes': holes, 'y': round(low - base - 0.1, 2), 'top': round(float(top) - base, 2)})

# 5. floor lattice (outside the model: the main floor)
seg = int(round(a.size / a.lattice)); half = a.size / 2
lat = np.zeros((seg + 1, seg + 1))
for j in range(seg + 1):
    for i in range(seg + 1):
        x, z = -half + i * a.lattice, -half + j * a.lattice
        ci, cj = int((x + cx - x0) / CELL), int((-z + cy - y0) / CELL)
        if 0 <= ci < W and 0 <= cj < H and inside[cj, ci]: lat[j, i] = floor[cj, ci] - base
q = np.clip(np.round(lat * 10), -128, 127).astype(np.int8)

data = {'name': a.name, 'size': a.size, 'seg': seg, 'h': base64.b64encode(q.tobytes()).decode(), 'walls': walls, 'props': props}
with open(a.out, 'w') as f:
    f.write('// Generated by tools/maps/stl2map.py from the col-2 model — edit the model and regenerate, not this file.\n')
    f.write('export default ' + json.dumps(data, separators=(',', ':')) + ';\n')
print(f'walls {len(walls)}  props {len(props)}  lattice {seg}  base {base:.2f}  extent x {mn[0]-cx:.1f}..{mx[0]-cx:.1f} z {-(mx[1]-cy):.1f}..{-(mn[1]-cy):.1f}')

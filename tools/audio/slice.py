import sys, os, wave, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from onsets import load
SR=48000
D, F, K, OUT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def write(name, x, mono=False, gain_db=-1.0):
    if mono: x = x.mean(1, keepdims=True)
    x = x / (np.abs(x).max()+1e-9) * 10**(gain_db/20)
    path = os.path.join(OUT, name + '.wav'); os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(x.shape[1]); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x,-1,1)*32767).astype('<i2').tobytes())
def cut(src, t, dur, fade=0.25, pre=0.004, mono=False, name=None, gain_db=-1.0, curve=2):
    x = load(src); a = max(0, int((t-pre)*SR)); b = min(len(x), int((t+dur)*SR)); y = x[a:b].copy()
    n = len(y); f = int(min(fade, dur*0.9)*SR)
    y[:int(pre*SR)] *= np.linspace(0,1,int(pre*SR))[:,None]
    y[n-f:] *= (np.linspace(1,0,f)**curve)[:,None]
    write(name, y, mono, gain_db)
ak = f'{F}/AK-47/C_28P.wav'
for i,t in enumerate([0.61,3.25,6.02,9.15]): cut(ak, t, 1.4, fade=1.0, name=f'weapon/fire_{i}')
smg = f'{F}/Carl Gustav M45/G_31P.wav'
for i,t in enumerate([0.31, 3.50, 6.73]): cut(smg, t, 0.9, fade=0.7, name=f'weapon/smg_fire_{i}')
pps = f'{F}/PPSh/P_30P.wav'
cut(pps, 0.97, 0.9, fade=0.7, name='weapon/smg_fire_3')
ar = f'{D}/assaultriflereload1_0.wav'; gr = f'{D}/gunreload1.wav'; hg = f'{D}/reload.wav'
cut(ar, 0.25, 0.45, 0.2, mono=True, name='weapon/mag_out_0')
cut(gr, 0.13, 0.45, 0.2, mono=True, name='weapon/mag_out_1')
cut(ar, 1.04, 0.32, 0.15, mono=True, name='weapon/mag_in_0')
cut(gr, 0.69, 0.40, 0.15, mono=True, name='weapon/mag_in_1')
cut(f'{D}/clipload1.wav', 0.03, 0.22, 0.1, mono=True, name='weapon/mag_seat')
cut(hg, 1.03, 0.15, 0.06, mono=True, name='weapon/bolt_back')
cut(hg, 1.19, 0.35, 0.15, mono=True, name='weapon/bolt_forward')
cut(hg, 0.10, 0.45, 0.2, mono=True, name='weapon/mag_drop', gain_db=-6)
eq = f'{D}/equipment_clicks3.wav'
for i,t in enumerate([0.21,0.42,1.47,2.18,2.93]): cut(eq, t, 0.14, 0.06, mono=True, name=f'weapon/click_{i}')
for i in range(10): cut(f'{K}/footstep0{i}.ogg', 0, 0.16, 0.13, pre=0, mono=True, name=f'player/step_{i}', gain_db=-3, curve=4)
for i,n in enumerate(['cloth1','cloth2','cloth3','cloth4']): cut(f'{K}/{n}.ogg', 0, 0.6, 0.25, pre=0, mono=True, name=f'player/cloth_{i}', gain_db=-4)
cut(f'{K}/dropLeather.ogg', 0, 0.5, 0.2, pre=0, mono=True, name='player/land', gain_db=-2)
mb = f'{F}/Mossberg/N_26P.wav'; nv = f'{F}/Nova/O_21P.wav'
for i,(src,t) in enumerate([(mb,0.78),(mb,4.57),(nv,0.43),(nv,3.46)]): cut(src, t, 1.3, fade=1.0, name=f'weapon/shotgun_fire_{i}')
m12 = f'{F}/Model 12/K_17P.wav'
cut(m12, 7.50, 0.16, 0.08, mono=True, name='weapon/pump_back')
cut(m12, 7.67, 0.30, 0.15, mono=True, name='weapon/pump_forward')
pq = f'{F}/Walther PPQ/X_39P.wav'; m11 = f'{F}/1911/A_42P.wav'
for i,(src,t) in enumerate([(pq,1.40),(pq,6.44),(pq,10.66),(m11,0.94)]): cut(src, t, 0.8, fade=0.6, name=f'weapon/pistol_fire_{i}')

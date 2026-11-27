"""
Cuts the game's sound clips out of the CC0 source recordings (sources in public/audio/CREDITS.md).

  python3 tools/audio/slice.py OUT --firearms F     gunshots and pump/bolt foley — F: The Free Firearm Sound
                                                    Library, "Prepared SFX Library" folder
  python3 tools/audio/slice.py OUT --foley D K      reload foley (the OpenGameArt packs, unpacked into D) and
                                                    Kenney "RPG Audio" (K)
  python3 tools/audio/slice.py OUT --shells S       break-action foley — S: "Shotgun Reload Sound effects"
                                                    (ShotgunSounds folder)

OUT is public/audio. Times are shot onsets found with onsets.py.
"""
import sys, os, wave, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from onsets import load

SR = 48000
OUT = sys.argv[1]


def write(name, x, mono=False, gain_db=-1.0):
    if mono: x = x.mean(1, keepdims=True)
    x = x / (np.abs(x).max() + 1e-9) * 10 ** (gain_db / 20)
    path = os.path.join(OUT, name + '.wav'); os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(x.shape[1]); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())


def cut(src, t, dur, fade=0.25, pre=0.004, mono=False, name=None, gain_db=-1.0, curve=2):
    x = load(src); a = max(0, int((t - pre) * SR)); b = min(len(x), int((t + dur) * SR)); y = x[a:b].copy()
    n = len(y); f = int(min(fade, dur * 0.9) * SR)
    y[:int(pre * SR)] *= np.linspace(0, 1, int(pre * SR))[:, None]
    y[n - f:] *= (np.linspace(1, 0, f) ** curve)[:, None]
    write(name, y, mono, gain_db)


def shots(name, takes, dur, fade):
    """takes: [(file, onset)] → weapon/{name}_0 … _n"""
    for i, (src, t) in enumerate(takes): cut(src, t, dur, fade=fade, name=f'weapon/{name}_{i}')


def firearms(F):
    g = lambda gun, take: f'{F}/{gun}/{take}.wav'
    ak = g('AK-47', 'C_28P')
    shots('fire', [(ak, 0.61), (ak, 3.25), (ak, 6.02), (ak, 9.15)], 1.4, 1.0)
    smg = g('Carl Gustav M45', 'G_31P')
    shots('smg_fire', [(smg, 0.31), (smg, 3.50), (smg, 6.73), (g('PPSh', 'P_30P'), 0.97)], 0.9, 0.7)
    mb, nv = g('Mossberg', 'N_26P'), g('Nova', 'O_21P')
    shots('shotgun_fire', [(mb, 0.78), (mb, 4.57), (nv, 0.43), (nv, 3.46)], 1.3, 1.0)
    m12 = g('Model 12', 'K_17P')
    cut(m12, 7.50, 0.16, 0.08, mono=True, name='weapon/pump_back')
    cut(m12, 7.67, 0.30, 0.15, mono=True, name='weapon/pump_forward')
    pq = g('Walther PPQ', 'X_39P')
    shots('pistol_fire', [(pq, 1.40), (pq, 6.44), (pq, 10.66), (g('1911', 'A_42P'), 0.94)], 0.8, 0.6)
    # Osprey DMR: SKS and AR-15, near
    sks, ar = g('SKS', 'U_14P'), g('AR-15', 'D_32P')
    shots('dmr_fire', [(sks, 3.57), (sks, 6.75), (ar, 0.70), (ar, 5.65)], 1.5, 1.1)
    # Hornet SMG: the last shot of each M45 short burst (its tail is clean), and a PPSh single
    m45 = g('Carl Gustav M45', 'G_33P')
    shots('hornet_fire', [(m45, 0.492), (m45, 4.457), (m45, 8.204), (g('PPSh', 'P_16P'), 5.25)], 0.8, 0.6)
    # Jackal revolver: S&W 642 (.38, double action), near and mid
    sw, swm = g('Smith & Wesson 642', 'V_27P'), g('Smith & Wesson 642', 'V_22P')
    shots('revolver_fire', [(sw, 0.80), (sw, 6.22), (swm, 0.67), (swm, 5.50)], 1.2, 0.9)
    # Bison double barrel: Charles Daly and Model 12, near
    cd, w12 = g('CD', 'H_21P'), g('Model 12', 'K_22P')
    shots('double_fire', [(cd, 0.46), (cd, 3.07), (w12, 0.84), (w12, 7.44)], 1.5, 1.1)
    # Coyote scout rifle: Savage Model 10 and Tikka T3, near
    sv, tk = g('Savage 10 .300 Blackout', 'T_27P'), g('Tikka', 'W_29P')
    shots('scout_fire', [(sv, 0.95), (sv, 4.97), (tk, 0.58), (tk, 5.66)], 1.5, 1.1)


def foley(D, K):
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
    for i, t in enumerate([0.21, 0.42, 1.47, 2.18, 2.93]): cut(eq, t, 0.14, 0.06, mono=True, name=f'weapon/click_{i}')
    for i in range(10): cut(f'{K}/footstep0{i}.ogg', 0, 0.16, 0.13, pre=0, mono=True, name=f'player/step_{i}', gain_db=-3, curve=4)
    for i, n in enumerate(['cloth1', 'cloth2', 'cloth3', 'cloth4']): cut(f'{K}/{n}.ogg', 0, 0.6, 0.25, pre=0, mono=True, name=f'player/cloth_{i}', gain_db=-4)
    cut(f'{K}/dropLeather.ogg', 0, 0.5, 0.2, pre=0, mono=True, name='player/land', gain_db=-2)


def shells(S):
    sub, ch, rack = f'{S}/Subsequent Shells.mp3', f'{S}/Shell in Chamber.mp3', f'{S}/Rack.mp3'
    for i, t in enumerate([0.68, 1.26]): cut(sub, t, 0.3, 0.12, mono=True, name=f'weapon/shell_in_{i}')
    cut(rack, 0.64, 0.17, 0.08, mono=True, name='weapon/break_open')
    cut(ch, 1.08, 0.34, 0.15, mono=True, name='weapon/break_close')
    cut(ch, 0.51, 0.16, 0.08, mono=True, name='weapon/latch')


args = sys.argv[2:]
if '--firearms' in args: firearms(args[args.index('--firearms') + 1])
if '--shells' in args: shells(args[args.index('--shells') + 1])
if '--foley' in args: i = args.index('--foley'); foley(args[i + 1], args[i + 2])

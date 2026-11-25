import subprocess, sys, numpy as np
def load(path, sr=48000):
    raw = subprocess.run(['ffmpeg','-v','quiet','-i',path,'-f','f32le','-ac','2','-ar',str(sr),'-'],capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1,2)
def onsets(x, sr=48000, thr_db=-30, gap=0.12):
    env = np.abs(x).max(1)
    win = int(sr*0.005); env = np.convolve(env, np.ones(win)/win, 'same')
    peak = env.max(); thr = peak*10**(thr_db/20)
    out=[]; last=-1e9
    for i in np.flatnonzero((env[1:]>=thr)&(env[:-1]<thr)):
        if (i-last)/sr>gap: out.append(i/sr)
        last=i if env[i]>=thr else last
        last=i
    return out, peak
if __name__=='__main__':
    for p in sys.argv[1:]:
        x=load(p); o,pk=onsets(x, thr_db=float(__import__('os').environ.get('THR','-30')))
        print(p.split('/')[-1], f'dur={len(x)/48000:.2f} peak={pk:.2f} n={len(o)}', ' '.join(f'{t:.2f}' for t in o[:40]))

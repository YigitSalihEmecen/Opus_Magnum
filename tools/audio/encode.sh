#!/bin/sh
# Trims the silent tail off every clip in public/audio (in place) and writes an Opus copy beside it (.ogg).
# The game loads the .ogg where the browser decodes Opus and falls back to the .wav (core/audio.js).
# Run after adding or re-slicing clips: sh tools/audio/encode.sh
set -e
cd "$(dirname "$0")/../../public/audio"
for wav in */*.wav; do
  tmp="${wav%.wav}.tmp.wav"
  # cut everything after the last sample above -65 dB, keeping 40 ms of it as a tail
  ffmpeg -v error -y -i "$wav" -af "areverse,silenceremove=start_periods=1:start_threshold=-65dB:start_silence=0.04,areverse" -c:a pcm_s16le "$tmp"
  mv "$tmp" "$wav"
  ch=$(ffprobe -v error -show_entries stream=channels -of csv=p=0 "$wav")
  ffmpeg -v error -y -i "$wav" -c:a libopus -b:a "$([ "$ch" = 2 ] && echo 96k || echo 64k)" "${wav%.wav}.ogg"
done
du -ch */*.wav | tail -1
du -ch */*.ogg | tail -1

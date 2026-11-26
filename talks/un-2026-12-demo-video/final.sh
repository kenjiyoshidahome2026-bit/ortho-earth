#!/bin/sh
# Final cut: graphics + live clips + English captions -> the-earth-is-round-demo.mp4
# Usage: ./final.sh <folder with s04-onemodel.mp4 s05-quakes.mp4 s06-sats.mp4 s07-offline.mp4 s08-compat.mp4>
set -e
SRC=${1:-$HOME/Movies/ortho-demo}
cd "$(dirname "$0")"
npm i --silent --no-workspaces
for id in s04-onemodel s05-quakes s06-sats s07-offline s08-compat; do
  rm -rf "clips/$id"; mkdir -p "clips/$id"
  ffmpeg -loglevel error -i "$SRC/$id.mp4" -vf scale=1920:1080 -q:v 2 "clips/$id/%05d.jpg"
done
CHANNEL=chrome node rv.js final the-earth-is-round-demo.mp4
echo "done: $(pwd)/the-earth-is-round-demo.mp4"

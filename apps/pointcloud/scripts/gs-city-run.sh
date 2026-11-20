#!/bin/bash
# 置き場：apps/pointcloud/scripts/gs-city-run.sh（作業場所へ run.sh として写し、sheets.json・blocks.txt・boundary6676.geojson・mask*.geojson・base-tileset.json と並べて使う）
# 静岡市全域の GS（2026-11-18）：区画ごとに 県 S3 の zip（既存区画は HF の COPC）→ copc2gs.py → HF の gs/2021-LP-Original/<区画>/ へ上げる
#   bash run.sh <ortho-earth の場所> [並列数=4] [fwd|rev]
#   複数の Mac で分け合える：fwd は blocks.txt の頭から、rev は尻から。済んだ区画は HF の _work/gs-city/parts/<区画>/（tileset.json・stats.json）が印＝どちらかが済ませた区画は飛ばす
#   （同時に同じ区画を作ることは出会った所で 1〜2 区画あり得るが、中身は同じなので害は無い）
#   作業場所はこのファイルのある所。止まっても同じ命令でつづきから。上げ終わった glb は消す。
#   区画が済むたびに parts を全部集めて元の tileset と merge し、gs/2021-LP-Original/tileset.json を上げ直す（2026-11-18：glb だけ先に上げると、
#   作り直した区画は古い tileset の位置で出て最大 465 m ずれた）
set -u
REPO=$(cd "$1" && pwd); P=${2:-4}; ORD=${3:-fwd}; W=$(cd "$(dirname "$0")" && pwd); cd "$W"
export HF_HUB_DISABLE_XET=1 W REPO
HF=KenjiYoshida/shizuoka-pointcloud
mkdir -p gs log
one() {
  blk=$1; d="$W/gs/$blk"; [ -f "$d/done" ] && return 0
  if python3 -c "import sys;from huggingface_hub import HfApi;sys.exit(0 if HfApi().file_exists('$HF','_work/gs-city/parts/$blk/stats.json',repo_type='dataset') else 1)" 2>/dev/null; then
    mkdir -p "$d"; touch "$d/done"; echo "skip $blk (done elsewhere)"; return 0; fi
  rm -rf "$d"
  if ! BLOCKS=$blk SHEETS="$W/sheets.json" MASK="$W/boundary6676.geojson" PREFETCH=3 AHEAD=4 \
       python3 "$REPO/apps/pointcloud/scripts/copc2gs.py" s3 "$d" > "$W/log/$blk.log" 2>&1; then
    echo "FAIL $blk"; return 0; fi
  rm -rf "$d/.cache"
  ok=1
  if [ -d "$d/$blk" ]; then
    ok=0
    for i in 1 2 3 4 5; do
      hf upload $HF "$d/$blk" "gs/2021-LP-Original/$blk" --repo-type dataset --commit-message "GS $blk" >> "$W/log/$blk.log" 2>&1 && { ok=1; break; }
      sleep $((30 * i))
    done
  fi
  [ $ok = 1 ] || { echo "UPLOAD FAIL $blk"; return 0; }
  mkdir -p "$d/part"; [ -f "$d/tileset.json" ] && cp "$d/tileset.json" "$d/part/"; [ -f "$d/stats.json" ] && cp "$d/stats.json" "$d/part/" || echo '{}' > "$d/part/stats.json"
  for i in 1 2 3 4 5; do
    hf upload $HF "$d/part" "_work/gs-city/parts/$blk" --repo-type dataset --commit-message "GS part $blk" >> "$W/log/$blk.log" 2>&1 && break
    sleep $((30 * i))
  done
  rm -f "$d/$blk"/*.glb
  touch "$d/done"; echo "done $blk $(date +%H:%M)"
  publish
}
publish() {
  until mkdir "$W/.pub.lock" 2>/dev/null; do sleep 5; done
  rm -rf "$W/pdl" && python3 -c "from huggingface_hub import snapshot_download as s;s('$HF',repo_type='dataset',allow_patterns=['_work/gs-city/parts/*'],local_dir='$W/pdl')" >/dev/null 2>&1 \
   && python3 "$REPO/apps/pointcloud/scripts/copc2gs.py" merge "$W/merged" "$W/base-tileset.json" "$W"/pdl/_work/gs-city/parts/* \
   && hf upload $HF "$W/merged/tileset.json" gs/2021-LP-Original/tileset.json --repo-type dataset --commit-message "GS tileset (merged parts)" > /dev/null 2>&1 \
   && echo "published $(ls "$W"/pdl/_work/gs-city/parts | wc -l) parts $(date +%H:%M)" || echo "PUBLISH FAIL"
  rmdir "$W/.pub.lock"
}
export -f one publish
export HF
if [ "$ORD" = rev ]; then tail -r blocks.txt 2>/dev/null || tac blocks.txt; else cat blocks.txt; fi | xargs -P "$P" -I{} bash -c 'one {}'
echo "ALL $(ls gs/*/done 2>/dev/null | wc -l) / $(wc -l < blocks.txt) blocks here"; grep -l "Traceback" log/*.log

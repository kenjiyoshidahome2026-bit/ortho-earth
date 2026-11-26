// node rv.js <mode> <out.mp4> [t0] [t1]
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const TL = require('./timeline.js');
(async () => {
  const [mode, out, a, b] = [process.argv[2], process.argv[3], +(process.argv[4]||0), +(process.argv[5]||TL.duration)];
  const fps = TL.fps;
  const ff = spawn('ffmpeg', ['-y','-loglevel','error','-f','image2pipe','-framerate',String(fps),'-c:v','mjpeg','-i','-','-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart', out], { stdio: ['pipe','inherit','inherit'] });
  const br = await chromium.launch({ args: ['--allow-file-access-from-files'], ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}) });
  const p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + __dirname + '/render.html?mode=' + mode);
  await p.evaluate(() => window.ready);
  if (mode === 'final') { const fs = require('fs'); const c = {}; for (const s of TL.scenes) { const d = __dirname + '/clips/' + s.id; if (fs.existsSync(d)) c[s.id] = fs.readdirSync(d).filter(f => f.endsWith('.jpg')).length; } console.log('clips', c); await p.evaluate(c => window.setClipCounts(c), c); }
  const n = Math.round((b - a) * fps);
  for (let i = 0; i < n; i++) {
    const d = await p.evaluate(t => window.frame(t, 0.93), a + i / fps);
    const buf = Buffer.from(d.slice(d.indexOf(',') + 1), 'base64');
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 600 === 0) console.log(out, i, '/', n);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r)); await br.close();
  console.log('done', out);
})();

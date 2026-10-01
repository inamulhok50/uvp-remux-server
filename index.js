// uvp-remux-server
// Pulls an external video URL (MKV/AVI/MOV/TS/etc.), inspects it with ffprobe, and
// uses FFmpeg to remux (or, only where truly necessary, transcode) it into a
// multi-audio, multi-subtitle HLS VOD stream. Requires an actual server with
// FFmpeg installed — this cannot run inside Blogger or a browser.
//
//   GET /hls?src=<encoded source URL>
//     -> 202 { status:'processing', progress:0..1 }   while FFmpeg is working
//     -> 200 { status:'ready', playlist:'<public master.m3u8 URL>' }
//     -> 200 { status:'error', message:'...' }         if it failed
//
//   GET /cache/<id>/...   the generated HLS files (segments support HTTP Range
//                         automatically via express.static; CORS is enabled).
'use strict';
var express = require('express');
var cors = require('cors');
var crypto = require('crypto');
var fs = require('fs');
var fsp = fs.promises;
var path = require('path');
var http = require('http');
var https = require('https');
var { spawn } = require('child_process');

var PORT = process.env.PORT || 8080;
var CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');
var PUBLIC_BASE = (process.env.PUBLIC_BASE || ('http://localhost:' + PORT)).replace(/\/$/, '');
var ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // set to your Blogger origin in production
var CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 7);
var HLS_SEGMENT_SECONDS = Number(process.env.HLS_SEGMENT_SECONDS || 4);
var ENABLE_ABR = process.env.ENABLE_ABR === '1'; // also cut smaller re-encoded renditions for adaptive bitrate

var COPYABLE_VIDEO = ['h264', 'hevc'];
var COPYABLE_AUDIO = ['aac'];
var TEXT_SUBS = ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt'];
var ABR_LADDER = [ // only used when ENABLE_ABR=1; original-quality rendition is always kept as a lossless copy
  { name: '720p', height: 720, videoBitrate: '2800k', audioBitrate: '128k' },
  { name: '480p', height: 480, videoBitrate: '1400k', audioBitrate: '96k' }
];

fs.mkdirSync(CACHE_DIR, { recursive: true });
var jobs = new Map(); // id -> { progress, startedAt }

function idFor(src) { return crypto.createHash('sha1').update(src).digest('hex').slice(0, 24); }

function isSafeUrl(u) { // minimal SSRF guard — tighten further for a public-facing deployment
  var p;
  try { p = new URL(u); } catch (e) { return false; }
  if (!/^https?:$/.test(p.protocol)) return false;
  var h = p.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return false;
  if (/^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  return true;
}

function run(cmd, args) { // spawn a process, resolve with {code, stdout, stderr}
  return new Promise(function (resolve) {
    var p = spawn(cmd, args);
    var out = '', err = '';
    p.stdout.on('data', function (d) { out += d; });
    p.stderr.on('data', function (d) { err += d; });
    p.on('close', function (code) { resolve({ code: code, stdout: out, stderr: err }); });
    p.on('error', function (e) { resolve({ code: -1, stdout: out, stderr: String(e) }); });
  });
}
function runProgress(cmd, args, totalSeconds, onProgress) {
  return new Promise(function (resolve) {
    var p = spawn(cmd, args);
    var err = '';
    p.stderr.on('data', function (d) {
      err += d;
      var m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(String(d));
      if (m && totalSeconds > 0) {
        var t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress(Math.max(0, Math.min(0.98, t / totalSeconds)));
      }
    });
    p.on('close', function (code) { resolve({ code: code, stderr: err }); });
    p.on('error', function (e) { resolve({ code: -1, stderr: String(e) }); });
  });
}

async function probe(src) {
  var r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]);
  if (r.code !== 0) throw new Error('ffprobe failed: ' + r.stderr.slice(0, 500));
  var j = JSON.parse(r.stdout);
  return { duration: parseFloat(j.format && j.format.duration || '0'), streams: j.streams || [] };
}

// Builds the ffmpeg argument list for the main video+audio HLS remux, preferring
// stream copy (lossless, fast, keeps original quality) and only re-encoding a
// stream whose codec HLS/browsers cannot play. Per-rendition sub-playlists
// (stream_0.m3u8, stream_1.m3u8, ...) come straight from ffmpeg's HLS muxer,
// which is reliable; the aggregate master.m3u8 it writes is NOT reliable when
// video is stream-copied (ffmpeg cannot compute a bitrate for a copied stream
// and silently drops that rendition's line — confirmed by testing), so the
// master playlist is authored ourselves in buildMaster() instead of trusting
// ffmpeg's copy of it (master_raw.m3u8, written for debugging, is unused).
function planPrimary(src, info, dir) {
  var video = info.streams.filter(function (s) { return s.codec_type === 'video'; })[0];
  var audios = info.streams.filter(function (s) { return s.codec_type === 'audio'; });
  if (!video) throw new Error('No video stream found.');
  if (!audios.length) audios = [null]; // allow video-only sources

  var videoCopy = COPYABLE_VIDEO.indexOf(video.codec_name) > -1;
  var args = ['-y', '-i', src, '-map', '0:v:0'];
  audios.forEach(function (a, i) { if (a) args.push('-map', '0:a:' + i); });
  args.push('-c:v', videoCopy ? 'copy' : 'libx264');
  if (!videoCopy) args.push('-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  audios.forEach(function (a, i) {
    var copyable = a && COPYABLE_AUDIO.indexOf(a.codec_name) > -1;
    args.push('-c:a:' + i, copyable ? 'copy' : 'aac');
  });
  // -avoid_negative_ts / -start_at_zero keep PTS/DTS anchored at 0 so audio and
  // video segments line up instead of drifting apart (the root cause of A/V
  // desync when a source stream starts with an offset or negative timestamp).
  args.push('-avoid_negative_ts', 'make_zero', '-start_at_zero');
  args.push('-f', 'hls', '-hls_time', String(HLS_SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments');

  var varMap = audios.map(function (a, i) {
    var lang = a && a.tags && a.tags.language ? ',language:' + a.tags.language : '';
    return 'a:' + i + ',agroup:audio' + (i === 0 ? ',default:yes' : '') + lang;
  }).concat(['v:0,agroup:audio']).join(' ');
  args.push('-var_stream_map', varMap);
  args.push('-master_pl_name', 'master_raw.m3u8'); // ffmpeg's own aggregate copy — not served, see note above
  args.push('-hls_segment_filename', path.join(dir, 'seg_%v_%03d.ts'));
  args.push(path.join(dir, 'stream_%v.m3u8'));
  return { args: args, audios: audios, video: video, videoIndex: audios.length };
}

// The video rendition's exact output bitrate isn't reliably available from
// source metadata (MKV often has no per-stream bit_rate at all — confirmed by
// testing), so it's computed from the real size of the segment files ffmpeg
// just produced, divided by duration. This is more accurate than any metadata
// guess and is what actually determines HLS/DASH ABR + buffering behaviour.
async function estimateBandwidth(dir, index, duration) {
  var files = (await fsp.readdir(dir)).filter(function (f) { return f.indexOf('seg_' + index + '_') === 0; });
  var total = 0;
  for (var i = 0; i < files.length; i++) total += (await fsp.stat(path.join(dir, files[i]))).size;
  return duration > 0 ? Math.max(50000, Math.round(total * 8 / duration)) : 800000;
}

function buildMaster(audios, videoIndex, videoBandwidth, videoRes, subs, abr) {
  var lines = ['#EXTM3U', '#EXT-X-VERSION:6'];
  audios.forEach(function (a, i) {
    var lang = a && a.tags && a.tags.language;
    lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="' + (lang || ('Track ' + (i + 1))) +
      '",DEFAULT=' + (i === 0 ? 'YES' : 'NO') + (lang ? ',LANGUAGE="' + lang + '"' : '') + ',URI="stream_' + i + '.m3u8"');
  });
  subs.forEach(function (s, i) {
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="' + (s.label || s.lang).replace(/"/g, '') +
      '",DEFAULT=' + (i === 0 ? 'YES' : 'NO') + ',AUTOSELECT=YES,LANGUAGE="' + s.lang + '",URI="sub_' + s.index + '.m3u8"');
  });
  var attrs = 'BANDWIDTH=' + videoBandwidth + (videoRes ? ',RESOLUTION=' + videoRes : '') + ',AUDIO="audio"' + (subs.length ? ',SUBTITLES="subs"' : '');
  lines.push('#EXT-X-STREAM-INF:' + attrs, 'stream_' + videoIndex + '.m3u8');
  abr.forEach(function (r) {
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=' + r.bandwidth + ',RESOLUTION=' + r.resolution + ',AUDIO="audio"' + (subs.length ? ',SUBTITLES="subs"' : ''));
    lines.push(r.name + '.m3u8');
  });
  return lines.join('\n') + '\n';
}

// Optional lower-resolution renditions for adaptive bitrate (re-encoded, since
// stream copy can't rescale). Written to their own sub-playlists and appended
// into the master afterwards.
async function buildAbrRenditions(src, info, dir, video, onProgress) {
  var rungs = ABR_LADDER.filter(function (r) { return r.height < (video.height || 1e9); });
  var made = [];
  for (var i = 0; i < rungs.length; i++) {
    var r = rungs[i], name = 'abr_' + r.name;
    var args = ['-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', r.videoBitrate, '-vf', 'scale=-2:' + r.height,
      '-c:a', 'aac', '-b:a', r.audioBitrate,
      '-avoid_negative_ts', 'make_zero',
      '-f', 'hls', '-hls_time', String(HLS_SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(dir, name + '_%03d.ts'), path.join(dir, name + '.m3u8')];
    var res = await runProgress('ffmpeg', args, info.duration, onProgress);
    var width = video.width && video.height ? Math.round(video.width * (r.height / video.height) / 2) * 2 : null;
    if (res.code === 0) made.push({
      name: name,
      resolution: width ? width + 'x' + r.height : String(r.height),
      bandwidth: (parseInt(r.videoBitrate, 10) + parseInt(r.audioBitrate, 10)) * 1000
    });
  }
  return made;
}

async function extractSubtitles(src, info, dir) {
  var subs = info.streams.filter(function (s) { return s.codec_type === 'subtitle'; });
  var made = [], skipped = [];
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    if (TEXT_SUBS.indexOf(s.codec_name) === -1) { skipped.push(s.codec_name); continue; }
    var vtt = 'sub_' + i + '.vtt';
    var r = await run('ffmpeg', ['-y', '-i', src, '-map', '0:s:' + i, path.join(dir, vtt)]);
    if (r.code !== 0) { skipped.push(s.codec_name); continue; }
    var dur = info.duration || 0;
    var m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + Math.ceil(dur) +
      '\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:' + dur.toFixed(3) + ',\n' + vtt + '\n#EXT-X-ENDLIST\n';
    await fsp.writeFile(path.join(dir, 'sub_' + i + '.m3u8'), m3u8);
    made.push({ index: i, lang: (s.tags && s.tags.language) || ('sub' + i), label: (s.tags && (s.tags.title || s.tags.language)) || ('Subtitle ' + (i + 1)) });
  }
  return { made: made, skipped: skipped };
}

async function processJob(id, src) {
  var dir = path.join(CACHE_DIR, id);
  var job = { progress: 0 };
  jobs.set(id, job);
  try {
    await fsp.mkdir(dir, { recursive: true });
    var info = await probe(src);
    var plan = planPrimary(src, info, dir);
    var primary = await runProgress('ffmpeg', plan.args, info.duration, function (p) { job.progress = p * 0.65; });
    if (primary.code !== 0) throw new Error('ffmpeg (video/audio) failed: ' + primary.stderr.slice(-800));

    var videoBandwidth = await estimateBandwidth(dir, plan.videoIndex, info.duration);
    var videoRes = plan.video.width && plan.video.height ? plan.video.width + 'x' + plan.video.height : null;
    job.progress = 0.7;

    var subsResult = await extractSubtitles(src, info, dir);
    job.progress = 0.85;

    var abr = ENABLE_ABR ? await buildAbrRenditions(src, info, dir, plan.video, function (p) { job.progress = 0.85 + p * 0.1; }) : [];
    job.progress = 0.97;

    var master = buildMaster(plan.audios, plan.videoIndex, videoBandwidth, videoRes, subsResult.made, abr);
    await fsp.writeFile(path.join(dir, 'master.m3u8'), master);
    await fsp.rm(path.join(dir, 'master_raw.m3u8'), { force: true }); // ffmpeg's unreliable copy — not served, see planPrimary()
    await fsp.writeFile(path.join(dir, 'status.json'), JSON.stringify({
      status: 'ready', createdAt: Date.now(),
      audioTracks: plan.audios.filter(Boolean).length, subtitleTracks: subsResult.made.length,
      skippedSubtitleCodecs: subsResult.skipped, abrRenditions: abr.map(function (r) { return r.name; })
    }));
  } catch (e) {
    await fsp.writeFile(path.join(dir, 'status.json'), JSON.stringify({ status: 'error', message: String(e && e.message || e), createdAt: Date.now() })).catch(function () {});
  } finally {
    jobs.delete(id);
  }
}

var app = express();
app.use('/cache', cors({ origin: ALLOWED_ORIGIN }), express.static(CACHE_DIR, {
  setHeaders: function (res, filePath) {
    res.setHeader('Cache-Control', filePath.endsWith('.m3u8') ? 'no-cache' : 'public, max-age=31536000, immutable');
  }
})); // express.static already serves Range requests correctly for segment files

app.get('/hls', cors({ origin: ALLOWED_ORIGIN }), async function (req, res) {
  var src = req.query.src;
  if (!src || !isSafeUrl(src)) return res.status(400).json({ status: 'error', message: 'A valid http(s) src URL is required.' });
  var id = idFor(src);
  var dir = path.join(CACHE_DIR, id);
  var statusFile = path.join(dir, 'status.json');
  try {
    var st = JSON.parse(await fsp.readFile(statusFile, 'utf8'));
    if (st.status === 'ready') return res.json({ status: 'ready', playlist: PUBLIC_BASE + '/cache/' + id + '/master.m3u8', meta: st });
    if (st.status === 'error') { await fsp.rm(dir, { recursive: true, force: true }).catch(function () {}); }
  } catch (e) { /* not processed yet */ }
  if (jobs.has(id)) return res.status(202).json({ status: 'processing', progress: jobs.get(id).progress });
  processJob(id, src); // fire and forget; poll /hls again for status
  res.status(202).json({ status: 'processing', progress: 0 });
});

app.get('/healthz', function (req, res) { res.json({ ok: true }); });

// periodic cleanup of old cached renditions
setInterval(function () {
  fsp.readdir(CACHE_DIR).then(function (entries) {
    entries.forEach(function (name) {
      var dir = path.join(CACHE_DIR, name);
      fsp.stat(dir).then(function (st) {
        var ageDays = (Date.now() - st.mtimeMs) / 86400000;
        if (ageDays > CACHE_TTL_DAYS) fsp.rm(dir, { recursive: true, force: true }).catch(function () {});
      }).catch(function () {});
    });
  }).catch(function () {});
}, 6 * 3600 * 1000);

app.listen(PORT, function () { console.log('uvp-remux-server listening on :' + PORT); });

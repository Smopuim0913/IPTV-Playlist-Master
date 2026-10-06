/**
 * 探测跑完之后，分辨率那一格到底长什么样 —— 端到端验一遍。
 *
 * 起因：用户实测时表上一片「—」，⟳ 一个都没有。查下来是**服务进程还跑着旧版本**
 * （src/probe.js 里的 noRes 归因是这一轮才加的，前端是静态文件刷新就换、后端得重启），
 * 前端再新也收不到归因字段，于是所有「在线但没读到」都退化成光秃秃的「—」。
 *
 * 所以这个测试专门盯「整条链路上界面会长成什么样」：
 *   假源站（4 类各来一条） → 新起的 server 进程 → SSE 推回来的 row → 前端 resCell 渲染
 *
 * 四个“没读到分辨率”的原因，界面上都要**有东西可看**：
 *   long-gop / seg-fail → ⟳（点下去真会去挖）
 *   audio-only / m3u-note → ?（点开讲清为什么，这类挖也是白挖）
 * 并且顺带钉住「服务端没回报原因」这种旧版本情形也不能又变回光秃秃的「—」。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeSps } from './lib/sps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ' → ' + extra : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grab = (re, what) => {
  const m = APP.match(re);
  if (!m) throw new Error(`源码里抠不出 ${what}，测试该跟着实现一起更新`);
  return m[0];
};

/* ---------------- TS 夹具（沿用项目里已验证的段内偏移） ---------------- */

const PMT_PID = 0x0100;
const VIDEO_PID = 0x0101;
const AUDIO_PID = 0x0200;
const pidHi = (pid) => 0xe0 | ((pid >> 8) & 0x1f);

const pkt = (pid, pusi, payload) => {
  const p = Buffer.alloc(188);
  p[0] = 0x47;
  p[1] = ((pid >> 8) & 0x1f) | (pusi ? 0x40 : 0);
  p[2] = pid & 0xff;
  p[3] = 0x10;
  payload.copy(p, 4);
  return p;
};
const psiPkt = (pid, section) => pkt(pid, true, Buffer.concat([Buffer.from([0x00]), section]));

const patSection = () => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(PMT_PID), PMT_PID & 0xff]),
  ]);
  return Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
};

const pmtSection = (streams) => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(0), 0x00]),
    Buffer.from([0x00, 0x00]),
    ...streams.map(([st, pid]) => Buffer.from([st, pidHi(pid), pid & 0xff, 0x00, 0x00])),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
};

const audioTs = Buffer.concat([
  psiPkt(0x0000, patSection()),
  psiPkt(PMT_PID, pmtSection([[0x03, AUDIO_PID], [0x0f, AUDIO_PID + 1]])),
  pkt(AUDIO_PID, true, Buffer.alloc(64, 0x21)),
]);

const pesWithoutSps = () => {
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), Buffer.from([0x09, 0x10, 0x00, 0x01])]);
  const header = Buffer.from([0x80, 0xc0, 0x03]);
  const len = header.length + payload.length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]), header, payload]);
};

const longGopTs = Buffer.concat([
  psiPkt(0x0000, patSection()),
  psiPkt(PMT_PID, pmtSection([[0x1b, VIDEO_PID]])),
  pkt(VIDEO_PID, true, pesWithoutSps()),
  pkt(VIDEO_PID, false, Buffer.alloc(20, 0x22)),
]);

/** 顺便让「读到分辨率」的对照组也在：1920x1080 那一行不该长 ⟳ */
const videoTs = (() => {
  const sps = makeSps({ width: 1920, height: 1088, crop: [0, 0, 0, 0] });
  const pesPayload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), sps, Buffer.from([0x09, 0x10, 0x00, 0x01])]);
  const header = Buffer.from([0x80, 0xc0, 0x03]);
  const len = header.length + pesPayload.length;
  const pes = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]),
    header,
    pesPayload,
  ]);
  return Buffer.concat([
    psiPkt(0x0000, patSection()),
    psiPkt(PMT_PID, pmtSection([[0x1b, VIDEO_PID]])),
    pkt(VIDEO_PID, true, pes),
  ]);
})();

/* ---------------- 前端 resCell 的桩（跟 resretry.mjs 同一套抠法） ---------------- */

const SRC = [
  grab(/const RES_RETRYABLE = new Set\(\[[^\]]*\]\);/, 'RES_RETRYABLE'),
  grab(/const NO_RES_LABEL = \{[\s\S]*?\n\};/, 'NO_RES_LABEL'),
  grab(/const DEEP_PROBE_BYTES = [^;]*;/, 'DEEP_PROBE_BYTES'),
  grab(/const resCell = \(p\) => \{[\s\S]*?\n\};/, 'resCell'),
  grab(/function explainNoRes\(p\) \{[\s\S]*?\n\}/, 'explainNoRes'),
].join('\n\n');

const ident = (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => String((o && o[k]) ?? ''));
const resCell = new Function(
  't',
  'esc',
  `${SRC}\nreturn resCell;`,
)(ident, (s) => String(s));

/* ---------------- 假源站 ---------------- */

const sub = (seg) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n${seg}\n#EXT-X-ENDLIST\n`;

const origin = http.createServer((q, r) => {
  const u = q.url;
  if (u.endsWith('.m3u8')) {
    r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    if (u.startsWith('/note')) r.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n');
    else if (u.startsWith('/seg404')) r.end(sub('gone.ts'));
    else if (u.startsWith('/audio')) r.end(sub('audio.ts'));
    else r.end(sub('gop.ts'));
    return;
  }
  if (u.includes('gone.ts')) {
    r.writeHead(404);
    r.end();
    return;
  }
  r.writeHead(200, { 'Content-Type': 'video/mp2t' });
  r.end(u.includes('audio') ? audioTs : u.includes('read') ? videoTs : longGopTs);
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originBase = `http://127.0.0.1:${origin.address().port}`;

console.log('分辨率归因与图标（端到端）');

const NODE = process.execPath;
const fakeHome = os.tmpdir();
const child = spawn(NODE, [path.join(ROOT, 'src/server.js')], {
  env: { ...process.env, PORT: '0', USERPROFILE: fakeHome, HOME: fakeHome },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let dead = false;
child.on('exit', () => (dead = true));
child.stderr.on('data', (d) => {
  const s = String(d);
  if (/Error/.test(s)) console.log('    [server]', s.trim().slice(0, 200));
});
let port = 0;
child.stdout.on('data', (d) => {
  const m = /localhost:(\d+)/.exec(String(d));
  if (m) port = Number(m[1]);
});
for (let i = 0; i < 60 && !port; i++) await sleep(150);
const base = `http://127.0.0.1:${port}`;
ok('新起的服务进程起来了', !!port && !dead, `port=${port} dead=${dead}`);

const CASES = [
  { id: 'gop', url: `${originBase}/gop.m3u8` },
  { id: 'seg', url: `${originBase}/seg404.m3u8` },
  { id: 'audio', url: `${originBase}/audio.m3u8` },
  { id: 'note', url: `${originBase}/note.m3u8` },
  { id: 'read', url: `${originBase}/read.ts` },
];

let rows = null;
try {
  const res = await fetch(`${base}/api/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: null, name: 'attrib', entries: CASES }),
  });
  ok('登记列表成功', res.ok);

  const sse = await fetch(`${base}/api/probe?ids=${CASES.map((c) => c.id).join(',')}&concurrency=1&timeout=6000`);
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  rows = new Map();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue;
      const m = JSON.parse(l.slice(6));
      if (m.type === 'result') rows.set(m.row.id, m.row);
      if (m.type === 'done') {
        reader.cancel().catch(() => {});
        break;
      }
    }
    if (rows.size === CASES.length) break;
  }
} finally {
  try {
    child.kill();
  } catch {}
  origin.close();
}

ok('五条都探到了结果', rows && rows.size === CASES.length, String(rows && rows.size));

if (rows) {
  const html = (id) => resCell(rows.get(id));
  const gop = rows.get('gop');
  const seg = rows.get('seg');
  const audio = rows.get('audio');
  const note = rows.get('note');
  const read = rows.get('read');

  ok('长 GOP 那条：服务端回报了 long-gop 归因', gop && gop.noRes === 'long-gop', gop && JSON.stringify(gop.noRes));
  ok('长 GOP 那条：分辨率格里挂着 ⟳，可以直接点着重挖', /data-act="resretry"/.test(html('gop')), html('gop'));
  ok('长 GOP 那条：⟳ 旁边还是那个「—」本体', /class="res low"[^>]*>/.test(html('gop')), html('gop'));

  ok('分片取不到那条：服务端回报 seg-fail', seg && seg.noRes === 'seg-fail', seg && JSON.stringify(seg.noRes));
  ok('分片取不到那条：也挂 ⟳', /data-act="resretry"/.test(html('seg')), html('seg'));

  ok('纯音频那条：服务端回报 audio-only', audio && audio.noRes === 'audio-only', audio && JSON.stringify(audio.noRes));
  ok('纯音频那条：格子里直接写「纯音频」，不再挂 ⟳ / ? 图标',
     /class="res low res-audio"[^>]*>纯音频</.test(html('audio')) &&
       !/data-act="resretry"|data-act="noreswhy"/.test(html('audio')), html('audio'));
  ok('纯音频那条：悬停那三个字仍看得到服务端的原因（只有音频）',
     /只有音频/.test(html('audio')), html('audio'));

  ok('源站没写那条：服务端回报 m3u-note', note && note.noRes === 'm3u-note', note && JSON.stringify(note.noRes));
  ok('源站没写那条：不给 ⟳、给「?」', !/resretry/.test(html('note')) && /noreswhy/.test(html('note')), html('note'));

  ok('读到分辨率那条：归因是空的', read && !read.noRes, read && JSON.stringify(read.noRes));
  ok('读到分辨率那条：显示分辨率本身，不挂 ⟳ 也不挂 ?',
     /1920x1088/.test(html('read')) && !/resretry|noreswhy/.test(html('read')), html('read'));

  // 「在线但没读到」的条目**每一个**都得有东西可看 —— 光秃秃一个「—」就是用户那次实测的样子：
  // 要么有图标（⟳ 可挖 / ? 要看原因），要么直接把结论写在格子里（纯音频）
  const naked = [gop, seg, audio, note].filter((r) => {
    const h = resCell(r);
    return !/<button/.test(h) && !/res-audio/.test(h);
  });
  ok('四条「在线但没读到」的，没有一个格子是光秃秃的「—」', naked.length === 0,
     naked.map((r) => r.id + ':' + r.noRes).join(','));

  // 归因说明直接挂 tooltip：悬停一次就读完，不用点开弹窗、也不用追那一闪而过的提示条
  ok('⟳ 的 tooltip 里第一行就写清原因', /title="[^"]*原因：/.test(html('gop')), html('gop'));
  ok('⟳ 的 tooltip 里第二行指路「点这个 ⟳ 用更大的窗口」', /点这个 ⟳/.test(html('gop')), html('gop'));
  ok('「?」的 tooltip 里也写清原因', /title="[^"]*原因：/.test(html('note')), html('note'));

  // 旧版本服务（没回报归因）的情形也不能退化成「—」
  const oldRow = JSON.parse(JSON.stringify(gop));
  delete oldRow.noRes;
  delete oldRow.noResText;
  ok('服务跑着旧版本（row 里没归因）：这一格仍留「?」', /data-act="noreswhy"/.test(resCell(oldRow)), resCell(oldRow));
}

console.log(failed ? `\n[分辨率归因·端到端] ${failed} 项失败（通过 ${pass}）` : `\n[分辨率归因·端到端] 全部通过（${pass} 项）`);
process.exit(failed ? 1 : 0);

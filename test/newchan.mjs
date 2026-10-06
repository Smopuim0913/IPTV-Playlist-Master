/**
 * 真浏览器回归：Microsoft Edge 无头 + DevTools 协议，验「添加新频道」这条链路。
 *
 * 守的是什么：新增频道时把「播放地址」挪到第一个输入框，填完停手自动去探一次，
 * 读到流内 SDT 服务名就填进频道名。这套逻辑在 DOM 桩上（test/sdttitle.mjs）能过，
 * 但桩里 `$()` 的选择器是我照着源码写的 —— 真要选择器写歪了（比如
 * `#modalFields textarea[data-k="url"]` 在真 DOM 里一个都匹配不到），桩照样绿。
 * 所以这里必须真的开一个浏览器，点「+ 新频道」，真敲地址，看服务名有没有落进框里。
 *
 * 没装 Edge / 调试端口占不上就跳过（exit 0），不影响主测试套件。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- CDP 客户端（纯内置模块） ---------------- */
const getJSON = (u) =>
  new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => {
          try {
            res(JSON.parse(b));
          } catch {
            res(b);
          }
        });
      })
      .on('error', rej);
  });

function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname);
    sock.write(
      `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    let up = false;
    const waiters = new Map();
    let id = 0;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        up = true;
        buf = buf.slice(i + 4);
        resolve(api);
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op !== 1) {
          if (op === 8) sock.end();
          continue;
        }
        const m = JSON.parse(payload.toString('utf8'));
        if (m.id && waiters.has(m.id)) {
          const { resolve: r, reject: rj } = waiters.get(m.id);
          waiters.delete(m.id);
          m.error ? rj(new Error(JSON.stringify(m.error))) : r(m.result);
        }
      }
    });
    sock.on('error', reject);
    const send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const mask = crypto.randomBytes(4);
      const n = payload.length;
      let head;
      if (n < 126) head = Buffer.from([0x81, 0x80 | n]);
      else if (n < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x81;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(n, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x81;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(n), 2);
      }
      const masked = Buffer.alloc(n);
      for (let i = 0; i < n; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([head, mask, masked]));
    };
    const api = {
      send: (method, params, sessionId) =>
        new Promise((res, rej) => {
          const i2 = ++id;
          waiters.set(i2, { resolve: res, reject: rej });
          send({ id: i2, method, params, ...(sessionId ? { sessionId } : {}) });
          setTimeout(() => {
            if (waiters.has(i2)) {
              waiters.delete(i2);
              rej(new Error('CDP 超时: ' + method));
            }
          }, 20000);
        }),
    };
  });
}

let EDGE = null;
for (const p of [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]) {
  if (existsSync(p)) {
    EDGE = p;
    break;
  }
}
const SKIP = (why) => {
  console.log(`  SKIP ${why}（跳过真浏览器回归）`);
  process.exit(0);
};
if (!EDGE) SKIP('找不到 msedge.exe');

/* ---------------- 假源站：一个带 SDT 服务名的 TS 分片 ---------------- */
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
const VIDEO_PID = 0x0101;
const PMT_PID = 0x0100;
const SDT_PID = 0x0011;
const patSection = () =>
  Buffer.concat([
    Buffer.from([0x00, 0xb0, 0x0d]),
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([0xe1, PMT_PID >> 8, PMT_PID & 0xff]),
    Buffer.alloc(4),
  ]);
const pmtSection = () =>
  Buffer.concat([
    Buffer.from([0x02, 0xb0, 0x17]),
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00, 0xe1, 0x00]),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x1b, 0xe1, VIDEO_PID >> 8, VIDEO_PID & 0xff, 0x00, 0x00]),
    Buffer.alloc(4),
  ]);
function sdtSection(name) {
  const nm = Buffer.from(name, 'utf8');
  const body = Buffer.concat([Buffer.from([0x01, 0x00, nm.length]), nm]);
  const desc = Buffer.concat([Buffer.from([0x48, body.length]), body]);
  const service = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, desc.length]), desc]);
  const rest = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00, 0x00, 0x01, 0xff, 0x00]),
    service,
  ]);
  return Buffer.concat([Buffer.from([0x42, 0xb0, rest.length + 4]), rest, Buffer.alloc(4)]);
}
/** 一个最小 SPS：1920x1080（够让探测把分辨率也算出来） */
const spsPkt = (() => {
  const nal = Buffer.from([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9]);
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), nal]);
  const header = Buffer.from([0x80, 0xc0, 0x00]);
  const len = header.length + payload.length;
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]),
    header,
    payload,
  ]);
})();
const SEG = Buffer.concat([
  psiPkt(0x0000, patSection()),
  psiPkt(PMT_PID, pmtSection()),
  psiPkt(SDT_PID, sdtSection('凤凰')),
  pkt(VIDEO_PID, true, spsPkt),
]);
const PLAYLIST = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.000,', 'seg.ts', '#EXT-X-ENDLIST', ''].join('\n');

const origin = http.createServer((req, res) => {
  if (req.url.startsWith('/live.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(PLAYLIST);
  }
  if (req.url.startsWith('/seg.ts')) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    return res.end(SEG);
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${origin.address().port}`;
const STREAM_URL = `${ORIGIN}/live.m3u8`;

/* ---------------- 起本地服务（自带端口，不跟别的测试抢） ---------------- */
const PORT = 9398;
const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const stopAll = () => {
  try {
    srv.kill();
  } catch {}
  try {
    origin.close();
  } catch {}
};
process.on('exit', stopAll);

let up = false;
for (let i = 0; i < 30 && !up; i++) {
  await sleep(300);
  try {
    up = (await getJSON(`http://127.0.0.1:${PORT}/`)) !== undefined;
  } catch {}
}
if (!up) {
  stopAll();
  SKIP('本地服务没起来');
}

/* ---------------- 起 Edge 无头 + 连 CDP ---------------- */
const debPort = await (async () => {
  for (const p of [9454, 9455, 9456]) {
    try {
      await getJSON(`http://127.0.0.1:${p}/json/version`);
    } catch {}
    const free = await new Promise((res) => {
      const sock = net.connect(p, '127.0.0.1');
      sock.on('connect', () => {
        sock.end();
        res(false);
      });
      sock.on('error', () => res(true));
    });
    if (free) return p;
  }
  return null;
})();
if (debPort === null) {
  stopAll();
  SKIP('没有空闲的调试端口');
}

const profile = mkdtempSync(path.join(tmpdir(), 'mpm-edge-'));
let edge = null;
try {
  edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${debPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--hide-scrollbars',
      '--window-size=1400,860',
      `http://127.0.0.1:${PORT}/public/index.html`,
    ],
    { stdio: 'ignore' },
  );
} catch {
  stopAll();
  SKIP('Edge 起不来');
}
process.on('exit', () => {
  try {
    edge && edge.kill();
  } catch {}
});

let ver = null;
for (let i = 0; i < 40 && !ver; i++) {
  await sleep(400);
  try {
    ver = await getJSON(`http://127.0.0.1:${debPort}/json/version`);
  } catch {}
}
if (!ver) {
  stopAll();
  SKIP('Edge 调试端口没起来');
}
console.log('真浏览器：' + ver.Browser);

const list = await getJSON(`http://127.0.0.1:${debPort}/json/list`);
const page = list.find((t) => t.type === 'page');
const ws = await wsConnect(page.webSocketDebuggerUrl);
const sid = (await ws.send('Target.attachToTarget', { targetId: page.id, flatten: true })).sessionId;
await ws.send('Page.enable', {}, sid);
await ws.send('Runtime.enable', {}, sid);

const evaluate = async (expr) => {
  const r = await ws.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result && r.result.value;
};

try {
  await sleep(600);

  /* ---- 1. 点「+ 新频道」：第一个框必须是地址 ---- */
  const opened = await evaluate(`(() => { const b = document.getElementById('btnAdd'); if (!b) return 'no-btn'; b.click(); const first = document.querySelector('#modalFields .m-f'); return first && first.dataset.k; })()`);
  ok('点「+ 新频道」能开出弹窗，且第一个输入框就是 url', opened === 'url', String(opened));

  const order = await evaluate(`[...document.querySelectorAll('#modalFields .m-f')].map(e => e.dataset.k).join(',')`);
  // tvg-id 跟频道名贴一起（一个频道「叫什么」↔「对应哪个节目 ID」），分组挪到它后面
  ok('字段顺序是 url → title → tvg-id → group → tvg-logo', order === 'url,title,tvg-id,group,tvg-logo', order);

  const hasInfo = await evaluate(`!!document.getElementById('mpmStreamInfo')`);
  ok('地址下方有一行检测结论的位置', hasInfo === true);

  /* ---- 2. 真敲一条地址，等探测跑完 ---- */
  await evaluate(`(() => {
    const el = document.querySelector('#modalFields textarea[data-k="url"]');
    el.focus(); el.value = '';
    return true;
  })()`);
  // 用真实按键塞进去（触发 input 事件，走的是跟用户一样的路径）
  await ws.send('Input.insertText', { text: STREAM_URL }, sid);
  await evaluate(`document.querySelector('#modalFields textarea[data-k="url"]').dispatchEvent(new Event('input', { bubbles: true }))`);

  const before = await evaluate(`document.querySelector('#modalFields input[data-k="title"]').value`);
  ok('刚粘完地址时频道名还是空的（先去探）', before === '', JSON.stringify(before));

  // 防抖 700ms + 探测时间，留足余量
  for (let i = 0; i < 40; i++) {
    await sleep(600);
    const v = await evaluate(`document.querySelector('#modalFields input[data-k="title"]').value`);
    if (v) break;
  }
  const title = await evaluate(`document.querySelector('#modalFields input[data-k="title"]').value`);
  ok('探测完自动把流内服务名填进频道名', title === '凤凰', JSON.stringify(title));

  const info = await evaluate(`document.getElementById('mpmStreamInfo').textContent`);
  ok('状态行说明了是流内服务名', /流内服务名/.test(info), JSON.stringify(info));

  /* ---- 3. 已经填了名字时不去覆盖 ---- */
  await evaluate(`(() => { const t = document.querySelector('#modalFields input[data-k="title"]'); t.value = '我手打的名字'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await evaluate(`(() => {
    const el = document.querySelector('#modalFields textarea[data-k="url"]');
    el.value = ''; el.value = ${JSON.stringify(STREAM_URL)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  // 等第二轮探测跑完再断言：光看「不再显示『正在检测』」会在防抖刚起头时
  // 就 break（上一轮的文案还挂着），那会儿第二趟结果根本没回来。
  let info2 = '';
  for (let i = 0; i < 40; i++) {
    await sleep(600);
    info2 = await evaluate(`document.getElementById('mpmStreamInfo').textContent`);
    if (/不去覆盖/.test(info2) || /没读到/.test(info2)) break;
  }
  const title2 = await evaluate(`document.querySelector('#modalFields input[data-k="title"]').value`);
  ok('用户手打的名字没被流内服务名顶掉', title2 === '我手打的名字', JSON.stringify(title2));
  ok('状态行解释为什么没覆盖', /不去覆盖/.test(info2), JSON.stringify(info2));

  await evaluate(`document.getElementById('modalCancel').click()`);
  ok('弹窗能正常关掉', (await evaluate(`document.getElementById('modal').classList.contains('hidden')`)) === true);
} finally {
  try {
    ws.send('Browser.close', {}, sid).catch(() => {});
  } catch {}
  stopAll();
  await sleep(300);
  try {
    edge && edge.kill();
  } catch {}
}

console.log(`\n${failed ? '有失败项' : '全部通过'}（${pass} 项）`);
process.exit(failed ? 1 : 0);

/**
 * 真浏览器回归：用本机自带的 Microsoft Edge（Chromium）无头 + DevTools 协议，
 * 验「表格里的输入框能不能正常用、整行拖拽还在不在」。
 *
 * 这条测试守的就是那个线上 bug：`<tr draggable="true">` 写死在行上时，
 * 浏览器把整行连里面的 input 一起当拖影源 ——
 * 在「频道名 / 分组 / tvg-id」里按住左键拖会变成拖整行，光标定不住、文本选不中。
 * 修法是「按下那一刻才开拖动开关」，所以这里断言的是：
 *   - 从输入框起手：**不产生任何原生拖拽事件**（dragstart 等），输入框完整拿到鼠标
 *   - 从 ⠿ 把手按下再拖：**照旧能拖**，行序真的变
 *
 * ⚠️ 没做「把 tr 改回旧写法再拖一次」的对照：CDP 合成鼠标下拖拽/拖选的合成有顺序依赖
 * （页面第一次拖拽无论哪种写法都不冒 dragstart，之后又跟 draggable 对不上），
 * 拿它当断言就是个会 randomly 红的 flaky 测试。那个分支的逻辑由 test/rowdrag.mjs 在
 * DOM 桩上守着；真机上的手感以用户实测为准。
 *
 * 没装 Edge / 调试端口占不上就跳过（exit 0），不影响主测试套件。
 * 手写 CDP 客户端只用 node 内置模块，项目依旧零依赖。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
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

/* ---------------- CDP 客户端（RFC6455，纯内置模块） ---------------- */

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
for (const p of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
  if (existsSync(p)) {
    EDGE = p;
    break;
  }
}

const SKIP = (why) => {
  console.log(`  SKIP ${why}（本机没有可用的 Microsoft Edge 无头，跳过真浏览器回归）`);
  process.exit(0);
};
if (!EDGE) SKIP('找不到 msedge.exe');

/* ---------------- 起本地服务（自带一个干净端口，别跟其它测试抢） ---------------- */

const PORT = 9399;
const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const stopAll = () => {
  try {
    srv.kill();
  } catch {}
};
process.on('exit', stopAll);

let up = false;
for (let i = 0; i < 30 && !up; i++) {
  await sleep(300);
  try {
    up = (await getJSON(`http://127.0.0.1:${PORT}/json/nope`)) !== undefined;
    up = true;
  } catch {}
}
if (!up) {
  stopAll();
  SKIP('本地服务没起来');
}

/* ---------------- 起 Edge 无头 + 连 CDP ---------------- */

const debPort = await (async () => {
  for (const p of [9444, 9445, 9446]) {
    try {
      await getJSON(`http://127.0.0.1:${p}/json/version`);
    } catch {}
    const free = await new Promise((res) => {
      const sock = net.connect(p, '127.0.0.1');
      sock.on('connect', () => {
        sock.end();
        res(false); // 有人占着
      });
      sock.on('error', () => res(true)); // 连不上 = 空着
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
let ws = null;
let edge = null;
try {
  edge = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${debPort}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=1400,860', 'http://127.0.0.1:' + PORT + '/public/index.html',
  ], { stdio: 'ignore' });
  process.on('exit', () => {
    try {
      edge.kill();
    } catch {}
  });

  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(400);
    try {
      ver = await getJSON(`http://127.0.0.1:${debPort}/json/version`);
    } catch {}
  }
  if (!ver) SKIP('Edge 调试端口没起来');
  console.log('真浏览器：' + ver.Browser + '（' + path.basename(path.dirname(EDGE)) + '）');

  const list = await getJSON(`http://127.0.0.1:${debPort}/json/list`);
  const page = list.find((t) => t.type === 'page');
  ws = await wsConnect(page.webSocketDebuggerUrl);
  const sid = (await ws.send('Target.attachToTarget', { targetId: page.id, flatten: true })).sessionId;
  await ws.send('Page.enable', {}, sid);
  await ws.send('Runtime.enable', {}, sid);

  const evalJs = async (expr) => {
    const r = await ws.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error('页面里抛错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const mouse = (type, x, y) =>
    ws.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
    }, sid);

  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if (await evalJs('document.readyState === "complete" && !!document.getElementById("tbody")')) break;
  }

  /* ---------------- 正文 ---------------- */

  const M3U =
    '#EXTM3U\n' +
    '#EXTINF:-1 tvg-id="c1" tvg-name="频道一" group-title="央视",频道一号频道\nhttp://127.0.0.1/a.m3u8\n' +
    '#EXTINF:-1 tvg-id="c2" tvg-name="频道二" group-title="央视",频道二号频道\nhttp://127.0.0.1/b.m3u8\n' +
    '#EXTINF:-1 tvg-id="c3" tvg-name="频道三" group-title="地方台",频道三号频道\nhttp://127.0.0.1/c.m3u8\n';

  const rows = await evalJs(
    `(() => { const p = document.getElementById('paste'); p.value = ${JSON.stringify(M3U)};
      document.getElementById('btnPaste').click();
      return document.querySelectorAll('#tbody tr[data-id]').length; })()`,
  );
  ok('页面在真浏览器里把列表载进来了（3 行）', rows === 3, 'rows=' + rows);

  // 原生拖拽事件埋点：只要从输入框起手冒出 dragstart，就说明输入框又被当成拖影源了
  await evalJs(
    `(() => { window.__ev = [];
      for (const k of ['dragstart', 'dragend', 'drop'])
        document.addEventListener(k, () => window.__ev.push(k), true);
      return 1; })()`,
  );

  const box = await evalJs(
    `(() => { const r = document.querySelector('#tbody tr[data-id] input[data-f=title]').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
  );
  const cy = Math.round(box.y + box.h / 2);

  const reset = (draggable) =>
    evalJs(`(() => { const tr = document.querySelector('#tbody tr[data-id]');
      tr.draggable = ${draggable};
      const i = tr.querySelector('input[data-f=title]');
      i.value = '频道一号频道'; i.scrollLeft = 0; i.blur(); i.setSelectionRange(0, 0);
      window.__ev = []; return i.value.length; })()`);

  const dragAcross = async (x1, x2, y) => {
    await mouse('mousePressed', x1, y);
    for (let i = 1; i <= 8; i++) {
      await mouse('mouseMoved', Math.round(x1 + ((x2 - x1) * i) / 8), y);
      await sleep(20);
    }
    await mouse('mouseReleased', Math.round(x2), y);
    await sleep(150);
  };

  // 1) 修复后：从输入框起手横拖 —— 不该冒出任何拖拽事件
  await reset(false);
  await dragAcross(Math.round(box.x + 6), Math.round(box.x + 70), cy);
  const evFixed = await evalJs('window.__ev.join(",")');
  ok('从「频道名」输入框起手拖动 → 不触发原生拖拽（输入框完整拿到鼠标）', evFixed === '', '事件：' + evFixed);

  // 2) 单击定位：点到 x+60 → 光标落在第 4 个字符左右（6 个字，不是 0）
  await reset(false);
  await mouse('mousePressed', Math.round(box.x + 60), cy);
  await mouse('mouseReleased', Math.round(box.x + 60), cy);
  await sleep(120);
  const caret = await evalJs(`(() => { const i = document.querySelector('#tbody tr[data-id] input[data-f=title]');
    return [i.selectionStart, i.selectionEnd, i.value.length]; })()`);
  ok('单击能把光标点到指定位置（不是钉在开头）', caret[0] > 0 && caret[1] === caret[0] && caret[0] < caret[2],
    JSON.stringify(caret));

  // 3) 整行拖拽还在：按住 ⠿ 把手（按下那一刻才开拖动开关）拖到最后一行，行序要真的变
  const handle = await evalJs(`(() => {
    const hs = [...document.querySelectorAll('#tbody tr[data-id] td.handle')];
    const a = hs[0].getBoundingClientRect(), c = hs[2].getBoundingClientRect();
    return { x: Math.round(a.x + a.width / 2), y1: Math.round(a.y + a.height / 2), y2: Math.round(c.y + c.height / 2) }; })()`);
  const order = () => evalJs(`[...document.querySelectorAll('#tbody tr[data-id] input[data-f=title]')].map(i => i.value).join('|')`);
  const o0 = await order();
  await mouse('mousePressed', handle.x, handle.y1); // 必须先按住：拖动开关是在 mousedown 时开的
  for (let i = 1; i <= 10; i++) {
    await mouse('mouseMoved', handle.x, Math.round(handle.y1 + ((handle.y2 - handle.y1) * i) / 10));
    await sleep(25);
  }
  await mouse('mouseReleased', handle.x, handle.y2);
  await sleep(200);
  const o1 = await order();
  ok('从 ⠿ 把手还能把整行拖走（行序变了）', o0 !== o1, `${o0} → ${o1}`);
  ok('被拖走的就是第 1 行（拖到第 3 行之前）', o1.split('|')[1] === o0.split('|')[0], o1);

  edge.kill();
} catch (e) {
  failed++;
  console.log('  FAIL 真浏览器回归跑挂了 → ' + e.message);
  try {
    edge?.kill();
  } catch {}
} finally {
  stopAll();
}

console.log(`\n${failed === 0 ? '全部通过' : '有用例失败'}（${pass} 项，跳过另计）`);
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300);

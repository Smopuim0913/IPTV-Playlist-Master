/**
 * 「探到一半再导一份列表」—— 旧那一趟必须自己收摊。
 *
 * 起因：导入（选文件 / 拖进来 / 粘贴 / 填地址 / 从源站更新）都会整批换掉表里的频道，
 * 可当时那一趟探测还在跑，它会留下三堆烂摊子：
 *   ① 旧队列继续给已经不存在的一批 id 发请求，几百条就是几百个包白烧出去；
 *   ② 进度条停在中途不动，看着像还在跑；
 *   ③ 旧队列跑完那句「探测完成：N 条」是按**它自己那一批**算的，却会落到新表头上
 *      —— 自动勾上「失败项」、底栏计数、汇总全是错的。
 * 另外补测那几行还挂着 ⌛（停了就转不回来了），得还原成 ⟳ 或「—」。
 *
 * 这里分两段验证：
 *   上半——抠 app.js 源码 + DOM 桩，看 adopt() 是不是真的会掐掉旧探测、把面板收拾干净；
 *   下半——真起一个服务进程，SSE 探到一半 POST /api/load，看旧队列是不是真停了
 *          （假源站的命中数不再往上长），而不是只把网页那条连接关掉。
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

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

/* ================= 上半：前端 adopt / stopProbeUI ================= */

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/** 从源码里抠一段（抠不到就是测试跟着实现一起改坏了，得报出来） */
const grab = (re, what) => {
  const m = APP.match(re);
  if (!m) throw new Error(`源码里抠不出 ${what}，测试该跟着实现一起更新`);
  return m[0];
};

const SRC = [
  grab(/const RES_RETRYABLE = new Set\(\[[^\]]*\]\);/, 'RES_RETRYABLE'),
  grab(/const resCell = \(p\) => \{[\s\S]*?\n\};/, 'resCell'),
  grab(/function cancelProgressTuck\(\) \{[\s\S]*?\n\}/, 'cancelProgressTuck'),
  grab(/function closeProgressBar\(\) \{[\s\S]*?\n\}/, 'closeProgressBar'),
  grab(/function holdProgressBar\(\) \{[\s\S]*?\n\}/, 'holdProgressBar'),
  grab(/function stopProbeUI\(\) \{[\s\S]*?\n\}/, 'stopProbeUI'),
  grab(/function adopt\(doc, \{ path = null, srcName = '', encoding = 'utf-8' \} = \{\}\) \{[\s\S]*?\n\}/, 'adopt'),
].join('\n\n');

/** 带 {占位} 的翻译函数桩：只负责把占位符换掉，别去校验语言 */
const ident = (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => String((o && o[k]) ?? ''));

/**
 * 攒一套 DOM 桩 + 一个可以自己摆布的 state。
 * resCell 是 stopProbeUI 还原 ⌛ 单元格时要用的，所以一起抠进来。
 */
function build({ cells }) {
  const calls = { closed: 0, toast: [], warn: [], render: 0, groups: 0, cleared: [] };
  const mk = () => {
    const s = new Set();
    return {
      _s: s,
      classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)) },
      style: { width: '' },
      textContent: '',
    };
  };
  const els = { '#progress': mk(), '#bar': mk(), '#progressTxt': mk(), '#srcLabel': mk(), '#pathInput': mk() };
  // 其余选择器（#empty / #tableWrap / #btnSave …）按需现造一个，别去 null 上读 classList
  const cache = new Map();
  const $ = (sel) => (els[sel] || (cache.has(sel) ? cache.get(sel) : (cache.set(sel, mk()), cache.get(sel))));
  const state = {
    doc: null,
    entries: [],
    path: null,
    srcName: '',
    encoding: 'utf-8',
    selected: new Set(),
    brokenLogos: new Set(),
  };
  const tds = cells.map((c) => ({
    innerHTML: c.html,
    dataset: {},
    classList: { contains: (k) => c.busy && k === 'resbusy' },
    closest: () => ({ dataset: { id: c.id } }),
  }));
  const document = { querySelectorAll: () => tds };
  const warn = (m) => calls.warn.push(m);
  const toast = (m) => calls.toast.push(m);
  const refreshGroupOptions = () => calls.groups++;
  const render = () => calls.render++;

  const api = new Function(
    'state',
    't',
    'esc',
    '$',
    'document',
    'warn',
    'toast',
    'refreshGroupOptions',
    'render',
    // 待收起那条定时器在前端是全局 setTimeout/clearTimeout 管的，参数得照样传进来，
    // 不然后面那几个实参会被悄悄丢掉（形参不收，多传的也不认）
    'clearTimeout',
    `${SRC}
let activeEs = null;
return {
  adopt, stopProbeUI, resCell, cancelProgressTuck, closeProgressBar, holdProgressBar,
  setEs: (e) => { activeEs = e; },
  es: () => activeEs,
};`,
  )(
    state,
    ident,
    (s) => String(s),
    $,
    document,
    warn,
    toast,
    refreshGroupOptions,
    render,
    // 待收起那条定时器在前端是全局 setTimeout/clearTimeout 管的，
    // 这里换成计数桩，好在下面断言「stopProbeUI 真把它掐了」
    (id) => calls.cleared.push(id),
  );

  return { ...api, state, calls, els, tds };
}

const newDoc = () => ({ header: null, entries: [{ id: 'z1', title: '新表' }], comments: [] });
const busyCell = '<span class="res low resbusy" title="正在用更大的窗口重挖…">⌛</span>';
/** 没结果的格子长什么样（与 resCell(null) 一致） */
const dashCell = '<span class="res low">—</span>';

/* ---------------- A. 探到一半导入新列表 ---------------- */
{
  const h = build({
    es: { close: () => h.calls.closed++ },
    cells: [
      // 有结果的：停了就还原成它自己那个分辨率，别抹掉已有结论
      { id: 'a', busy: true, html: busyCell },
      // 没结果的：停了就退回「—」（⟳ 只在 long-gop/seg-fail 上也有，这里没有 probe 就是纯 —）
      { id: 'b', busy: true, html: busyCell },
      // 没在转的：别去动它
      { id: 'c', busy: false, html: dashCell },
    ],
  });
  h.state.entries = [
    { id: 'a', probe: { ok: true, format: '1920x1080 (1080p)' } },
    { id: 'b', probe: null },
    { id: 'c', probe: null },
  ];
  // 模拟「探测跑到一半」：有一条 SSE 挂着，界面上的进度条停在中途
  h.setEs({
    close: () => h.calls.closed++,
  });
  h.els['#progress'].classList.remove('hidden');
  h.els['#bar'].style.width = '47%';
  h.els['#progressTxt'].textContent = '已测 12 / 25';

  h.adopt(newDoc());

  ok('导入时掐掉了旧探测（SSE 被 close）', h.calls.closed === 1, `closed=${h.calls.closed}`);
  ok('掐完不再持有旧连接', h.es() === null);
  ok('进度面板整个收起来', h.els['#progress'].classList.contains('hidden'));
  ok('进度条归零', h.els['#bar'].style.width === '0%', h.els['#bar'].style.width);
  ok('进度文字清空', h.els['#progressTxt'].textContent === '');
  ok('只吭一声「上一趟已停止」', h.calls.toast.length === 1 && /停止/.test(h.calls.toast[0]), JSON.stringify(h.calls.toast));
  ok('转圈的还原成已有分辨率', /1920x1080/.test(h.tds[0].innerHTML), h.tds[0].innerHTML);
  ok('转圈的没结果就退回 —', /class="res low"[^>]*>—</.test(h.tds[1].innerHTML), h.tds[1].innerHTML);
  ok('没在转的那格原样不动', h.tds[2].innerHTML === dashCell, h.tds[2].innerHTML);
  ok('新表照旧被挂上（render 跑过）', h.calls.render === 1 && h.state.entries.length === 1);
}

/* ---------------- B. 没在跑探测时导入：别添乱 ---------------- */
{
  const h = build({ cells: [] });
  h.state.entries = [{ id: 'a', probe: null }];
  h.els['#progressTxt'].textContent = '（没人动过）';
  h.adopt(newDoc());
  ok('没在跑就不去关连接', h.calls.closed === 0);
  ok('没在跑就不弹「已停止」', h.calls.toast.length === 0, JSON.stringify(h.calls.toast));
  ok('没在跑就不动进度面板', !h.els['#progress'].classList.contains('hidden'));
  ok('没在跑就不动进度文字', h.els['#progressTxt'].textContent === '（没人动过）');
}

/* ---------------- C. 三个入口都汇到 stopProbeUI ---------------- */
{
  ok('新的一趟探测开头先收干净', /\n\s*stopProbeUI\(\);/.test(grab(/function probe\(ids, opts = \{\}\) \{[\s\S]*?\n\}\n/, 'probe')));
  const stopBtn = grab(/\$\('#btnStopProbe'\)\.addEventListener\('click'[^\n]*\n?.*/, 'btnStopProbe');
  ok('停止按钮走的是同一套收拾', /stopProbeUI/.test(stopBtn), stopBtn);
}

/* ---------------- C2. 进度条待收起的定时器，别落到下一趟头上 ---------------- */
{
  const h = build({ cells: [] });
  h.state.entries = [{ id: 'a', probe: null }];
  // 模拟「上一趟刚跑完，正排着 1.4 秒后收起面板」这一瞬
  h.els['#progress'].classList.remove('hidden');
  h.els['#progress'].classList.add('tucked');
  h.els['#progress']._hideTimer = 'fake-timer';
  h.calls.cleared.length = 0;
  h.stopProbeUI();

  ok('待收起的定时器被掐掉', h.calls.cleared.includes('fake-timer'), JSON.stringify(h.calls.cleared));
  ok('掐了就把淡出标记抹平', !h.els['#progress']._s.has('tucked') && h.els['#progress']._hideTimer === null);
  // 关键：面板正在显示着（下一趟探测刚把它拉起来），stopProbeUI 不能顺手把它藏了
  ok('没在跑就别去藏面板', !h.els['#progress']._s.has('hidden'), [...h.els['#progress']._s].join(','));
}

/* ---------------- C3. 进度条待在滚动容器外（滚列表不能把它滚没） ---------------- */
{
  const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const CSS = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const at = (s, re) => s.search(re);
  // <main class="wrap"> 才是那个 overflow:auto 的滚动容器，进度条必须在它之前
  ok(
    '进度条长在滚动容器外面',
    at(HTML, /<div id="progress"/) > -1 && at(HTML, /<div id="progress"/) < at(HTML, /<main id="wrap"/),
    `progress@${at(HTML, /<div id="progress"/)} main@${at(HTML, /<main id="wrap"/)}`,
  );
  ok('进度条就在常驻工具栏下方', at(HTML, /<section class="toolbar"/) < at(HTML, /<div id="progress"/));
  ok('CSS 里它是 flex:none，别被 main 压扁', /\.progress\{[^}]*flex:none/.test(CSS), (CSS.match(/\.progress\{[^}]*\}/) || [''])[0]);
  const probeSrc = grab(/function probe\(ids, opts = \{\}\) \{[\s\S]*?\n\}\n/, 'probe');
  ok('跑完是「留一下再收起」不是瞬间消失', /holdProgressBar\(\)/.test(probeSrc) && !/box\.classList\.add\('hidden'\);\s*\n\s*\n\s*\/\/ 探测失败的自动选中/.test(probeSrc));
  ok('进度条跑满一档再淡出', /bar\.style\.width = '100%';\s*\n\s*holdProgressBar\(\)/.test(probeSrc));
  ok('连接断了就直接收起，不淡等', /closeProgressBar\(\);/.test(probeSrc));
}

/* ================= 下半：服务端换列表要掐掉旧队列 ================= */

console.log('换列表掐断旧探测');

{
  const NODE = process.execPath;
  const fakeHome = os.tmpdir();
  const child = spawn(NODE, [path.resolve('src/server.js')], {
    env: { ...process.env, PORT: '0', USERPROFILE: fakeHome, HOME: fakeHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dead = false;
  child.on('exit', () => (dead = true));
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (/Error/.test(s)) console.log('    [server]', s.trim().slice(0, 200));
  });

  // 端口让系统给（listen(0)），从服务自己打印的启动横幅上读回来
  let port = 0;
  child.stdout.on('data', (d) => {
    const m = /localhost:(\d+)/.exec(String(d));
    if (m) port = Number(m[1]);
  });
  for (let i = 0; i < 60 && !port; i++) await sleep(150);
  const base = `http://127.0.0.1:${port}`;
  ok('服务进程起来了', !!port && !dead);

  // 假源站：每次命中都数一笔，并慢一点（150ms）好让我们在队列跑到一半时插手
  let hits = 0;
  const origin = http.createServer(async (q, r) => {
    hits++;
    await sleep(150);
    r.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': '188' });
    r.end(Buffer.alloc(188, 7));
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originBase = `http://127.0.0.1:${origin.address().port}`;

  try {
    const N = 12;
    const entries = Array.from({ length: N }, (_, i) => ({ id: `old${i}`, url: `${originBase}/c${i}.ts` }));
    const res = await fetch(`${base}/api/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: null, name: 'old', entries }),
    });
    ok('登记旧列表成功', res.ok);

    // 起 SSE 探测（并发 1，慢慢跑）
    const ac = new AbortController();
    const sse = await fetch(`${base}/api/probe?concurrency=1&timeout=3000`, { signal: ac.signal });
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const msg = [];
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const l of lines) {
            if (l.startsWith('data: ')) {
              const m = JSON.parse(l.slice(6));
              msg.push(m);
              if (m.type === 'done') return;
            }
          }
        }
      } catch {
        /* 连接被掐断 / abort 都算走到这里 */
      }
    })();

    await sleep(700); // 让队列真的跑起来
    const hitsMid = hits;
    const resultsMid = msg.filter((m) => m.type === 'result').length;
    ok('旧队列确实在跑（有结果回来）', resultsMid >= 1 && hitsMid >= 1, `hits=${hitsMid} results=${resultsMid}`);

    // 就在半路上「导一份新列表」
    const r2 = await fetch(`${base}/api/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: null, name: 'new', entries: [{ id: 'new0', url: `${originBase}/n0.ts` }] }),
    });
    ok('换列表（/api/load）成功', r2.ok);

    // 旧队列收到 done（cancelled=true）才算真叫停；超时就说明它还在那儿跑
    const gotDone = await Promise.race([
      pump.then(() => msg.some((m) => m.type === 'done')),
      sleep(2500).then(() => false),
    ]);
    const doneMsg = msg.find((m) => m.type === 'done');
    ok('旧队列收到 done 并带 cancelled', gotDone && !!doneMsg && doneMsg.cancelled === true, JSON.stringify(doneMsg || {}));

    await sleep(400);
    const h1 = hits;
    await sleep(400);
    ok('换了列表之后旧队列不再发请求', hits === h1, `换表后仍在打源站：${h1} → ${hits}`);

    ac.abort();
    origin.close();
    child.kill();
  } catch (e) {
    ok('服务端换列表掐断旧探测（异常）', false, String(e && e.message));
    ac.abort();
    try {
      origin.close();
    } catch {}
    child.kill();
  }
}

console.log(failed ? `\n${failed} 项失败（通过 ${pass}）\n` : `\n全部通过（${pass} 项）\n`);
process.exit(failed ? 1 : 0);

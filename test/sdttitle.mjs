/**
 * 「添加新频道」的即时检测：把流地址挪到第一个输入框，填完停手就去探一次，
 * 读到流内 SDT 服务名就顺手当频道名；探测结果里那个服务名只当**参考信息**挂着。
 *
 * 为什么服务名只能「参考」不能「当宝用」：它长短差得太远 —— 实测见过 dftvHD
 * 这种 6 个字符的短名，也见过「Phoenix Satellite Television Co Ltd … Channel .z0」
 * 一整句 43 字符的英文描述。所以：
 *   - 探测表里只挂 tooltip 当参考，原样显示不清洗；
 *   - 「添加新频道」那一步主动帮你填，但你打过字的（或已有频道名）绝不被覆盖，
 *     填进去之后照样能随手改。
 *
 * 跑真的 server.js 进程（不是 re-export 一遍），因为要验的核心是
 * /api/probe-url **不依赖列表状态** —— 之前新增频道时列表往往还没载入。
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSps } from './lib/sps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

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

/* ---------------- 1. 真 server + 假源站 ---------------- */

const pidHi = (pid) => 0xe0 | ((pid >> 8) & 0x1f);
const pkt = (pid, pusi, payload) => {
  const p = Buffer.alloc(188);
  p[0] = 0x47;
  p[1] = ((pid >> 8) & 0x1f) | (pusi ? 0x40 : 0);
  p[2] = pid & 0xff;
  p[3] = 0x10; // payload only
  payload.copy(p, 4);
  return p;
};
const psiPkt = (pid, section) => pkt(pid, true, Buffer.concat([Buffer.from([0x00]), section]));

function pesOf(spsNal) {
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0]), spsNal]);
  const header = Buffer.from([0x80, 0xc0, 0x00]);
  const len = header.length + payload.length;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xe0, (len >> 8) & 0xff, len & 0xff]), header, payload]);
}

const VIDEO_PID = 0x0101;
const PMT_PID = 0x0100;
const SDT_PID = 0x0011;

function patSection(pmtPid = PMT_PID) {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(pmtPid), pmtPid & 0xff]),
  ]);
  return Buffer.concat([Buffer.from([0x00, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
}
function pmtSection() {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]),
    Buffer.from([pidHi(0), 0x00]),
    Buffer.from([0x00, 0x00]), // program_info_length = 0
    Buffer.from([0x1b, pidHi(VIDEO_PID), VIDEO_PID & 0xff, 0x00, 0x00]),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0xb0, 0x00 + body.length + 4]), body, Buffer.alloc(4)]);
}
function sdtSection(name) {
  const nm = Buffer.from(name, 'utf8');
  const body = Buffer.concat([Buffer.from([0x01, 0x00, nm.length]), nm]); // service_type + provider_len=0 + name
  const desc = Buffer.concat([Buffer.from([0x48, body.length]), body]);
  const service = Buffer.concat([
    Buffer.from([0x00, 0x01]), // service_id
    Buffer.from([0x00, desc.length]), // descriptor_loop_length
    desc,
  ]);
  // SDT 的头是 11 字节（比 PAT/PMT 多 original_network_id 那三个），service 从 +12 起
  const rest = Buffer.concat([
    Buffer.from([0x00, 0x01]), // transport_stream_id
    Buffer.from([0xc0, 0x00]), // version / section_number
    Buffer.from([0x00]), // last_section_number
    Buffer.from([0x00, 0x01]), // original_network_id
    Buffer.from([0xff]), // segment_last_section_number
    Buffer.from([0x00]), // segment_last_sub_section_number
    service,
  ]);
  return Buffer.concat([Buffer.from([0x42, 0xb0, rest.length + 4]), rest, Buffer.alloc(4)]);
}

/** 一段真能跑通的 TS：PAT + PMT + SDT（服务名）+ 一个带 SPS 的视频 PES */
function tsWithSdt(name) {
  return Buffer.concat([
    psiPkt(0x0000, patSection()),
    psiPkt(PMT_PID, pmtSection()),
    psiPkt(SDT_PID, sdtSection(name)),
    pkt(VIDEO_PID, true, pesOf(makeSps({ width: 1920, height: 1088 }))),
  ]);
}

const SEG = tsWithSdt('dftvHD');
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:6.000,',
  'seg.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

/** 假源站：数一数被打了几下（顺手验探测缓存有没有生效） */
const origin = http.createServer((req, res) => {
  origin.hits++;
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
origin.hits = 0;

await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${origin.address().port}`;

/* ---- 起真 server（PORT=0 动态端口，server.js 启动时会把真实端口打出来） ---- */
const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let BASE = '';
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server 起来太慢')), 15000);
  proc.stdout.on('data', (d) => {
    const m = /localhost:(\d+)/.exec(d.toString());
    if (m) {
      BASE = `http://127.0.0.1:${m[1]}`;
      clearTimeout(t);
      resolve();
    }
  });
});

const get = async (u) => {
  const r = await fetch(BASE + u);
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
};

console.log('/api/probe-url：不依赖列表状态的单地址探测');

// 前置条件：这一步故意不调 /api/load，列表状态是空的
{
  const r = await fetch(BASE + '/api/state');
  ok('前置：列表确实还没载入', r.status === 404, `status=${r.status}`);
}

{
  const { status, j } = await get(
    `/api/probe-url?url=${encodeURIComponent(`${ORIGIN}/live.m3u8`)}&timeout=5000`,
  );
  ok('没载入列表时也能探测（这就是单开一个接口的原因）', status === 200, `status=${status}`);
  ok('读得到分辨率 1920x1080', j && j.width === 1920 && j.height === 1088, `${j && j.width}x${j && j.height}`);
  ok('读得到流内服务名 dftvHD', j && j.serviceName === 'dftvHD', JSON.stringify(j && j.serviceName));
  ok('note 里也带了服务名（参考信息）', j && /SDT 服务名/.test(j.note || ''), JSON.stringify(j && j.note));
}

{
  // 缓存：同一条地址再探一次不该再打源站（探测要往深挖 2MB，重复挖很浪费）
  const before = origin.hits;
  const { j: j1 } = await get(`/api/probe-url?url=${encodeURIComponent(`${ORIGIN}/live.m3u8`)}`);
  const after = origin.hits;
  const { j: j2 } = await get(`/api/probe-url?url=${encodeURIComponent(`${ORIGIN}/live.m3u8`)}`);
  ok('同一条地址第二次命中缓存，源站请求数不变', after === before, `before=${before} after=${after}`);
  ok('缓存回来的结果还是同一份（服务名没丢）', j1.serviceName === j2.serviceName, j2.serviceName);
}

{
  // 直连 TS（不走清单）也要能读到服务名 —— 新增频道时粘的未必是清单
  const { j } = await get(`/api/probe-url?url=${encodeURIComponent(`${ORIGIN}/seg.ts`)}&timeout=5000`);
  ok('直连 TS 分片也能读到流内服务名', j && j.serviceName === 'dftvHD', JSON.stringify(j && j.serviceName));
}

{
  const a = await get('/api/probe-url');
  ok('缺 url 参数 → 400', a.status === 400, `status=${a.status}`);
  const b = await get('/api/probe-url?url=notaurl');
  ok('不给协议 → 400', b.status === 400, `status=${b.status}`);
  const c = await get(`/api/probe-url?url=${encodeURIComponent('file:///C:/x.m3u8')}`);
  ok('file:// 被挡住 → 400', c.status === 400, `status=${c.status}`);
}

{
  // 找不到源：探测自己会失败，但接口仍然回 200（前端要的是「读不到」这个结论，不是报错）
  const { status, j } = await get(`/api/probe-url?url=${encodeURIComponent(`${ORIGIN}/missing.m3u8`)}`);
  ok('探测失败时接口照旧 200（前端自己判 ok / serviceName）', status === 200, `status=${status}`);
  ok('失败时给的是 ok=false + 错误码', j && j.ok === false && !!j.code, JSON.stringify(j && j.code));
}

origin.close();
proc.kill();

/* ---------------- 2. 前端判定：suggestTitle ---------------- */

const APP = (await import('node:fs')).readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/** 按花括号配对抠出一段函数体（字符串里的花括号靠配对抵消） */
function grabFn(head) {
  const i = APP.indexOf(head);
  if (i < 0) throw new Error('源码里没找到: ' + head);
  let depth = 0;
  for (let j = APP.indexOf('{', i); j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') {
      if (--depth === 0) return APP.slice(i, j + 1);
    }
  }
  throw new Error('花括号没配对: ' + head);
}
const escSrc = APP.match(/const esc = [\s\S]*?\);/)[0];

/**
 * 按花括号配对抠出一段函数（从 head 起，head 里不许带花括号 ——
 * 带花括号的话上面那个 indexOf('{') 会从 head 自己的 `{` 起算，抠出来的是半截）。
 */
function grabFnFrom(head) {
  const i = APP.indexOf(head);
  if (i < 0) throw new Error('源码里没找到: ' + head);
  // 参数列表末尾才可能是「函数体的那个 {」：从函数签名收尾的 ') {' 起算，
  // 不然会先撞上参数默认值里的 `{`（openEntryModal 的 opts = {}），抠出个半截
  const body = APP.indexOf(') {', i);
  if (body < 0) throw new Error('没找到函数签名: ' + head);
  let depth = 0;
  for (let j = body + 2; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') {
      if (--depth === 0) return APP.slice(i, j + 1);
    }
  }
  throw new Error('花括号没配对: ' + head);
}

console.log('建议频道名：suggestTitle');
{
  const fn = new Function(
    't',
    `${escSrc}\n${grabFn('function suggestTitle(probe, curTitle) {')}\nreturn suggestTitle;`,
  )((s) => s);

  const probe = { ok: true, serviceName: 'dftvHD' };
  ok('探测成功 + 频道名空 → 用流内服务名', (() => {
    const r = fn(probe, '');
    return r.reason === 'sdt' && r.name === 'dftvHD';
  })(), JSON.stringify(fn(probe, '')));

  ok('频道名已经填过 → 一个字都不动（返回 filled）', (() => {
    const r = fn(probe, '我自己的名字');
    return r.reason === 'filled' && r.name === '';
  })(), JSON.stringify(fn(probe, '我自己的名字')));

  ok('没读到服务名（或压根没探测）→ 空', fn({ ok: true, serviceName: '' }, '').reason === 'none');
  ok('连探测都失败的 → 空（失败的流不代表它没服务名）', fn({ ok: false, serviceName: 'dftvHD' }, '').reason === 'none');

  ok('probe 本身是 null / undefined 也不炸', fn(null, '') .reason === 'none' && fn(undefined, '').reason === 'none');
  ok('名字两头带空白会 trim 掉', fn({ ok: true, serviceName: '  凤凰卫视  ' }, '').name === '凤凰卫视');
  ok('服务名是一整句英文描述时原样给，不截断', (() => {
    const long = 'Phoenix Satellite Television Co Ltd HD Phx Chinese Channel .z0';
    return fn({ ok: true, serviceName: long }, '').name === long;
  })());
}

/* ---------------- 3. 前端：watchStreamUrl 的实时检测 ---------------- */

console.log('新增频道弹窗：地址框的实时检测');
{
  const urlEl = { value: '', addEventListener(t, f) { this._h = f; } };
  // title 框也得能挂事件：体检报告的「频道名预览」是随它实时刷新的
  const titleEl = { value: '', addEventListener() {} };
  const box = { innerHTML: '' };
  const calls = [];

  const $ = (sel) => {
    if (sel.includes('data-k="url"')) return urlEl;
    if (sel.includes('data-k="title"')) return titleEl;
    return { focus() {}, classList: { remove() {}, add() {} } };
  };
  const document = { getElementById: (id) => (id === 'mpmStreamInfo' ? box : null) };
  let pending = null; // 被「防抖」压住的那次探测等一下就会跑
  const setTimeout = (fn) => {
    pending = fn;
    return 1;
  };
  const clearTimeout = () => {
    pending = null;
  };
  const fetchStub = async (u) => {
    calls.push(u);
    return { json: async () => ({ ok: true, serviceName: 'dftvHD' }) };
  };

  const fn = new Function(
    't',
    '$',
    'document',
    'setTimeout',
    'clearTimeout',
    'fetch',
    'stateCell',
    'explainNoRes',
    `${escSrc}\n${grabFn('function suggestTitle(probe, curTitle) {')}\n${grabFn('function watchStreamUrl() {')}\nreturn watchStreamUrl;`,
  )(
    (s) => s,
    $,
    document,
    setTimeout,
    clearTimeout,
    fetchStub,
    // 体检报告会调表格那两个渲染函数（状态药丸、没分辨率的原因），
    // 这里只关心「服务名有没有自动填进频道名」，给等价桩就够，
    // 它们各自的真身另有测试（表格渲染、test/noresreason.mjs）
    (p) => `<span class="pill ${p && p.ok ? 'ok' : 'bad'}">${p && p.ok ? '200 在线' : '失败'}</span>`,
    () => '这条没读到分辨率',
  );

  // 打开「添加新频道」：地址是空的 → 不该发请求
  urlEl.value = '';
  fn();
  await new Promise((r) => setImmediate(r));
  ok('地址还空着时不发探测请求', calls.length === 0 && box.innerHTML === '');

  // 粘一个地址进去（模拟 input 事件）：防抖压着，先不该发
  urlEl.value = 'http://example.com/live/index.m3u8';
  urlEl._h('input');
  ok('刚打完字不立刻发，先压着（一次探测要往下挖 2MB）', calls.length === 0);

  // 停手 700ms 到了：先同步看一眼「正在检测」那一行，再等它跑完
  const running = pending();
  ok('探测中先把状态行写出来（别让人觉得点了没反应）', /si-wait/.test(box.innerHTML), box.innerHTML);
  await running;
  await new Promise((r) => setImmediate(r));
  ok('停手之后才发请求', calls.length === 1 && /encodeURIComponent|%2F|index\.m3u8/.test(calls[0]), calls[0]);
  ok('读到服务名后自动填进频道名', titleEl.value === 'dftvHD', JSON.stringify(titleEl.value));
  ok('状态行说明是填进去了（还能自己改）', /已填入频道名/.test(box.innerHTML) && /si-ok/.test(box.innerHTML), box.innerHTML);

  // 已经有名字：不覆盖，只提示
  titleEl.value = '我手打的名字';
  box.innerHTML = '';
  await pending();
  await new Promise((r) => setImmediate(r));
  ok('频道名已经填过 → 不去覆盖', titleEl.value === '我手打的名字', JSON.stringify(titleEl.value));
  ok('此时状态行说明为什么没覆盖', /不去覆盖/.test(box.innerHTML), box.innerHTML);

  // 换地址：上一轮自动填的名字先撤掉，让新一轮重新填
  titleEl.value = 'dftvHD';
  urlEl.value = 'http://example.com/other/2.m3u8';
  urlEl._h('input');
  ok('换地址后先撤掉上一轮自动填的名字', titleEl.value === '', JSON.stringify(titleEl.value));
  await pending();
  await new Promise((r) => setImmediate(r));
  ok('新地址探测完重新填上（服务名一样就还是它）', titleEl.value === 'dftvHD', JSON.stringify(titleEl.value));
  ok('换了地址后确实又发了一次请求', calls.length === 3, `calls=${calls.length}`);

  // 地址不像 http(s)：不发请求
  const n = calls.length;
  urlEl.value = 'file:///C:/x.m3u8';
  urlEl._h('input');
  await new Promise((r) => setImmediate(r));
  ok('file:// 之类根本不发请求', calls.length === n, `calls=${calls.length}`);
  ok('状态行也清干净了', box.innerHTML === '', box.innerHTML);
}

/* ---------------- 4. 弹窗字段顺序 ---------------- */

console.log('新增频道弹窗：字段顺序');
{
  let captured = null;
  const $ = () => ({ focus() {}, classList: { remove() {}, add() {} } });
  const openModal = (title, fields) => {
    captured = { title, fields };
  };
  const state = { group: '' };
  let watchHits = 0; // 记录检测有没有被自动启动
  const fn = new Function(
    't',
    '$',
    'state',
    'openModal',
    'watchStreamUrl',
    'nameOf',
    'grpOf',
    'idOf',
    'logoOf',
    'groupChoices',
    `${escSrc}\n${grabFnFrom('function openEntryModal')}\nreturn openEntryModal;`,
  )(
    (s) => s,
    $,
    state,
    openModal,
    () => {
      watchHits++;
    },
    (e) => e.title || '',
    (e) => e.attrMap['group-title'] || '',
    (e) => e.attrMap['tvg-id'] || '',
    (e) => e.attrMap['tvg-logo'] || '',
    () => [],
  );

  fn(null);
  const keys = captured.fields.map((f) => f.key).filter(Boolean);
  ok('第一个框就是「播放地址」', keys[0] === 'url', keys.join(' > '));
  ok('「频道显示名」紧跟在地址后面', keys[1] === 'title', keys.join(' > '));
  // tvg-id 贴着频道名走（「叫什么」↔「哪个节目 ID」），分组挪到它后面，跟表头/行内一致
  ok('剩下几个顺序是 tvg-id → 分组 → LOGO', keys.join(',') === 'url,title,tvg-id,group,tvg-logo', keys.join(','));
  ok('url 之前没有别的输入项', !keys.slice(0, keys.indexOf('url')).length);

  const f = captured.fields;
  ok('地址后面紧跟一行检测结论（mpmStreamInfo）', f[1].type === 'html' && f[1].html.includes('mpmStreamInfo'));
  ok('新增时自动启动检测', watchHits === 1, `watchHits=${watchHits}`);

  // 编辑态：字段照旧完整，但没人去自动探（已有名字不该被流里的字串顶掉）
  captured = null;
  watchHits = 0;
  fn({ title: 'CCTV-1', attrs: [], attrMap: { 'group-title': '央视', 'tvg-id': 'c1' }, url: 'http://x/1.m3u8' });
  ok('编辑已有频道时不启动检测', watchHits === 0, `watchHits=${watchHits}`);
  ok('编辑态拿到的字段也是同一套顺序', captured.fields.map((x) => x.key).filter(Boolean).join(',') === 'url,title,tvg-id,group,tvg-logo');
}

console.log(`\n${failed ? '有失败项' : '全部通过'}（${pass} 项）`);
process.exit(failed ? 1 : 0);

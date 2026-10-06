/**
 * 导出链路验证：真实走一遍浏览器的数据流，再看 /api/export 吐出来的字节。
 *
 * 只盯一件事：**厂商给的私有属性不能因为「界面上没这一列」就消失。**
 * 表格里摆出来的只有 频道名 / 分组 / LOGO / tvg-id / 地址，
 * response-time、catchup、catchup-source、timeshift 这些都是界面上看不见的，
 * 历史上正是最先被各类 m3u 编辑器丢掉的那批。
 *
 * 流程（和 public/app.js 一模一样）：
 *   POST /api/read 拿 base64 -> 前端 decodeBuffer -> parseM3U
 *   -> 编辑（改名/改组/删行/拖拽/补 LOGO/洗后缀/从源站更新）
 *   -> serializeM3U -> POST /api/export -> 逐字节比对
 *
 * 运行：PORT=9221 node test/export.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseM3U, serializeM3U, decodeBuffer, detectEncoding, isM3U8Name, stripBom } from '../src/m3u.js';
import { mergePlaylist } from '../src/merge.js';
import { stripAllSuffix } from '../src/suffix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 9221;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + extra}`);
  if (!cond) failed++;
};

/* ---------------- 夹具：把界面上看不见的私有属性尽量写全 ---------------- */
// 覆盖四种写法：双引号、单引号、无引号、以及 response-time={18}ms 这种私有裸写法
const RICH = [
  '#EXTM3U',
  '#KODIPROP:inputstream.adaptive.license_type=clearkey',
  '#EXTINF:-1 tvg-id="cctv1.ftv" tvg-name="CCTV-1" tvg-logo="https://logo/1.png" group-title="央视",CCTV-1 综合 1080p',
  'http://1/index.m3u8',
  '#EXTINF:-1 tvg-id="cctv5.ftv" tvg-name="CCTV-5" group-title="央视" response-time="31" catchup="fmp4" catchup-source="cctv5" timeshift=-1,CCTV-5 体育',
  'http://5/index.m3u8',
  '#EXTINF:-1 tvg-id="cctv9.ftv" group-title="央视" response-time={18}ms catchup="dash" catchup-source="id9" timeshift=0,CCTV-9 纪录',
  'http://9/index.m3u8',
  "#EXTINF:-1 tvg-id='hunan.ftv' tvg-name='湖南卫视' group-title='卫视频道' catchup='fmp4' catchup-source='hunan' timeshift=30,湖南卫视",
  'http://hunan/index.m3u8',
  '#EXTINF:-1 tvg-id=bbc tvg-name="BBC News" group-title="外频" response-time=42 catchup=fmp4,BBC News',
  'http://bbc/index.m3u8',
  '#EXTINF:-1 tvg-name="无属性频道" group-title="未分组",无属性频道',
  'http://plain/index.ts',
  '#EXTM3U-TAIL:keep-me',
  '',
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpm-export-'));
const richFile = path.join(tmp, 'rich.m3u');
fs.writeFileSync(richFile, RICH, 'utf8');
// CRLF + BOM 版本：走一遍「读进来再导出去」，行尾和 BOM 都得留着
const crlfFile = path.join(tmp, 'crlf.m3u');
fs.writeFileSync(crlfFile, '﻿#EXTM3U\r\n#EXTINF:-1 group-title="央视" catchup="fmp4" catchup-source="a",A\r\nhttp://a/1.m3u8\r\n', 'utf8');

/* ---------------- 起一个真服务（不带列表也能用 /api/read + /api/export） ---------------- */
const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const waitServer = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
const shutServer = () => {
  try {
    proc.kill();
  } catch {}
};

/** 复刻浏览器：读文件 -> base64 -> 字节 -> 解码 -> 解析 */
async function loadFile(file) {
  const r = await fetch(BASE + '/api/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  const s = Buffer.from(j.b64, 'base64').toString('binary');
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  const text = decodeBuffer(bytes);
  return { text, encoding: detectEncoding(bytes), doc: parseM3U(text) };
}

/** 复刻浏览器「导出」按钮：serialize -> /api/export，返回服务端吐出来的原始字节 */
async function exportViaHttp(text, name = 'playlist.m3u') {
  const r = await fetch(BASE + '/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, name }),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, text: buf.toString('utf8'), buf };
}

/** 抽出每条频道上「界面上看不见」的那些属性，按 值 拼串，便于逐条对比 */
function invisibles(entries) {
  const KEYS = ['response-time', 'catchup', 'catchup-source', 'timeshift'];
  return Object.fromEntries(
    entries
      .filter((e) => e.url)
      .map((e) => [
        e.url,
        e.attrs
          .filter((a) => KEYS.includes(a.key))
          .map((a) => `${a.key}=${a.value}`)
          .join('|'),
      ]),
  );
}

try {
  if (!(await waitServer())) throw new Error('服务没起来');

  /* ================= 1) 导入 -> 编辑 -> 导出 ================= */
  console.log('\n— 导入 / 编辑 / 导出 全链路 —');
  const { text: srcText, doc } = await loadFile(richFile);
  ok('识别为 utf-8', detectEncoding(Buffer.from(srcText, 'utf8')) === 'utf-8');
  ok('解析出 6 条频道', doc.entries.length === 6, String(doc.entries.length));

  const entries = doc.entries;
  const before = invisibles(entries);

  // 编辑：改名（顺手把手写分辨率后缀洗掉）、改分组、删一条、把首条拖到末尾、补 LOGO
  entries[0].title = stripAllSuffix(entries[0].title);
  entries[0].attrMap['group-title'] = '央视频道';
  entries.splice(5, 1); // 删掉「无属性频道」
  const first = entries.splice(0, 1)[0];
  entries.push(first);
  const cctv9 = entries.find((e) => e.attrMap['tvg-id'] === 'cctv9.ftv');
  cctv9.attrMap['tvg-logo'] = 'https://logo/9.png';

  const out = await exportViaHttp(serializeM3U({ ...doc, entries }), '我的列表 01.m3u');
  ok('导出请求 200', out.status === 200, String(out.status));
  const cd = out.headers.get('content-disposition') || '';
  ok('Content-Disposition 带文件名（含中文的 RFC5987 写法）', cd.includes("filename*=UTF-8''") && decodeURIComponent(cd.split("filename*=UTF-8''")[1] || '') === '我的列表 01.m3u', cd);

  // 界面上看不见的私有属性：一条都不能少
  const after = invisibles(parseM3U(out.text).entries);
  const lost = Object.entries(after).filter(([url, v]) => before[url] !== v);
  ok('私有属性一条不漏（response-time/catchup/catchup-source/timeshift）', lost.length === 0, JSON.stringify(lost));
  ok('导出的 response-time 双引号写法还在', out.text.includes('response-time="31"'));
  ok('导出的 response-time 私有裸写法还在', out.text.includes('response-time={18}ms'));
  ok('导出的 timeshift 无引号还在', out.text.includes('timeshift=-1') && out.text.includes('timeshift=30'));
  ok('catchup / catchup-source 还在', out.text.includes('catchup="fmp4"') && out.text.includes('catchup-source="cctv5"'));
  ok('单引号写法原样保留', out.text.includes("catchup='fmp4'") && out.text.includes("catchup-source='hunan'"));
  ok('无引号写法原样保留', out.text.includes('catchup=fmp4'));
  ok('文件头仍是真正的 #EXTM3U（没被 #EXTM3U-XXX 这类行顶掉）', out.text.startsWith('#EXTM3U\n'), out.text.slice(0, 40));
  ok('#KODIPROP 头注释还在', out.text.startsWith('#EXTM3U\n#KODIPROP:inputstream.adaptive.license_type=clearkey'));
  ok('末尾注释没被丢', out.text.includes('#EXTM3U-TAIL:keep-me'));
  ok('删掉的那条没有残留', !out.text.includes('http://plain/'));
  ok('改名生效', out.text.includes('CCTV-1 综合,http://1/index.m3u8') === false && out.text.includes('CCTV-1 综合\nhttp://1/index.m3u8'));
  ok('条目数 6 -> 5', out.text.split('\n').filter((l) => /^https?:/.test(l)).length === 5);

  /* ================= 2) 「从源站更新」之后再导 ================= */
  console.log('\n— 从源站更新一轮后导出 —');
  const localEntries = parseM3U(out.text).entries;
  // 用户手改过的字段要打标记，更新的规则就是这么定的（本地手改的一律不覆盖）
  const cctv1 = localEntries.find((e) => e.url === 'http://1/index.m3u8');
  cctv1.touched = new Set(['url', 'title']);

  // 远端：CCTV-1 换源（本地手改过，该被挡）、CCTV-5 改名、还新增一条带私有属性的
  // 远端条目照实给 tvg-id，否则更新时匹配不上（匹配键是 tvg-id → 频道名）
  const remoteEntry = (tvgId, title, url, kv) => ({
    title,
    url,
    attrs: kv.map(([k, v]) => ({ key: k, value: v, raw: `${k}="${v}"` })),
    attrMap: { 'tvg-id': tvgId, ...Object.fromEntries(kv) },
  });
  const remote = [
    remoteEntry('cctv1.ftv', 'CCTV-1 综合', 'http://1/new.m3u8', [['catchup', 'fmp4'], ['timeshift', '-1']]),
    remoteEntry('cctv5.ftv', 'CCTV-5 体育 HD', 'http://5/index.m3u8', [['catchup', 'fmp4']]),
    remoteEntry('new.ftv', '远端新频道', 'http://new/index.m3u8', [['catchup', 'fmp4'], ['catchup-source', 'new']]),
  ];
  const merged = mergePlaylist(localEntries, remote);
  ok('远端新增被收进来', merged.stats.added === 1, JSON.stringify(merged.stats));
  ok('本地手改的地址没被远端刷掉', merged.entries.some((e) => e.url === 'http://1/index.m3u8'));

  const out2 = await exportViaHttp(serializeM3U({ ...doc, entries: merged.entries }));
  const byUrl2 = Object.fromEntries(parseM3U(out2.text).entries.map((e) => [e.url, e]));
  ok('更新后 catchup 没被冲掉', byUrl2['http://5/index.m3u8'].attrMap['catchup'] === 'fmp4');
  ok('更新后 timeshift 没被冲掉', byUrl2['http://5/index.m3u8'].attrMap['timeshift'] === '-1');
  ok('更新后 catchup-source 没被冲掉', byUrl2['http://9/index.m3u8'].attrMap['catchup-source'] === 'id9');
  ok('更新后 response-time 裸写法没被冲掉', byUrl2['http://9/index.m3u8'].attrMap['response-time'] === '{18}ms');
  const fresh = byUrl2['http://new/index.m3u8'];
  ok('远端新增频道带上了它自己的私有属性', fresh && fresh.attrMap['catchup'] === 'fmp4' && fresh.attrMap['catchup-source'] === 'new', fresh ? JSON.stringify(fresh.attrs) : '这条压根没进导出');

  // 手工塞一条「没有时长 / 没有 attrs」的条目最不能再漏字段
  const ragged = { title: '手工条目', url: 'http://ragged/index.m3u8', duration: undefined, attrs: undefined, attrMap: {} };
  const outRagged = await exportViaHttp(serializeM3U({ ...doc, entries: [...merged.entries, ragged] }));
  ok('缺时长的条目导出成 -1 而不是 undefined', outRagged.text.includes('#EXTINF:-1 ,手工条目') || outRagged.text.includes('#EXTINF:-1,手工条目'), outRagged.text.slice(-80));
  ok('缺 attrs 的条目不会炸', outRagged.status === 200);

  /* ================= 3) BOM + CRLF ================= */
  console.log('\n— BOM / CRLF 不因导出而变形 —');
  const crlfIn = await loadFile(crlfFile);
  ok('BOM 被解码吃掉，#EXTM3U 认得出来', crlfIn.doc.header === '#EXTM3U', JSON.stringify(crlfIn.doc.header));
  const rawCrlf = fs.readFileSync(crlfFile);
  const out3 = await exportViaHttp(serializeM3U(crlfIn.doc));
  ok('导出的字节与原文件逐字节一致', out3.buf.equals(rawCrlf), `${out3.buf.length} vs ${rawCrlf.length}`);
  ok('BOM 还在文件头', out3.buf[0] === 0xef && out3.buf[1] === 0xbb && out3.buf[2] === 0xbf);
  ok('CRLF 行尾保住了', out3.text.includes('catchup-source="a",A\r\n') && !out3.text.includes(',A\n'));

  /* ================= 4) 覆盖保存 = 导出的另一条路 ================= */
  console.log('\n— 覆盖保存（/api/save）—');
  const saveTo = path.join(tmp, 'saved.m3u');
  const r4 = await fetch(BASE + '/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: saveTo, text: out.text }),
  });
  ok('保存返回 200', r4.ok);
  const onDisk = fs.readFileSync(saveTo, 'utf8');
  ok('落盘内容和导出内容一致', onDisk === out.text);
  ok('落盘后私有属性仍在', invisibles(parseM3U(onDisk).entries)['http://9/index.m3u8'] === before['http://9/index.m3u8']);

  /* ================= 5) 脏数据不炸 ================= */
  console.log('\n— 异常输入 —');
  const bad = await exportViaHttp('这不是 m3u', 'x.m3u');
  ok('非 m3u 文本原样吐出（不 500）', bad.status === 200 && bad.text === '这不是 m3u');
  const nameClean = await exportViaHttp('#EXTM3U\n', '../../etc/passwd');
  const cd2 = nameClean.headers.get('content-disposition') || '';
  ok('文件名里的路径穿越被洗掉（不出现 / 或 ..）', !/[/\\]|\.\./.test(cd2), cd2);
  const zh = (await exportViaHttp('#EXTM3U\n', '我的列表 01.m3u')).headers.get('content-disposition') || '';
  const zhName = decodeURIComponent((zh.split("filename*=UTF-8''")[1] || '').replace(/;$/, ''));
  ok('中文文件名走 RFC5987 原样带出去', zhName === '我的列表 01.m3u' && !/[^\x00-\x7f]/.test(zh.split("filename=")[1] || ''), zh);

  /* ================= 6) .m3u8 按主流指南导出（RFC 8216：UTF-8 无 BOM） ================= */
  console.log('\n— .m3u8 导出去 BOM / .m3u 各走各的 MIME —');
  const bomDoc = crlfIn.doc; // 这份 doc 记着「原文件带 BOM」
  ok('isM3U8Name 认 .m3u8 / .M3U8 大写了也算', isM3U8Name('playlist.M3U8') && isM3U8Name('a.m3u8'));
  ok('isM3U8Name 不误认 .m3u（也不认空名字）', !isM3U8Name('playlist.m3u') && !isM3U8Name(''));

  const out8 = await exportViaHttp(serializeM3U(bomDoc, { stripBom: true }), 'out.m3u8');
  ok('.m3u8 导出字节里没有 BOM', !(out8.buf[0] === 0xef && out8.buf[1] === 0xbb && out8.buf[2] === 0xbf), out8.text.slice(0, 12));
  ok('.m3u8 导出首行还是 #EXTM3U', out8.text.startsWith('#EXTM3U'), out8.text.slice(0, 20));
  ok('.m3u8 导出仍是 UTF-8 且中文没烂', out8.text.includes('catchup-source="a",A'));
  ok('.m3u8 导出 MIME 是 application/vnd.apple.mpegurl', /^application\/vnd\.apple\.mpegurl/.test(out8.headers.get('content-type') || ''), out8.headers.get('content-type'));

  const out31 = await exportViaHttp(serializeM3U(bomDoc, { stripBom: true }), 'out.m3u');
  ok('.m3u 导出 MIME 是 audio/x-mpegURL', /^audio\/x-mpegurl/i.test(out31.headers.get('content-type') || ''), out31.headers.get('content-type'));
  ok('两个后缀吐出来的正文一模一样（差别只在 MIME 和文件名）', out31.text === out8.text);

  // 调用方忘了去 BOM 也别把 BOM 塞进 .m3u8：服务端按名字兜一层
  const naiveM3u8 = await exportViaHttp(serializeM3U(bomDoc), 'naive.m3u8');
  ok('即便上游忘了去 BOM，.m3u8 这一趟也不会带 BOM 出去', !(naiveM3u8.buf[0] === 0xef && naiveM3u8.buf[1] === 0xbb && naiveM3u8.buf[2] === 0xbf), naiveM3u8.text.slice(0, 12));
  const naiveM31 = await exportViaHttp(serializeM3U(bomDoc), 'naive.m3u');
  ok('去 BOM 前后正文一模一样（只少了开头那 3 个字节）', naiveM31.buf.slice(3).equals(Buffer.from(out31.text, 'utf8')));
  ok('.m3u 那一路仍然保留原文件的 BOM（逐字节还原）', naiveM31.buf[0] === 0xef && naiveM31.buf[1] === 0xbb && naiveM31.buf[2] === 0xbf);
  ok('stripBom 只吃第一个 BOM，正文里的不动', stripBom('﻿﻿#EXTM3U') === '﻿#EXTM3U');

  // 前端那条路（浏览器直接 Blob 下载）必须跟服务端一致，否则同一个列表两个后缀行为不同
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok('前端 .m3u8 下载也按扩展名去 BOM', /isM3U8Name\(filename\)[\s\S]{0,160}stripBom\(text\)/.test(appSrc));
  ok('前端 .m3u 用 Winamp 那边的老 MIME', /audio\/x-mpegURL/.test(appSrc));
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok('导出按钮文案只写后缀，没把编码格式挂上去', /data-i18n="导出 \.m3u8"/.test(htmlSrc) && /data-i18n="导出 \.m3u"/.test(htmlSrc) && !/UTF-8/.test(htmlSrc));
} catch (e) {
  failed++;
  console.log('\n[异常]', e && e.stack);
} finally {
  shutServer();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(failed ? `\n${failed} 项失败\n` : '\n全部通过\n');
process.exit(failed ? 1 : 0);

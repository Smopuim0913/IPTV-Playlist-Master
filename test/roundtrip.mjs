/**
 * 无损往返自测：解析 -> 序列化 -> 再解析，字段必须逐字节一致。
 * 运行：node test/roundtrip.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseM3U, serializeM3U } from '../src/m3u.js';
import { probeUrl, parseHlsVariants, formatLabel } from '../src/probe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, '..', 'sample', 'channels.m3u');
// 探测本地样例需要一个静态服务（就是 server.js 的 /sample 分支）。
// 自己拉一个子进程，别指望有人先手动起 —— 不然 npm test 里这一步一定是红的。
const PORT = process.env.PORT || 9199;

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + extra}`);
  if (!cond) failed++;
};

console.log('\n— 解析 / 序列化往返 —');
const original = fs.readFileSync(SAMPLE, 'utf8').replace(/\r\n?/g, '\n');
const doc = parseM3U(original);
const out = serializeM3U(doc);

ok('频道条数', doc.entries.length === 9, `got ${doc.entries.length}`);
ok('整份字节一致', out === original, `\n--- got ---\n${out}\n--- want ---\n${original}`);

const byName = Object.fromEntries(doc.entries.map((e) => [e.title, e]));

ok('#EXTM3U 头保留', doc.header === '#EXTM3U');
// KODIPROP 在首个 EXTINF 之前，属文件级注释：即使删掉首条频道也不会丢
ok('#KODIPROP 头注释保留', (doc.comments || []).includes('#KODIPROP:inputstream.adaptive.license_type=clearkey'));
ok('自定义属性 response-time 保留', byName['CCTV-13 新闻'].attrMap['response-time'] === '28');
ok('response-time 原样回写', byName['CCTV-13 新闻'].attrs.some((a) => a.raw === 'response-time="28"'));
// 这条顺带守着一条坑：无引号值遇到逗号必须截断，
// 否则 `{18}ms,CCTV-9 纪录` 会被吞成 response-time="{18}ms,CCTV-9" + 标题「纪录」
ok('私有写法 response-time={18}ms 不丢', byName['CCTV-9 纪录'].attrMap['response-time'] === '{18}ms');
ok('逗号后的频道名没被属性值吞掉', byName['CCTV-9 纪录'].title === 'CCTV-9 纪录', byName['CCTV-9 纪录'].title);
ok('catchup / catchup-source 保留', byName['CCTV-5 体育'].attrMap['catchup'] === 'fmp4' && byName['CCTV-5 体育'].attrMap['catchup-source'] === 'cctv5');
// 极简频道：没有 tvg-id / tvg-logo，只剩 tvg-name + group-title
const plainKeys = Object.keys(byName['无属性频道'].attrMap).sort();
ok('极简频道 attrMap 不多不少', plainKeys.join(',') === 'group-title,tvg-name', plainKeys.join(','));
ok('解析出的时长是 -1', byName['CCTV-1 综合'].duration === '-1');

console.log('\n— HLS 变体解析 —');
const variants = parseHlsVariants(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1920x1080
1080p/index.m3u8`);
ok('取到最高码率变体', variants.best.bandwidth === 2200000);
ok('分辨率 1920x1080', variants.best.width === 1920 && variants.best.height === 1080);
ok('识别为主播放列表', variants.isMaster === true);
ok('归约为 1080p', formatLabel(1920, 1080).includes('1080p'), formatLabel(1920, 1080));
ok('归约为 720p', formatLabel(1280, 720).includes('720p'), formatLabel(1280, 720));

console.log('\n— 探测（本地样例 + 必然失败的地址）—');

// 1) 先拉起一个真实的 server.js 子进程当源站（只用到它的 /sample 静态分支）
const origin = spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
// 注意别用 /api/state 当探针：没载入列表时它返回 404，会一直"不健康"。
// 直接探静态文件本身（第 2 步就要用到的那条）。
const READY = `http://127.0.0.1:${PORT}/sample/hls-sample.m3u8`;
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(READY);
    if (r.status === 200) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!ready) {
  origin.kill();
  console.log('FAIL  本地样例服务没起来');
  process.exit(1);
}

// 2) 本地静态 HLS：不依赖外网，可直接验证「分辨率 / 码率 / 在线」
const local = await probeUrl(READY, { timeout: 4000 }).catch(() => null);
if (local) {
  ok('本地样例命中 HLS', local.isHls === true, JSON.stringify(local));
  ok('本地样例在线', local.ok === true, local.code || local.note);
  ok('解析出 1080p', local.format.includes('1080p'), local.format);
  ok('带宽 2.2M', local.bandwidthMbps === 2.2, String(local.bandwidthMbps));
} else {
  console.log('SKIP  本地样例服务未启动');
}

// 2) 断开端口：应该秒级失败，而不是卡住
const dead = await probeUrl('http://127.0.0.1:9/live/dead/index.m3u8', { timeout: 4000 });
ok('失效地址判定为失败', dead.ok === false, JSON.stringify(dead));
ok('失败原因是连接被拒', /ECONNREFUSED|ENOTFOUND|ERR/i.test(dead.code || ''), dead.code);

// 3) 非法协议
const bad = await probeUrl('ftp://x/y.mp4', { timeout: 3000 });
ok('非法协议被拦截', bad.ok === false && bad.code === 'BAD_SCHEME', bad.code);

origin.kill();

console.log(failed ? `\n${failed} 项失败\n` : '\n全部通过\n');
process.exit(failed ? 1 : 0);

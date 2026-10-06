/**
 * 「SPS 藏在分片深处，128KB 窗口够不着」这一类。
 *
 * H.264 的分辨率只写在 SPS 里，而 SPS 只在关键帧（IDR）处出现一次。
 * 一个 GOP 动辄 1~3MB，比我们探流头用的窗口大得多 —— 分片边界要是正好
 * 落在两个 IDR 中间，从开头读永远读不到，分辨率就空着。
 *
 * 这里起几个假源站，把 SPS 摆在不同深度上，看探测是否会「先小窗口、再加深」：
 *   A. SPS 在 300KB（超出首窗口 128KB，在 1MB 之内）→ 加深一次就能读到
 *   B. SPS 在 2.5MB（1MB 也够不着）→ 如实说「关键帧间隔大于 1MB」
 *   C. 整段没 SPS → 不该谎称读到，也不该把话说成「纯音频」
 */
import http from 'node:http';
import { probeUrl } from '../src/probe.js';
import { makeSps } from './lib/sps.mjs';

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

const PLAYLIST =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6.0,\nseg.ts\n#EXT-X-ENDLIST\n';

/**
 * 裸 Annex-B 假分片：先铺 size 字节的切片（不含 SPS），
 * 等长度越过 spsAt 时把 SPS 插进去（spsAt=null 就是整段无 SPS）。
 */
function fakeSegment({ spsAt = null, size = 1_300_000 }) {
  const slice = Buffer.concat([Buffer.from([0, 0, 1, 1]), Buffer.alloc(4092, 0x41)]);
  // H.264 的宏块高度必须对齐 16，1080 除不尽 —— 真源站是把高写 1088 再靠 crop 扣回 1080。
  // 造夹具也得这么说，否则量出来的是 1072，断言就白写了。
  const sps = makeSps({ width: 1920, height: 1088, crop: [0, 0, 2, 2] });
  const parts = [];
  let len = 0;
  let inserted = false;
  while (len < size) {
    if (!inserted && spsAt !== null && len >= spsAt) {
      parts.push(sps);
      len += sps.length;
      inserted = true;
    }
    parts.push(slice);
    len += slice.length;
  }
  return Buffer.concat(parts);
}

async function probeWith(body, { timeout = 6000 } = {}) {
  const s = http.createServer((q, r) => {
    if (q.url.endsWith('.ts')) {
      r.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(body.length) });
      r.end(body);
      return;
    }
    r.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    r.end(PLAYLIST);
  });
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  const out = await probeUrl(`http://127.0.0.1:${port}/index.m3u8`, { timeout });
  s.close();
  return out;
}

/* ---------------- A. SPS 在 300KB：首窗口够不着，加深一次读到 ---------------- */
{
  const out = await probeWith(fakeSegment({ spsAt: 300000, size: 1_300_000 }));
  ok('SPS 藏在首窗口外时仍能读出分辨率', out.format && out.format.includes('1080'), out.format || '(空)');
  ok('读出来的是 1920x1080', out.width === 1920 && out.height === 1080, `${out.width}x${out.height}`);
  // 别把窗口大小写死在断言里，改 SEG_DEEP_BYTES 时这里不该跟着红
  ok('note 里写明是加深后读到的', /加深到 \d+MB/.test(out.note || ''), out.note);
  ok('加深没影响在线判定', out.ok === true);
}

/* ---------------- B. SPS 在 2.5MB：加深一倍也够不着 ---------------- */
{
  const out = await probeWith(fakeSegment({ spsAt: 2500000, size: 2_800_000 }));
  ok('1MB 也够不着时不硬凑分辨率', !out.format, out.format || '(空)');
  ok('如实说明关键帧间隔大于 1MB', /关键帧间隔|没写入/.test(out.note || ''), out.note);
  ok('该通道仍判在线', out.ok === true, out.code || '');
}

/* ---------------- C. 整段无 SPS ---------------- */
{
  const out = await probeWith(fakeSegment({ spsAt: null, size: 1_300_000 }));
  ok('无 SPS 时不给分辨率', !out.format, out.format || '(空)');
  ok('无 SPS 时不猜成纯音频', !/纯音频/.test(out.note || ''), out.note);
}

/* ---------------- D. SPS 就在开头的小分片：不该多挖 ---------------- */
{
  const small = fakeSegment({ spsAt: 0, size: 20000 });
  const out = await probeWith(small);
  ok('SPS 在开头（小分片）时首窗口就读到', out.format && out.format.includes('1080'), out.format || '(空)');
  ok('首窗口读到时不提加深', !/加深到/.test(out.note || ''), out.note);
}

console.log(failed ? `\n${failed} 项失败（通过 ${pass}）\n` : `\n全部通过（${pass} 项）\n`);
process.exit(failed ? 1 : 0);

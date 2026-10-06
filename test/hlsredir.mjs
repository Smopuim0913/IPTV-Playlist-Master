/**
 * HLS 走 302 换域名/换端口后，分片 URL 的基准必须跟着换。
 *
 * 起因：用户拿来一条 GSLB 源的实例
 *   http://38.75.136.137:98/gslb/dsdqbv/cctv16hd.m3u8?auth=test20251009
 * 第一个请求就是 302，跳到另一个机器另一个端口：
 *   -> http://63.141.250.98:82/live/cctv16md.m3u8?jsbt=...&jsbk=...
 * （顺带还把通道名从 hd 降成 md —— GSLB 自己的档位调度，跟探测无关）
 *
 * 这条链路有个隐蔽的坑：`firstSegmentUri` 拿原始 rawUrl 当 base 去拼分片，
 * 于是清单里的 `seg0.ts` 会被拼成
 *   http://38.75.136.137:98/gslb/dsdqbv/seg0.ts
 * —— 打到原来那个 GSLB 节点上，真实节点压根收不到这个请求。
 * 表现是「在线（清单 200）但读不到分辨率」，界面上就是一条干巴巴的「—」。
 *
 * 这里把这套链路原样架在本地（302 + 相对分片 + 真 TS 分片），跑真的 probeUrl，
 * 验证基准 URL 会跟着重定向走。
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

/* ---------------- TS 夹具（跟项目里其余测试同一套写法） ---------------- */

const VIDEO_PID = 0x0101;
const PMT_PID = 0x0100;
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
/** PSI 段起始包：净荷 = 1 字节 pointer_field + 段本体（段首字节就是 table_id） */
const psiPkt = (pid, section) => pkt(pid, true, Buffer.concat([Buffer.from([0x00]), section]));

const patSection = () =>
  Buffer.concat([
    Buffer.from([0x00, 0xb0, 0x0d]),
    Buffer.from([0x00, 0x01, 0xc0, 0x00, 0x00]), // transport_stream_id
    Buffer.from([0x00, 0x01]), // program_number —— 少了这两个字节 PMT_PID 会解成 0
    Buffer.from([pidHi(PMT_PID), PMT_PID & 0xff]),
    Buffer.alloc(4), // CRC
  ]);

const pmtSection = () =>
  Buffer.concat([
    Buffer.from([0x02, 0xb0, 0x17]),
    Buffer.from([0xe0, 0x1f, 0xc1, 0x00, 0x00]), // program_info_length
    Buffer.from([0x1b, pidHi(VIDEO_PID), VIDEO_PID & 0xff, 0xf0, 0x00]),
    Buffer.alloc(4),
  ]);

const tsWith = ({ width, height }) => {
  const sps = makeSps({ width, height });
  const part = (pusi, payload) => pkt(VIDEO_PID, pusi, payload);
  const head = Buffer.concat([
    psiPkt(0x0000, patSection()),
    psiPkt(PMT_PID, pmtSection()),
    part(true, Buffer.from([0x00, 0x00, 0x01, 0x09, 0x10])),
    part(false, sps),
    part(true, Buffer.from([0x00, 0x00, 0x01, 0x09, 0x21])),
    part(false, Buffer.alloc(120, 0x22)),
  ]);
  const tail = Buffer.concat(Array.from({ length: 20 }, () => part(false, Buffer.alloc(170, 0x33))));
  return Buffer.concat([head, tail]);
};

/* ---------------- 假源站：GSLB 302 → 真实节点（相对分片） ---------------- */

const LIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1001\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n';

let seenSeg = 0; // 真实节点上的分片被请求了几次
let gslbSeg = 0; // 有没有哪个请求被送到 GSLB 节点上（基准 URL 错的表现）

// GSLB 入口：跟真实那条一样，302 把人换到**另一台机器另一个端口**（host/port/path/query 全换）
const gslb = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/gslb/cctv16hd.m3u8') {
    res.writeHead(302, { location: `${ORIGIN}/live/cctv16md.m3u8?jsbt=1&jsbk=abc` });
    res.end();
    return;
  }
  // 落到 GSLB 头上的请求（拼错基准才会走到这儿）：记一笔，随便回个 404
  gslbSeg++;
  res.writeHead(404);
  res.end('not found');
});

// 真实节点：换端口、换路径都无所谓，关键是跟 GSLB 不是同一个 origin
const origin = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/live/cctv16md.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(LIST);
    return;
  }
  if (u.pathname.startsWith('/live/seg')) {
    seenSeg++;
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    res.end(tsWith({ width: 1280, height: 720 }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${origin.address().port}`;
await new Promise((r) => gslb.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${gslb.address().port}`;
const RAW = `${BASE}/gslb/cctv16hd.m3u8?auth=test20251009`;

try {
  const row = await probeUrl(RAW);

  console.log(`  [取证] format=${row.format || '(空)'} status=${row.status} noRes=${row.noRes || '(空)'} gslbSegHits=${gslbSeg}`);

  // 这条链路的核心：分片请求必须打到 302 之后的真实节点上
  ok('分片请求打到了 302 之后的真实节点（没落到 GSLB 头上）', gslbSeg === 0, `gslbSeg=${gslbSeg}`);
  ok('真实节点确实被取到了分片', seenSeg >= 1, `seenSeg=${seenSeg}`);
  ok('读到 720p 分辨率', /720/.test(row.format || ''), row.format || '(空)');
  ok('读到了就别再挂归因', !row.noRes, row.noRes || '');
  ok('note 里说明了是读分片流头得到的', /流头得到/.test(row.note || ''), row.note || '(空)');

  // 反过来：302 目标换了 host 还换了端口（上面两个 server 各占一个口），照样对
  const abs = await probeUrl(`${BASE}/gslb/cctv16hd.m3u8`);
  ok('换 host 又换端口的 302 也能拼对分片地址', /720/.test(abs.format || ''), abs.format || '(空)');

  // 源站自己就 404 的那条：要说清是「取不到」，别偷偷报成「读到了但分辨率是空」
  const dead = await probeUrl(`${BASE}/gslb/nothere.m3u8`);
  ok('清单 404 时 status 如实记下来', dead.status === 404, `${dead.status}`);
  ok('404 的 note 里带上 404（界面能说清是源死了）', /404/.test(dead.note || ''), dead.note || '(空)');
  ok('清单取不到时别挂一个「没读到分辨率」的归因去误导', !dead.noRes, dead.noRes || '(空=对)');
} finally {
  gslb.close();
  origin.close();
}

console.log(`\n  ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

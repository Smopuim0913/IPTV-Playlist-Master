/**
 * 主清单是变体清单、变体行只写 BANDWIDTH 不写 RESOLUTION 时，必须下钻到码率最高的
 * 那条变体的子清单去读分片。
 *
 * 起因：用户拿来一条 CCTV 源实例
 *   http://38.75.136.137:98/gslb/dsdqbv/cctv16hd.m3u8?auth=test20251009
 * （VLC 实测是 720p，工具却给不出分辨率）
 *
 * 这条源的链路是两层：GSLB 先 302 换机器换端口（见 hlsredir.m3u 那条测试），
 * 落地那个媒体清单是**变体清单**还是**媒体清单**，决定了走哪条分支。
 * 而 IPTV 里大量 CCTV / 省级源都是「主清单列出几档、变体行只有 BANDWIDTH + CODECS、
 * 把 RESOLUTION 留给子清单」这一形态 —— 早先的代码在这种情况会把主清单往下读一遍
 * 发现没有 RESOLUTION 就收工了，报一句「主清单只标了码率 3.5M 未标 RESOLUTION，
 * 无法得知分辨率」，可码率最高的那个变体的分片里明明就有 720p 的 SPS。
 *
 * 这里架一个假源站把这个形态原样跑一遍。
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
  return Buffer.concat([
    psiPkt(0x0000, patSection()),
    psiPkt(PMT_PID, pmtSection()),
    pkt(VIDEO_PID, true, Buffer.from([0x00, 0x00, 0x01, 0x09, 0x10])),
    pkt(VIDEO_PID, false, sps),
    ...Array.from({ length: 8 }, () => pkt(VIDEO_PID, false, Buffer.alloc(170, 0x33))),
  ]);
};

/* ---------------- 假源站 ---------------- */

const LIST720 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:900\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n';
// 变体行之间夹一行 #EXT-X-MEDIA 是常见写法，变体 URI 也不能贪心乱吃
const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=1500000,CODECS="avc1.4d401f"',
  'low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3500000,CODECS="avc1.4d401f"',
  'hd/index.m3u8',
  '#EXT-X-ENDLIST',
  '',
].join('\n');
// 变体自己写了 RESOLUTION 时不该下钻
const MASTER_WITH_RES = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
  'low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080',
  'hd/index.m3u8',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

let hits = { low: 0, hd: 0, seg: 0 };

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (buf, type) => {
    res.writeHead(200, { 'content-type': type });
    res.end(buf);
  };

  if (u.pathname === '/master.m3u8') {
    if (u.searchParams.get('with') === 'res') return send(Buffer.from(MASTER_WITH_RES), 'application/vnd.apple.mpegurl');
    return send(Buffer.from(MASTER), 'application/vnd.apple.mpegurl');
  }
  // 变体 URI 是相对路径，要落在它自己的子目录下（顺带验证「下钻的子目录」拼对了）
  if (u.pathname === '/low/index.m3u8') {
    hits.low++;
    return send(Buffer.from(LIST720), 'application/vnd.apple.mpegurl');
  }
  if (u.pathname === '/hd/index.m3u8') {
    hits.hd++;
    return send(Buffer.from(LIST720), 'application/vnd.apple.mpegurl');
  }
  if (u.pathname === '/hd/seg0.ts') {
    hits.seg++;
    return send(tsWith({ width: 1280, height: 720 }), 'video/mp2t');
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

try {
  /* ---------- A. 主清单只标码率，变体行没写 RESOLUTION ---------- */
  const row = await probeUrl(`${BASE}/master.m3u8`);
  console.log(`  [取证] format=${row.format || '(空)'} noRes=${row.noRes || '(空)'} note=${row.note || ''}`);

  ok('码率最高的变体的子清单被下钻到了', hits.hd >= 1, `hd=${hits.hd} low=${hits.low}`);
  ok('没去下钻码率低的那档（少打一次请求）', hits.low === 0, `low=${hits.low}`);
  ok('从下钻后那个子清单的分片读出了 720p', /720/.test(row.format || ''), row.format || '(空)');
  ok('读到了就别再挂着「没读到分辨率」的归因', !row.noRes, row.noRes || '(空)');
  ok('note 里点明是「下钻码率最高的变体」捞回来的', /下钻码率最高的变体/.test(row.note || ''), row.note || '(空)');
  ok(
    'note 不再说「无法得知分辨率」那句空话',
    !/无法得知分辨率/.test(row.note || ''),
    row.note || '(空)',
  );

  /* ---------- B. 变体行自己写了 RESOLUTION 就别多打一次 ---------- */
  hits = { low: 0, hd: 0, seg: 0 };
  const withRes = await probeUrl(`${BASE}/master.m3u8?with=res`);
  ok('变体写了 RESOLUTION 时直接显示 1080p', /1080/.test(withRes.format || ''), withRes.format || '(空)');
  ok('这种情形下不必再去下钻变体子清单', hits.hd === 0 && hits.seg === 0, `hd=${hits.hd} seg=${hits.seg}`);

  /* ---------- C. 下钻了但读不到时，话别说反 ---------- */
  // 拿掉真实节点上的分片：下钻照样成功，只是读不到 SPS —— note 不该同时出现
  // 「也没读出分辨率」和「读到了」两种结论
  const keep = srv;
  await new Promise((r) => keep.close(r));
  const dead = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(MASTER);
      return;
    }
    if (u.pathname === '/hd/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(LIST720);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const row2 = await probeUrl(`http://127.0.0.1:${dead.address().port}/master.m3u8`);
  console.log(`  [取证2] format=${row2.format || '(空)'} noRes=${row2.noRes || '(空)'} note=${row2.note || ''}`);
  ok('下钻了但读不到时不谎报分辨率', !row2.format, row2.format || '(空)');
  ok('下钻了但读不到时 note 里不能同时说「也没读出」又说「读到」', !/也没读出分辨率/.test(row2.note || '') || !/从它的分片流头读到/.test(row2.note || ''), row2.note || '(空)');
  ok('下钻了但读不到时要把「下钻过」这件事交代清楚', /下钻码率最高的变体/.test(row2.note || ''), row2.note || '(空)');
  dead.close();
} finally {
  srv.close();
}

console.log(`\n  ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

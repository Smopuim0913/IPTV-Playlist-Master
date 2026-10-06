/**
 * 验证「200 在线但分辨率列空着」到底是怎么回事。
 *
 * 三种真实来源各起一个假源站：
 *   1. 媒体播放列表（HLS 子清单/直连 ts）—— 里面根本没有 RESOLUTION，物理上无从得知
 *   2. 主清单只标 BANDWIDTH 没标 RESOLUTION —— 源站没写，不是解析失败
 *   3. 主清单被 gzip 下发 —— 之前会解不开，分辨率莫名其妙空着（已修）
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { probeUrl } from '../src/probe.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1920x1080
chunk0.m3u8
`;

// 只标码率、不标分辨率 —— 国内很多源站就这德行
const MASTER_NO_RES = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2200000,CODECS="avc1.64001f"
chunk0.m3u8
`;

const SUB = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
chunk0.ts
#EXT-X-ENDLIST
`;

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

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/master')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(MASTER);
  } else if (req.url.startsWith('/nores')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(MASTER_NO_RES);
  } else if (req.url.startsWith('/sub')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(SUB);
  } else if (req.url.startsWith('/gz')) {
    // 没声明 Accept-Encoding 也照样压缩下发（虽然不合规，但源站真这么干）
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync(Buffer.from(MASTER)));
  } else {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

console.log('无分辨率原因');

/* 1. 正常主清单：能解析出分辨率 */
const good = await probeUrl(`${base}/master.m3u8`, { timeout: 4000 });
ok('主清单读出 1080p', good.format && good.format.includes('1080'), good.format);
ok('主清单带码率', good.bandwidthMbps > 0, String(good.bandwidthMbps));

/* 2. 主清单没标 RESOLUTION：分辨率空，但要把原因说清楚 */
const nores = await probeUrl(`${base}/nores.m3u8`, { timeout: 4000 });
ok('无 RESOLUTION 时 format 为空', !nores.format, nores.format);
ok('无 RESOLUTION 时说明了原因', /未标 RESOLUTION/.test(nores.note || ''), nores.note);
ok('无 RESOLUTION 不影响在线判定', nores.ok === true);

/* 3. 子清单：物理上没有分辨率信息 */
const sub = await probeUrl(`${base}/sub.m3u8`, { timeout: 4000 });
ok('子清单 format 为空', !sub.format, sub.format);
ok('子清单说明是媒体播放列表', /媒体播放列表/.test(sub.note || ''), sub.note);

/* 4. gzip 下发的 m3u8：修之前会解不开导致分辨率空 */
const gz = await probeUrl(`${base}/gz.m3u8`, { timeout: 4000 });
ok('gzip 主清单仍能解析出分辨率', gz.format && gz.format.includes('1080'), gz.format);
ok('gzip 主清单码率正常', gz.bandwidthMbps > 0, String(gz.bandwidthMbps));

server.close();
console.log(failed ? `\n${failed} 项失败` : `\n${pass} 项全部通过`);
process.exit(failed ? 1 : 0);

/**
 * 本地服务 —— 负责三件事：
 *   1. 托管前端页面
 *   2. 服务端代取远程播放列表（绕开浏览器 CORS，IPTV 源站大多不发跨域头）
 *   3. 并发探测 + SSE 流式回报进度
 * 特点：零第三方依赖，Node 18+ 直接 node src/server.js
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseM3U, serializeM3U, decodeBuffer, detectEncoding, collectGroups, isM3U8Name, stripBom } from './m3u.js';
import { probeMany, probeUrl } from './probe.js';
import { detectPlayers, readCustom, writeCustom, describeCustom, activePlayer, openStream, openStreams, raiseRecent } from './player.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8777);

/** /api/probe-url 的结果缓存：url -> { at, out }，60 秒过期，见下方路由里的说明 */
const PROBE_URL_TTL = 60000;
const probeUrlCache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 当前内存中的播放列表 */
const store = {
  doc: null,
  path: null,
  loadedAt: 0,
  encoding: 'utf-8',
};

let probeToken = 0;

/**
 * 还在跑的 /api/probe 任务，谁登记谁带走句柄。
 *
 * 换列表（/api/load）得能把它们一键掐掉：前端那一边会先把 SSE 关掉，
 * 但关连接是「浏览器主动」的事 —— 页面要是卡着、或者开着的是个旧标签页，
 * 这条路就不一定及时。这里再兜一层，换列表的那一刻就把旧队列叫停，
 * 免得它继续给一批已经不存在 id 发请求，白烧源站的流量。
 */
const activeProbes = new Set();

/** 掐掉所有在跑的探测队列；前端自己在导入时也会先关 SSE，这里只是兜底 */
function stopAllProbes() {
  for (const h of [...activeProbes]) {
    try {
      h.stop();
    } catch {}
  }
  activeProbes.clear();
}

const sendJson = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
};

// 挑播放器时只把这些后缀当成"可执行文件"，其余文件列出来也没用
const EXEC_EXT = /\.(exe|bat|cmd|app|sh)$/i;

/**
 * 本机有哪些盘符 —— 到盘符根「上一级」就不动了（C:\ 的父目录还是 C:\），
 * 前端得有盘符按钮才能在盘之间跳（软件装在 D 盘的人总不能一路翻到 C:\ 再退出来）。
 * 这个项目的 Node 构建可能没带 os.drives()，所以自己扫一遍 A:–Z: 兜底；
 * 盘符换掉比重启一次服务少见得多，扫完就缓存住。
 */
let driveCache = null;
function listDrives() {
  if (driveCache) return driveCache;
  let list = [];
  try {
    if (typeof os.drives === 'function') list = os.drives() || [];
  } catch {
    /* 落到后面的自扫 */
  }
  if (!list.length && path.sep === '\\') {
    for (let i = 65; i <= 90; i++) {
      const d = String.fromCharCode(i) + ':\\';
      try {
        if (fs.statSync(d).isDirectory()) list.push(d);
      } catch {
        /* 没这个盘 */
      }
    }
  }
  driveCache = list;
  return list;
}

/**
 * 拼 Content-Disposition 的下载文件名。
 *
 * 两件事都得顾：
 *  1. 别把中文洗掉 —— 早先写的是 `[^\w.\-]+ -> _`，「我的列表 01.m3u」直接变成「_01.m3u」，
 *     中文频道名导出来的文件名一水儿下划线。
 *  2. Node 的 http 头**不允许裸非 ASCII**，原样塞进去会抛 ERR_INVALID_CHAR 500。
 * 所以按 RFC 6266 / 5987 双写：filename= 给 ASCII 兜底，filename*=UTF-8'' 带中文，
 * 顺带砍掉路径分隔符防 ../ 穿越。
 */
function contentDisposition(name) {
  const base =
    String(name || 'playlist')
      .replace(/[:*?"<>|\x00-\x1f\x7f]/g, '_')
      .split(/[\\/]/)
      .pop()
      .slice(0, 120)
      .trim() || 'playlist';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_');
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const serveStatic = (res, relPath) => {
  let file = path.join(PUBLIC_DIR, relPath === '/' ? 'index.html' : relPath);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  try {
    // ---------- 静态资源 ----------
    if (p === '/' || p.startsWith('/public/')) {
      return serveStatic(res, p === '/' ? '/index.html' : p.slice('/public'.length));
    }

    // 前端复用同一套解析器，保证「看到的」就是「导出的」
    if (p === '/module/m3u.js' || p === '/module/suffix.js' || p === '/module/sort.js' || p === '/module/merge.js') {
      const buf = await fs.promises.readFile(path.join(__dirname, p.slice('/module/'.length)));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(buf);
    }

    // ---------- 登记当前列表（前端已解析，这里只留 id / url 供探测用） ----------
    if (p === '/api/load' && req.method === 'POST') {
      const { entries, path, name } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!Array.isArray(entries)) return sendJson(res, 400, { error: '需要 entries 数组' });

      // 被测对象整批换掉了：上一趟还挂在半路的探测必须叫停（详见 stopAllProbes 的注释）。
      stopAllProbes();

      // 只建一张 id -> url 的索引，真正的文档由前端持有，
      // 探测结果直接回给前端，服务端不做中间态转换，避免两边不一致。
      store.doc = { entries: entries.map((e) => ({ id: e.id, url: e.url || '' })) };
      store.path = typeof path === 'string' && path ? path : null;
      store.name = typeof name === 'string' && name ? name : null;
      store.loadedAt = Date.now();

      return sendJson(res, 200, {
        ok: true,
        path: store.path,
        name: store.name,
        count: entries.length,
      });
    }

    // ---------- 从磁盘读一份列表（前端拿不到真实路径时用） ----------
    if (p === '/api/read' && req.method === 'POST') {
      const { file } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!file || !path.isAbsolute(file)) return sendJson(res, 400, { error: '需要绝对路径' });
      const buf = await fs.promises.readFile(file);
      return sendJson(res, 200, {
        ok: true,
        path: file,
        name: path.basename(file),
        // 原文以 base64 回给前端，由前端解析器统一处理（前后端共用一套解析逻辑）
        b64: buf.toString('base64'),
        encoding: detectEncoding(buf),
      });
    }

    // ---------- 服务端代取远程 m3u（绕 CORS） ----------
    if (p === '/api/fetch' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!url) return sendJson(res, 400, { error: '缺少 url' });
      let target;
      try {
        target = new URL(url);
      } catch {
        return sendJson(res, 400, { error: 'URL 不合法' });
      }
      if (!/^https?:$/.test(target.protocol)) return sendJson(res, 400, { error: '只支持 http/https' });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const r = await fetch(target.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
        });
        const buf = Buffer.from(await r.arrayBuffer());
        clearTimeout(timer);
        if (!r.ok) return sendJson(res, r.status, { error: `HTTP ${r.status}` });
        // 原文以 base64 回给前端，由前端解析器统一处理（前后端共用一套解析逻辑）
        return sendJson(res, 200, {
          ok: true,
          path: target.toString(),
          name: target.host,
          b64: buf.toString('base64'),
        });
      } catch (e) {
        clearTimeout(timer);
        return sendJson(res, 502, { error: String((e && e.message) || e) });
      }
    }

    // 示例列表（便于本地自测）
    if (p === '/sample/' || p.startsWith('/sample/')) {
      // 注意保留 sample 这一层目录，别把文件名直接拼到项目根
      const rel = p.replace(/^\/sample\//, '');
      const file = path.join(__dirname, '..', 'sample', rel);
      try {
        const buf = await fs.promises.readFile(file);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(buf);
      } catch {
        return sendJson(res, 404, { error: 'sample 不存在' });
      }
    }

    // ---------- 列表状态（分组分布等） ----------
    if (p === '/api/state' && req.method === 'GET') {
      if (!store.doc) return sendJson(res, 404, { error: '尚未载入列表' });
      return sendJson(res, 200, {
        ok: true,
        path: store.path,
        count: store.doc.entries.length,
        groups: collectGroups(store.doc.entries),
      });
    }

    // ---------- 探测（SSE 流式） ----------
    if (p === '/api/probe' && req.method === 'GET') {
      if (!store.doc) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('尚未载入列表');
      }
      const rawIds = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
      const entryById = new Map(store.doc.entries.map((e) => [e.id, e]));

      // 不带 ids 就是「探测全表」，这是最常用的入口
      const pool = rawIds.length
        ? rawIds.map((id) => entryById.get(id)).filter(Boolean)
        : store.doc.entries;

      // bytes：这一批每条愿意收多少字节（默认沿用探测自身的 64KB 浅窗口）。
      // 「分辨率没读到、单独重挖」的入口就是靠它把窗口顶到 4MB 的；
      // 设了大额度就别让并发太猛，1MB 以上的请求同时铺开容易被源站当成洪水。
      const rawBytes = Number(u.searchParams.get('bytes') || 0);
      const deepBytes = rawBytes > 0 ? Math.min(rawBytes, 16 * 1048576) : 0;
      const targets = pool
        .filter((e) => e.url)
        .map((e) => ({ id: e.id, url: e.url, ...(deepBytes ? { bytes: deepBytes } : null) }));
      if (!targets.length) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('没有可探测的地址');
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const token = ++probeToken;
      let cancelled = false;
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {}
      }, 15000);

      // 换列表时（/api/load）要能从外面叫停这一趟，登记一个句柄出去
      const handle = {
        stop() {
          cancelled = true;
          clearInterval(heartbeat);
        },
      };
      activeProbes.add(handle);

      res.on('close', () => {
        cancelled = true;
        clearInterval(heartbeat);
        activeProbes.delete(handle);
        if (token === probeToken) probeToken++;
      });

      const push = (obj) => {
        try {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {}
      };

      push({ type: 'start', total: targets.length });

      const { done, total } = await probeMany(targets, {
        concurrency: Number(u.searchParams.get('concurrency') || 8),
        timeout: Number(u.searchParams.get('timeout') || 8000),
        maxRedirects: 3,
        isCancelled: () => cancelled,
        onResult: (row, _i, tot) => {
          push({ type: 'result', row, done: _i, total: tot });
        },
      });

      clearInterval(heartbeat);
      push({ type: 'done', done, total, cancelled });
      try {
        res.end();
      } catch {}
      return;
    }

    // ---------- 单地址探测（「添加新频道」时边填边检测用） ----------
    //
    // 为什么不复用 /api/probe：那条要先载入列表（store.doc 为空直接 400「尚未载入列表」），
    // 而「添加新频道」往往正是还没载入任何列表的时候。这里只探一个地址，
    // 不碰任何列表状态，探测结果原样回给前端（前端只取其中的 serviceName）。
    if (p === '/api/probe-url' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!url) return sendJson(res, 400, { error: '缺少 url' });
      let target;
      try {
        target = new URL(url);
      } catch {
        return sendJson(res, 400, { error: 'URL 不合法' });
      }
      if (!/^https?:$/.test(target.protocol)) return sendJson(res, 400, { error: '只支持 http/https' });

      // 输入框防抖会连着打同一条地址（打一个字停一下就算一次），而探测要往下挖
      // 2MB 才找得到 SDT 服务名 —— 不缓存等于同一条源被挖好几遍。
      // 失败的也留一小会儿：同一个地址用户多半连着试几次（粘错、换源站），
      // 每次真去连一遍很浪费；TTL 短，不会把「源恢复了」的旧结果顶回来。
      const num = Number(u.searchParams.get('timeout'));
      const timeout = Number.isFinite(num) && num > 0 ? Math.min(num, 30000) : 8000;
      const key = target.toString();
      const hit = probeUrlCache.get(key);
      if (hit && Date.now() - hit.at < PROBE_URL_TTL) return sendJson(res, 200, hit.out);

      const out = await probeUrl(key, { timeout, probeBytes: 65536 });
      if (probeUrlCache.size >= 200) probeUrlCache.clear(); // 别让它无上限长
      probeUrlCache.set(key, { at: Date.now(), out });
      // 探测失败也回 200：前端要的是「这条地址读不到服务名」这个结论，不是一场报错
      return sendJson(res, 200, out);
    }

    // ---------- 本机播放器清单 / 手动指定 ----------
    if (p === '/api/players' && req.method === 'GET') {
      const custom = readCustom();
      const found = detectPlayers();
      return sendJson(res, 200, {
        ok: true,
        custom: custom ? describeCustom(custom) : null,
        // 手动指定的排前面，其余按扫描顺序；没有可用播放器时前端就不显示 ▶
        players: custom ? [describeCustom(custom), ...found] : found,
      });
    }

    if (p === '/api/players' && req.method === 'POST') {
      const { path: playerPath } = JSON.parse((await readBody(req)).toString('utf8'));
      // 留空就是「回到自动扫描」，别把 null 当成路径写给 fs
      const next = typeof playerPath === 'string' && playerPath.trim() ? playerPath.trim() : null;
      writeCustom(next);
      const found = detectPlayers();
      return sendJson(res, 200, {
        ok: true,
        custom: next ? describeCustom(next) : null,
        players: next ? [describeCustom(next), ...found] : found,
      });
    }

    // ---------- 本机目录浏览（给「播放器设置」的「浏览…」用） ----------
    // 为什么需要这个：浏览器里的 <input type="file"> 出于安全不给出真实磁盘路径（只会给
    // C:\fakepath\xxx.exe），所以「指一个 exe」这事在前端做不成，得由跑在本机的服务代劳。
    // 只返回目录名和文件名，不读文件内容、不跟随符号链接，够挑播放器就够了。
    if (p === '/api/browse' && req.method === 'GET') {
      const raw = new URL(req.url, 'http://x').searchParams.get('dir') || '';
      const target = raw ? path.resolve(raw) : os.homedir();
      let st = null;
      try {
        st = await fs.promises.stat(target);
      } catch (e) {
        return sendJson(res, 404, { error: `读不到这个路径：${target}`, reason: (e && e.code) || 'ENOENT' });
      }
      // 路径框里常常已经填着一个 exe 的路径 —— 那就列它所在的目录，
      // 别让用户先手动退到上一级才能开始挑（这正是「浏览…」一开就报「目录不存在」的原因）。
      let dir = target;
      if (!st.isDirectory()) dir = path.dirname(target);

      let items;
      try {
        items = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (e) {
        const why = e && (e.code === 'EACCES' || e.code === 'EPERM') ? '没有权限' : '读不到';
        return sendJson(res, 403, { error: `${why}：${dir}`, reason: (e && e.code) || 'EIO' });
      }
      // 目录在前、可执行文件在后，都按名字排；隐藏文件（.git 之类）不列
      const entries = items
        .filter((d) => !d.name.startsWith('.'))
        .map((d) => ({
          name: d.name,
          path: path.join(dir, d.name),
          type: d.isDirectory() ? 'dir' : EXEC_EXT.test(d.name) ? 'exe' : 'other',
        }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return sendJson(res, 200, {
        ok: true,
        dir,
        // 传进来的是文件（或压根没传）时，界面上显示的是实际在列的那个目录
        asked: raw || null,
        parent: path.dirname(dir),
        drives: listDrives(),
        entries,
      });
    }

    // ---------- 用本机播放器打开（一条 / 一串） ----------
    // 批量选中也是**一个**请求：播放器只起一个进程，频道排进同一份播放清单轮流播。
    if (p === '/api/open' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const raw = Array.isArray(body.items)
        ? body.items.map((it) => (typeof it === 'string' ? { url: it } : it || {}))
        : [{ name: body.name, url: body.url }];
      if (!raw.length || !raw.some((it) => it && String(it.url || '').trim())) {
        return sendJson(res, 400, { error: '缺少 url' });
      }
      const r = await openStreams(raw, body.player, { raise: body.raise });
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // ---------- 把播放器窗口再捞到最前 ----------
    // 自动那次在 /api/open 里 spawn 完就跑了，但 Windows 的前台激活规则经常拒掉
    // （后台进程抢不了前台），所以给 UI 一个「用户亲手点一下」的出口：
    // 人点了鼠标，前台权限才真的放开，这一次多半成。
    if (p === '/api/raise' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, count: raiseRecent() });
    }

    // ---------- 覆盖保存 ----------
    if (p === '/api/save' && req.method === 'POST') {
      const { file, text } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!file || !path.isAbsolute(file)) return sendJson(res, 400, { error: '需要绝对路径' });
      const target = path.resolve(file);
      await fs.promises.writeFile(target, text, 'utf8');
      store.path = target;
      store.loadedAt = Date.now();
      return sendJson(res, 200, { ok: true, path: target, bytes: Buffer.byteLength(text, 'utf8') });
    }

    // ---------- 导出 ----------
    if (p === '/api/export' && req.method === 'POST') {
      const { text, name } = JSON.parse((await readBody(req)).toString('utf8'));
      // 导出成 .m3u8 就按 RFC 8216 走：正文保持 UTF-8 但去掉 BOM。
      // 导出成 .m3u 没有这条规矩，原样透传（含 BOM 的源文件照旧逐字节还原）。
      const hls8 = isM3U8Name(name);
      const buf = Buffer.from(hls8 ? stripBom(text) : text, 'utf8');
      // .m3u 给的是 Winamp 那边的老 MIME，.m3u8 才是 Safari 认的那一套
      const mime = hls8 ? 'application/vnd.apple.mpegurl' : 'audio/x-mpegURL';
      res.writeHead(200, {
        'Content-Type': `${mime}; charset=utf-8`,
        'Content-Disposition': `attachment; ${contentDisposition(name || 'playlist')}`,
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
    else res.end();
  }
});

server.listen(PORT, () => {
  // 报真实端口而不是 process.env.PORT：传 PORT=0（交给系统挑一个空闲端口）时
  // 环境变量里还是 0，照它打出来就成了一个连不上的地址。
  const shown = server.address() && server.address().port ? server.address().port : PORT;
  console.log(`\n  IPTV Playlist Master →  http://localhost:${shown}\n`);
  console.log('  停止服务：Ctrl+C\n');
});

export { store, serializeM3U };

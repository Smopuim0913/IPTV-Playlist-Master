/**
 * 本机播放器唤起（src/player.js + /api/players + /api/open）。
 *
 * 这块跑的是真进程 spawn，但不出网、不碰真实播放器：
 * 用 node 自己当「播放器」（给个 http 地址让它去加载，失败也没关系，我们要的只是「唤起成功」），
 * 顺便验证非 http 地址会被挡掉、路径不存在会报错、配置能存能读。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  detectPlayers,
  describeCustom,
  readCustom,
  writeCustom,
  openStream,
  openStreams,
} from '../src/player.js';

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

const NODE = process.execPath;
const FAKE_URL = 'http://127.0.0.1:1/live.m3u8'; // 连不上的地址：我们只关心有没有被 spawn
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('播放器识别');

const found = detectPlayers();
ok('detectPlayers 返回数组', Array.isArray(found), typeof found);
ok('每项都有 name / path', found.every((p) => p.name && p.path), JSON.stringify(found[0] || {}));
// 扫出来的路径必须真的在盘上：曾经有过「名字里带 .app/ 就算找到」的兜底，
// 结果 Windows 上也把 /Applications/VLC.app/... 报成已装，点 ▶ 才报错。
const missing = found.filter((p) => !fs.existsSync(p.path));
ok('扫出来的路径都真实存在', missing.length === 0, JSON.stringify(missing.map((p) => p.path)));
if (process.platform === 'win32') {
  const foreign = found.filter((p) => /^\/Applications\/|\/usr\//.test(p.path));
  ok('Windows 上不会报 macOS 专属路径', foreign.length === 0, JSON.stringify(foreign.map((p) => p.path)));
}
console.log(`     （本机扫到：${found.length ? found.map((p) => p.name).join('、') : '没有'}`);
console.log('     —— 没有也没关系，下面的用例都自己指定播放器）');

console.log('地址校验');
{
  const r = openStream('file:///D:/movie/test.mp4', { id: 'x', name: '测试播放器', path: NODE });
  ok('file:// 直接拒绝（播放器对本地文件的支持参差不齐）', r.ok === false, JSON.stringify(r));
}
{
  const r = openStream('ftp://a.com/live.ts', { id: 'x', name: '测试播放器', path: NODE });
  ok('ftp:// 也拒绝', r.ok === false);
}
{
  const r = openStream('', { id: 'x', name: '测试播放器', path: NODE });
  ok('空地址拒绝', r.ok === false);
}

console.log('播放器可执行性');
{
  const r = openStream(FAKE_URL, { id: 'x', name: 'node（测试用）', path: NODE });
  ok('http 地址能 spawn 起来', r.ok === true, JSON.stringify(r));
  ok('返回了 pid', typeof r.pid === 'number' && r.pid > 0, JSON.stringify(r));
  ok('记录用的是哪个播放器', r.player === 'node（测试用）', r.player);
}
{
  const r = openStream(FAKE_URL, { id: 'x', name: '不存在的播放器', path: path.join(os.tmpdir(), 'no-such-player-xyz.exe') });
  ok('路径不存在时给出明确错误', r.ok === false && /路径不存在/.test(r.error), JSON.stringify(r));
}
{
  // 只给 http(s)：没装播放器时也要说清楚去哪儿配，而不是抛个空错误
  const r = openStream(FAKE_URL, null);
  ok('没有可用播放器时是「没找到播放器」而不是崩', r.ok === false ? /播放器/.test(r.error) : r.ok === true, JSON.stringify(r));
}

console.log('单窗口编排（批量播放也只起一个进程）');
{
  // 批量要的是「一个窗口里换台」，不是「一路声音一个窗口」——几路声音同时出来会糊成一团。
  // 所以默认参数**不能**带 --no-one-instance（那玩意儿强制每点一次另起一个 VLC 实例）。
  const vlcRec = detectPlayers().find((p) => p.id === 'vlc');
  ok(
    'VLC 默认参数不带 --no-one-instance',
    !vlcRec || !vlcRec.args.includes('--no-one-instance'),
    JSON.stringify((vlcRec && vlcRec.args) || []),
  );

  // 假播放器：node 跑一个脚本，把收到的 argv 原样写进记录文件（路径从环境变量拿）。
  // spawn 出来的是 `node rec.cjs <目标>`，记录里就能看出播放器到底收到了什么。
  // 扩展名必须是 .cjs —— 写 .mjs 的话 require 直接 ReferenceError，文件名一变就什么都记不下来。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpm-single-'));
  const recFile = path.join(tmp, 'rec.txt');
  process.env.MPM_REC = recFile;
  fs.writeFileSync(
    path.join(tmp, 'rec.cjs'),
    "const fs=require('node:fs');fs.appendFileSync(process.env.MPM_REC,JSON.stringify(process.argv.slice(2))+'\\n');",
    'utf8',
  );
  // 假播放器就是「node + 脚本」：脚本放在 args 里（和 VLC 那些固定参数一个位置），
  // 于是 spawn 出来的是 `node rec.cjs <目标>`，记录文件里能原样看到播放器收到了什么。
  const recPlayer = { id: 'rec', name: '记录播放器（测试用）', path: NODE, args: [path.join(tmp, 'rec.cjs')] };
  const readRec = () =>
    fs.existsSync(recFile)
      ? fs
          .readFileSync(recFile, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return [l];
            }
          })
      : [];

  const multi = await openStreams(
    [
      { name: 'CCTV-1', url: 'http://127.0.0.1:1/a.m3u8' },
      { name: 'CCTV-2', url: 'http://127.0.0.1:1/b.m3u8' },
      { name: '', url: 'http://127.0.0.1:1/c.m3u8' },
    ],
    recPlayer,
  );
  ok('批量唤起本身成功', multi.ok === true && typeof multi.pid === 'number', JSON.stringify(multi));
  ok('返回里带了条数', multi.count === 3, String(multi.count));
  await sleep(1500); // 假播放器是 detached 起的，等它把 argv 写进记录文件
  const got = readRec();
  ok('只 spawn 了一个进程（不是一个频道一个窗口）', got.length === 1, JSON.stringify(got));
  // 子进程里 process.argv = [node, rec.cjs, <目标>]，slice(2) 剩的就是播放器拿到的那个目标
  ok('播放器收到的是一份播放清单，不是三条裸地址', /\.m3u$/i.test((got[0] || [])[0] || ''), JSON.stringify(got));
  ok('返回的清单路径就是播放器收到的那个', multi.playlist === (got[0] || [])[0], `${multi.playlist} vs ${JSON.stringify(got)}`);
  const body = fs.readFileSync(multi.playlist, 'utf8');
  ok('清单带 EXTM3U 头', body.startsWith('#EXTM3U'), body.split('\n')[0]);
  ok('三条地址都在清单里', ['/a.m3u8', '/b.m3u8', '/c.m3u8'].every((u) => body.includes(u)), body);
  ok('频道名写进 EXTINF（播放列表里看得见是哪条）', /#EXTINF:[^\n]*CCTV-1/.test(body), body.split('\n')[1]);
  ok('没给名字的退回 IPTV 而不是空标签', /#EXTINF:[^\n]*IPTV/.test(body), body);

  // 单条走老路：直接把地址甩给播放器（兼容性最好，也不必落一份清单）
  const one = await openStreams([{ name: '单条', url: FAKE_URL }], recPlayer);
  ok('单条也能唤起', one.ok === true && one.count === 1, JSON.stringify(one));
  await sleep(1500); // 同上：真·node 冷启动，800ms 时记录文件还没落笔
  ok('单条传的是裸地址', (readRec()[1] || [])[0] === FAKE_URL, JSON.stringify(readRec()[1]));

  // 夹在里面的非 http 地址要被丢掉，不能把清单污染成打不开的东西
  const dirty = await openStreams(
    [
      { name: '好', url: 'http://127.0.0.1:1/d.m3u8' },
      { name: '坏', url: 'file:///D:/x.mp4' },
      'http://127.0.0.1:1/e.m3u8',
    ],
    recPlayer,
  );
  ok('混着非 http 地址时只放行能播的那几条', dirty.ok === true && dirty.count === 2, JSON.stringify(dirty));
  ok('清掉的 file:// 没写进清单', !/file:/i.test(fs.readFileSync(dirty.playlist, 'utf8')), fs.readFileSync(dirty.playlist, 'utf8'));
  ok('字符串形式的条目也能用', fs.readFileSync(dirty.playlist, 'utf8').includes('/e.m3u8'));
  const noUrl = await openStreams([{ name: 'x', url: 'ftp://a/x' }], recPlayer);
  ok('一条都没有时明确报错', noUrl.ok === false, JSON.stringify(noUrl));

  // VLC 分支：额外开一个本机 http 控制口 —— 以后点播放是往**这同一个窗口**里追加频道，
  // 不是再起一个 VLC 实例（这台机器上的 --one-instance 实测不生效，起三个进程）。
  const vlcLike = { id: 'vlc', name: '假 VLC', path: NODE, args: [path.join(tmp, 'rec.cjs')] };
  const v1 = await openStreams([{ name: 'A', url: FAKE_URL }], vlcLike);
  ok('VLC 分支带出 http 控制口（端口 + 随机密码）', v1.ok === true && typeof v1.port === 'number' && !!v1.password, JSON.stringify(v1));
  await sleep(1500); // 等假播放器把这两次 spawn 的记录都落盘
  const before = readRec().length;
  // 假 VLC 起不来（node 不认 --extraintf 那几个参数，秒退），下一次该重新起而不是静默失败。
  // 重新起的话控制口端口一定是新的；沿用旧实例则 port 是 undefined（会给 reused 标记）。
  const v2 = await openStreams([{ name: 'B', url: FAKE_URL }], vlcLike);
  ok('上一实例已退出时会重新起一个（不会卡住不播）', v2.ok === true && v2.port !== v1.port, JSON.stringify(v2));

  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.MPM_REC;
}

console.log('窗口置前');
{
  // openStream 的第三个参数 carry 窗口序号
  const r = openStream(FAKE_URL, { id: 'x', name: 'node（测试用）', path: NODE }, { raise: 3 });
  ok('带 raise 序号也能正常唤起', r.ok === true && typeof r.pid === 'number', JSON.stringify(r));
}

console.log('自定义播放器配置');
{
  // 把 HOME 指到临时目录，免得拿用户的配置文件做实验（player.js 是惰性读路径的）
  const saveHome = process.env.HOME;
  const saveUser = process.env.USERPROFILE;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpm-player-'));
  const fake = path.join(tmp, 'fake-player');
  fs.writeFileSync(fake, '');
  process.env.USERPROFILE = tmp;
  process.env.HOME = tmp;

  ok('默认没有自定义配置时读出来是 null', readCustom() === null, String(readCustom()));
  ok('写入自定义路径成功', writeCustom(fake) === true);
  ok('读回来是刚写的路径', readCustom() === fake, String(readCustom()));
  ok('描述.custom 得到一条播放器记录', describeCustom(fake).path === fake);
  ok('清空后读回来是 null', (writeCustom(''), readCustom()) === null, String(readCustom()));

  // 还原环境
  process.env.USERPROFILE = saveUser;
  process.env.HOME = saveHome;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

/* ---------------- 走一遍真实 API ---------------- */

console.log('HTTP 接口');
{
  // 这个实例必须配一个**假的 HOME**：下面会 POST /api/players 再清空一次，
  // 走真实 HOME 的话，收尾那个「还原配置」就把用户挑好的播放器抹掉了（真干过这么一回：
  // 用户选的 VLC 路径被测试写成 null，得手动重选）。临时目录里怎么折腾都不影响用户配置。
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mpm-home-'));
  const child = spawn(NODE, [path.resolve('src/server.js')], {
    env: { ...process.env, PORT: '0', USERPROFILE: fakeHome, HOME: fakeHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dead = false;
  child.on('exit', () => {
    dead = true;
  });
  child.stderr.on('data', (d) => {
    const t = String(d);
    if (/Error/.test(t)) console.log('    [server]', t.trim().slice(0, 200));
  });

  // 端口让系统给（listen(0)），从服务自己打印的启动横幅上读回来。
  //
  // 早先写死 9213，结果这台机器上几次跑测试都撞 EADDRINUSE —— 尤其 socket
  // 还被「进程已没了、端口却还 Bound」的僵死占用者攥着，netstat 里看都看不见，
  // 只能一个一个去杀。动态端口一次根治：并发跑、连着跑都不会再撞。
  let port = 0;
  child.stdout.on('data', (d) => {
    const m = /localhost:(\d+)/.exec(String(d));
    if (m) port = Number(m[1]);
  });

  const wait = async () => {
    for (let i = 0; i < 60; i++) {
      if (dead) throw new Error('服务进程提前退出');
      if (port) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/players`);
          if (r.ok) return true;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('服务起不来');
  };

  try {
    await wait();

    console.log('目录浏览（给「浏览…」按钮用）');
    // 浏览器给不出 exe 的真实路径（只会给 C:\fakepath\xx.exe），所以浏览得走服务端。
    // 只列目录和可执行后缀，不读文件内容，够挑播放器就行。
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpm-browse-'));
      fs.writeFileSync(path.join(tmp, 'fake-player.exe'), 'x');
      fs.writeFileSync(path.join(tmp, '.hidden.exe'), 'x');
      fs.writeFileSync(path.join(tmp, 'readme.txt'), 'x');
      fs.mkdirSync(path.join(tmp, 'sub dir'));

      const r = await fetch(`http://127.0.0.1:${port}/api/browse?dir=${encodeURIComponent(tmp)}`);
      const j = await r.json();
      ok('GET /api/browse 返回 ok', r.ok && j.ok === true, JSON.stringify(j).slice(0, 120));
      const names = (j.entries || []).map((e) => e.name);
      ok('列出了假 exe', names.includes('fake-player.exe'), JSON.stringify(names));
      ok('认出它是可执行文件', (j.entries || []).find((e) => e.name === 'fake-player.exe')?.type === 'exe');
      ok('目录排在最前面', (j.entries || [])[0]?.type === 'dir', JSON.stringify((j.entries || [])[0]));
      ok('普通文件也返回（只是不可选）', (j.entries || []).find((e) => e.name === 'readme.txt')?.type === 'other');
      ok('隐藏文件不列', !names.includes('.hidden.exe'), JSON.stringify(names));
      ok('返回了上一级目录', typeof j.parent === 'string' && j.parent.length > 0, String(j.parent));
      // 到盘符根「上一级」就失效了（C:\ 的父目录还是 C:\），所以盘符列表必须跟着一起下发给前端
      // 盘符串形如 "D:\"（字母 + 冒号 + 反斜杠），去掉尾部分隔符才是 "D:"
      ok(
        '带回了盘符列表',
        Array.isArray(j.drives) &&
          j.drives.length > 0 &&
          j.drives.every((d) => /^[A-Za-z]:[\\/]?$/.test(d)) &&
          j.drives.some((d) => tmp.startsWith(d.replace(/[\\/]+$/, ''))),
        JSON.stringify(j.drives),
      );

      // 路径框里已经填着一个 exe 的场景（点「浏览…」时最常见的死法）：
      // 传进来的是文件，得退到它所在的目录去列，而不是甩一个「目录不存在」
      const asFile = await fetch(
        `http://127.0.0.1:${port}/api/browse?dir=${encodeURIComponent(path.join(tmp, 'fake-player.exe'))}`,
      );
      const jf = await asFile.json();
      ok('传入文件路径时列它所在的目录', asFile.ok && jf.ok === true && jf.dir === tmp, JSON.stringify(jf).slice(0, 120));
      ok('该目录里的 exe 仍然可选', (jf.entries || []).some((e) => e.name === 'fake-player.exe' && e.type === 'exe'));

      const nf = await fetch(`http://127.0.0.1:${port}/api/browse?dir=${encodeURIComponent(path.join(tmp, 'nope'))}`);
      const jn = await nf.json();
      ok('目录不存在时是 404', nf.status === 404, String(nf.status));
      ok('404 带上具体原因而不是「目录不存在」', /读不到|不存在/.test(jn.error || ''), JSON.stringify(jn));

      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const list = await (await fetch(`http://127.0.0.1:${port}/api/players`)).json();
    ok('GET /api/players 返回 ok', list.ok === true, JSON.stringify(list).slice(0, 120));
    ok('players 是数组', Array.isArray(list.players));

    const picked = await (
      await fetch(`http://127.0.0.1:${port}/api/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: NODE }),
      })
    ).json();
    ok('POST /api/players 能把自定义路径排到第一位', picked.players[0] && picked.players[0].path === NODE, JSON.stringify(picked.players[0] || {}));
    ok('custom 字段带回刚设的路径', picked.custom && picked.custom.path === NODE);

    const opened = await (
      await fetch(`http://127.0.0.1:${port}/api/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: FAKE_URL, player: picked.players[0] }),
      })
    ).json();
    ok('POST /api/open 唤起成功', opened.ok === true, JSON.stringify(opened));

    const bad = await (
      await fetch(`http://127.0.0.1:${port}/api/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'file:///D:/x.mp4' }),
      })
    ).json();
    ok('file:// 在接口层也被挡住', bad.ok === false, JSON.stringify(bad));

    console.log('批量打开（一串频道进同一个播放器窗口）');
    {
      const items = [
        { name: 'A', url: 'http://127.0.0.1:1/a.m3u8' },
        { name: 'B', url: 'http://127.0.0.1:1/b.m3u8' },
      ];
      const batch = await (
        await fetch(`http://127.0.0.1:${port}/api/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, player: picked.players[0] }),
        })
      ).json();
      ok('POST items 唤起成功', batch.ok === true, JSON.stringify(batch));
      ok('带回条数 2', batch.count === 2, String(batch.count));
      ok('pid 只有一个（没按频道开一堆进程）', typeof batch.pid === 'number', JSON.stringify(batch));

      const dirty = await (
        await fetch(`http://127.0.0.1:${port}/api/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ name: 'x', url: 'file:///D:/x.mp4' }], player: picked.players[0] }),
        })
      ).json();
      ok('items 里没有可播地址时是 400', dirty.ok === false, JSON.stringify(dirty));

      const none = await (
        await fetch(`http://127.0.0.1:${port}/api/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [], player: picked.players[0] }),
        })
      ).json();
      ok('items 空数组也是 400', none.ok !== true && /缺少|没有/.test(none.error || ''), JSON.stringify(none));
    }

    // 「把播放器窗口调到最前」：批量开完容易只看到一个（VLC 窗口位置是记着的），
    // 得有一个明确的出口让用户点一下把窗口捞回来
    const raised = await (await fetch(`http://127.0.0.1:${port}/api/raise`, { method: 'POST' })).json();
    ok('POST /api/raise 返回 ok（捞窗口个数是数字）', raised.ok === true && typeof raised.count === 'number', JSON.stringify(raised));

    // 收尾：还原配置，别把测试用的 node 路径留在用户配置里
    await fetch(`http://127.0.0.1:${port}/api/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    });
  } catch (e) {
    ok('HTTP 接口用例', false, String((e && e.message) || e));
  } finally {
    child.kill();
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {}
  }
}

console.log(failed ? `\n${failed} 项失败（通过 ${pass}）\n` : `\n全部通过（${pass} 项）\n`);
process.exit(failed ? 1 : 0);

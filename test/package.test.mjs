/**
 * 交付物完整性測試。
 *
 * 這一支存在的理由是一個真實的缺陷：程式碼全部改好、測試全綠、實地端點也驗過，
 * 但 `npm pack` 產出的 tgz 是**兩小時前**的版本——缺了當天新增的四個檔案
 * （failures.js / status.js / ui.js / web-api.js）。別台電腦裝下去不會有任何錯誤，
 * 只是「沒有設定頁」而且「失敗分類沒生效」。使用者完全無從察覺。
 *
 * 會發生這件事是因為 `npm pack` 只裝 `files` 白名單內的檔案，而原始碼目錄是透過
 * junction 掛進 profile 的——**本機跑的是即時原始碼，別人跑的是 tgz**，兩者會
 * 無聲地分岔。
 *
 * 所以這支測試盯三件事：
 *   1. 磁碟上每個 lib/*.js 都在打包清單裡（漏檔立刻紅燈）；
 *   2. package.json 的 exports 與 dsh.client 指向真的存在、且真的會被裝進去的檔；
 *   3. 目錄裡那份既有的 tgz（如果有）內容與現在的原始碼一致——不一致就失敗，
 *      並提示要重新打包。
 *
 * 第 3 項是關鍵：它讓「忘記重新打包」變成一個測試失敗，而不是一個送到別人手上的
 * 舊版本。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}${cond ? '' : `  ${detail}`}`);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const pkgJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

console.log('--- 打包白名單 vs 磁碟上的檔案 ---');

// 用 npm 自己的判斷，而不是自己實作 files 白名單的規則——規則會變。
// Windows 上 npm 是 npm.cmd，spawn 不經 shell 找不到，所以 shell: true。
let packed = [];
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root, encoding: 'utf8', shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // npm 有時會在 JSON 前面多印幾行警告，從第一個 [ 或 { 開始解析。
  const start = raw.search(/[[{]/);
  packed = JSON.parse(raw.slice(start))[0].files.map((f) => f.path.replace(/\\/g, '/'));
} catch (err) {
  check('npm pack --dry-run 可執行', false, err.message);
}

if (packed.length > 0) {
  const packedSet = new Set(packed);

  // 1. lib/ 底下每個 .js 都必須進包。這是缺檔缺陷的直接防線。
  const libFiles = readdirSync(path.join(root, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .sort();
  check('lib/ 有檔案可檢查', libFiles.length > 0, String(libFiles.length));

  const missing = libFiles.filter((f) => !packedSet.has(`lib/${f}`));
  check(`lib/ 全部 ${libFiles.length} 個檔案都在打包清單內`,
    missing.length === 0,
    missing.length ? `漏掉：${missing.join(', ')}` : '');

  // 這次缺陷裡缺席的四個檔案，明確點名，避免將來又漏。
  for (const critical of ['failures.js', 'status.js', 'ui.js', 'web-api.js']) {
    check(`lib/${critical} 有進包（缺陷復發防線）`, packedSet.has(`lib/${critical}`));
  }

  check('cordis.patch.yml 有進包', packedSet.has('cordis.patch.yml'));
  check('bin/login.mjs 有進包', packedSet.has('bin/login.mjs'));

  console.log('\n--- exports 與 dsh.client 指向真的會被裝進去的檔 ---');
  for (const [key, target] of Object.entries(pkgJson.exports ?? {})) {
    const rel = String(target).replace(/^\.\//, '');
    check(`exports["${key}"] -> ${target}：檔案存在`, existsSync(path.join(root, rel)));
    check(`exports["${key}"] -> ${target}：會被裝進包`, packedSet.has(rel));
  }

  // 設定頁能不能出現，取決於這三個欄位。缺任何一個，整個分頁安靜地不存在。
  const client = pkgJson.dsh?.client;
  check('dsh.client 存在', Boolean(client));
  check('dsh.client.platform = web', client?.platform === 'web', String(client?.platform));
  check('dsh.client.inject 含 renderer / settings / locale',
    Array.isArray(client?.inject) &&
    client.inject.some((d) => /ui-renderer/.test(d)) &&
    client.inject.some((d) => /ui-settings/.test(d)) &&
    client.inject.some((d) => /locale/.test(d)),
    JSON.stringify(client?.inject));
  check('設定頁進入點（exports["./client"]）有進包',
    Boolean(pkgJson.exports?.['./client']) &&
    packedSet.has(String(pkgJson.exports['./client']).replace(/^\.\//, '')),
    String(pkgJson.exports?.['./client']));
  check('dsh.bundle.patch 存在且指向有進包的檔',
    Boolean(pkgJson.dsh?.bundle?.patch) &&
    packedSet.has(String(pkgJson.dsh.bundle.patch).replace(/^\.\//, '')),
    String(pkgJson.dsh?.bundle?.patch));

  console.log('\n--- 包內不得出現絕對路徑相依（別台必爆）---');
  // 包外相依若用絕對路徑，別台一定載入失敗。掃描會被裝進去的每個 .js。
  const offenders = [];
  for (const rel of packed.filter((p) => p.endsWith('.js'))) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    // 只抓「從磁碟絕對路徑載入」的形式，不抓一般的相對/套件 import。
    const matches = text.match(/(?:from\s+|import\s*\(|require\s*\()\s*['"][A-Za-z]:[\\/][^'"]*['"]/g);
    if (matches) offenders.push(`${rel}: ${matches[0]}`);
  }
  check('包內原始碼沒有硬編碼磁碟機路徑的動態載入', offenders.length === 0,
    offenders.join(' | '));
}

console.log('\n--- 目錄內的 tgz 是否與目前原始碼一致 ---');
const tgzName = `${pkgJson.name}-${pkgJson.version}.tgz`;
const tgzPath = path.join(root, tgzName);

if (!existsSync(tgzPath)) {
  console.log(`  --   - 找不到 ${tgzName}，略過（尚未打包時不算失敗）`);
} else {
  const work = mkdtempSync(path.join(tmpdir(), 'ocoa-pack-'));
  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'pipe' });
    const inner = path.join(work, 'package');

    // 逐檔雜湊比對：tgz 裡的 lib/*.js 必須與磁碟上完全相同。
    const libFiles = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js'));
    const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
    const differing = [];
    const absent = [];
    for (const f of libFiles) {
      const a = path.join(root, 'lib', f);
      const b = path.join(inner, 'lib', f);
      if (!existsSync(b)) { absent.push(f); continue; }
      if (sha(a) !== sha(b)) differing.push(f);
    }

    check(`tgz 內含全部 ${libFiles.length} 個 lib 檔案`, absent.length === 0,
      absent.length ? `缺少：${absent.join(', ')}` : '');
    check('tgz 內每個 lib 檔案都與原始碼位元組相同（沒有忘記重新打包）',
      differing.length === 0,
      differing.length
        ? `不同：${differing.join(', ')} → 請執行 npm pack 重新打包`
        : '');

    // 內層 package.json 的 exports / dsh.client 也要同步，否則裝起來沒有設定頁。
    try {
      const innerPkg = JSON.parse(readFileSync(path.join(inner, 'package.json'), 'utf8'));
      check('tgz 內的 exports["./client"] 與原始碼一致',
        innerPkg.exports?.['./client'] === pkgJson.exports?.['./client'],
        `${innerPkg.exports?.['./client']} vs ${pkgJson.exports?.['./client']}`);
      check('tgz 內的 dsh.client.platform 與原始碼一致',
        innerPkg.dsh?.client?.platform === pkgJson.dsh?.client?.platform,
        `${innerPkg.dsh?.client?.platform} vs ${pkgJson.dsh?.client?.platform}`);
      check('tgz 內的 dsh.client.inject 與原始碼一致',
        JSON.stringify(innerPkg.dsh?.client?.inject) === JSON.stringify(pkgJson.dsh?.client?.inject));
    } catch (err) {
      check('tgz 內的 package.json 可解析', false, err.message);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? `✔ Package integrity passed (${checks} checks)` : `❌ ${failures} / ${checks} checks failed`}`);
if (failures > 0) process.exit(1);

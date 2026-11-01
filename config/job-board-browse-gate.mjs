/**
 * 招聘站浏览门禁 — 按平台分别计数；开详情前必须跑。
 * 用北京日期清零；验证码只锁当天该平台。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = join(ROOT, 'config', 'profile.yml');

const DEFAULTS = {
  per_turn_detail_cap: 8,
  daily_detail_cap: 25,
  min_gap_ms: 4000,
  max_gap_ms: 8000,
  page_gap_ms: 20000,
  max_searches_per_turn: 3,
  turn_window_ms: 30 * 60 * 1000,
  // per_platform：各站各算；shared：全站共用一个桶
  quota_mode: 'per_platform',
  platforms: ['boss', 'zhilian', 'liepin', 'lagou'],
  state_file: 'data/job-board-browse-state.json',
};

const NEVER_CLICK = [
  '立即沟通', '沟通', '继续沟通', '打招呼',
  '投递', '立即投递', '立即申请', '发简历', '附件简历', '发送',
  '感兴趣',
];

// 别名 → 规范平台 id
const PLATFORM_ALIASES = {
  boss: 'boss',
  zhipin: 'boss',
  'boss直聘': 'boss',
  直聘: 'boss',
  zhilian: 'zhilian',
  zhaopin: 'zhilian',
  智联: 'zhilian',
  智联招聘: 'zhilian',
  liepin: 'liepin',
  猎聘: 'liepin',
  lagou: 'lagou',
  拉勾: 'lagou',
};

function todayShanghai() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function loadCaps() {
  const doc = yaml.load(readFileSync(PROFILE, 'utf8')) || {};
  const raw = doc.job_board_browse || {};
  const platforms = Array.isArray(raw.platforms) && raw.platforms.length
    ? raw.platforms.map(String)
    : DEFAULTS.platforms;
  return {
    ...DEFAULTS,
    ...raw,
    platforms,
    quota_mode: raw.quota_mode === 'shared' ? 'shared' : 'per_platform',
    never_click: Array.isArray(raw.never_click) && raw.never_click.length
      ? raw.never_click
      : NEVER_CLICK,
    stop_on: Array.isArray(raw.stop_on) ? raw.stop_on : [],
  };
}

function statePath(caps) {
  return resolve(ROOT, caps.state_file || DEFAULTS.state_file);
}

/** 单个平台的空计数 */
function emptyPlatform() {
  return {
    detail_opens: 0,
    turn_opens: 0,
    searches: 0,
    blocked: false,
    blocked_reason: '',
    last_open_at: 0,
    last_search_at: 0,
    turn_started_at: 0,
  };
}

function emptyState(date, caps) {
  const platforms = {};
  for (const id of caps.platforms) platforms[id] = emptyPlatform();
  return {
    date,
    quota_mode: caps.quota_mode,
    platforms,
    last_source: 'gate',
    never_click: NEVER_CLICK,
    must_run_before_every_detail: 'node config/job-board-browse-gate.mjs open <platform>',
    note: '',
  };
}

/** 把旧版扁平字段迁到 platforms.boss，避免丢今天的计数 */
function migrateLegacy(raw, caps) {
  if (raw.platforms && typeof raw.platforms === 'object') return raw;
  const next = emptyState(raw.date || todayShanghai(), caps);
  const boss = next.platforms.boss || emptyPlatform();
  if (typeof raw.detail_opens === 'number') boss.detail_opens = raw.detail_opens;
  if (typeof raw.turn_opens === 'number') boss.turn_opens = raw.turn_opens;
  if (typeof raw.searches === 'number') boss.searches = raw.searches;
  if (raw.blocked) {
    boss.blocked = true;
    boss.blocked_reason = raw.blocked_reason || 'legacy blocked';
  }
  boss.last_open_at = raw.last_open_at || 0;
  boss.last_search_at = raw.last_search_at || 0;
  boss.turn_started_at = raw.turn_started_at || 0;
  next.platforms.boss = boss;
  next.last_source = raw.last_source || 'gate';
  next.note = raw.note || 'migrated from shared/flat counter → boss';
  return next;
}

function readState(caps) {
  const path = statePath(caps);
  const today = todayShanghai();
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
    return emptyState(today, caps);
  }
  raw = migrateLegacy(raw, caps);
  // 换日整表清零
  if (raw.date !== today) return emptyState(today, caps);
  // 补全新平台键
  for (const id of caps.platforms) {
    if (!raw.platforms[id]) raw.platforms[id] = emptyPlatform();
  }
  raw.quota_mode = caps.quota_mode;
  return raw;
}

function writeState(caps, state) {
  const path = statePath(caps);
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    ...state,
    date: todayShanghai(),
    quota_mode: caps.quota_mode,
    never_click: caps.never_click,
    must_run_before_every_detail: 'node config/job-board-browse-gate.mjs open <platform>',
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function jitter(minMs, maxMs) {
  const lo = Number(minMs) || 0;
  const hi = Math.max(lo, Number(maxMs) || lo);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function normalizePlatform(input, caps) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  const id = PLATFORM_ALIASES[key] || PLATFORM_ALIASES[input] || (caps.platforms.includes(key) ? key : null);
  return id;
}

function resolvePlatform(arg, caps) {
  const id = normalizePlatform(arg, caps);
  if (!id) {
    console.error(`缺少或未知平台。用法: node config/job-board-browse-gate.mjs <check|open|search|risk> <platform>`);
    console.error(`平台: ${caps.platforms.join(' / ')}（也可用 智联 / 猎聘 / zhipin）`);
    process.exit(1);
  }
  return id;
}

function dailyCapFor(caps, platform) {
  const overrides = caps.daily_detail_cap_by_platform || {};
  if (overrides[platform] != null) return Number(overrides[platform]);
  return Number(caps.daily_detail_cap) || DEFAULTS.daily_detail_cap;
}

function refreshTurn(p, caps, now) {
  const windowMs = Number(caps.turn_window_ms) || DEFAULTS.turn_window_ms;
  if (!p.turn_started_at || now - p.turn_started_at > windowMs) {
    p.turn_started_at = now;
    p.turn_opens = 0;
    p.searches = 0;
  }
}

function printBanner(kind, reason, caps, state, platform) {
  const p = state.platforms[platform];
  const cap = dailyCapFor(caps, platform);
  const left = Math.max(0, cap - p.detail_opens);
  const turnLeft = Math.max(0, caps.per_turn_detail_cap - p.turn_opens);
  console.log(kind === 'STOP' ? '*** STOP ***' : '*** ALLOW ***');
  console.log(reason);
  console.log(`platform=${platform} mode=${caps.quota_mode} date=${state.date} opens=${p.detail_opens}/${cap} turn=${p.turn_opens}/${caps.per_turn_detail_cap} searches=${p.searches}/${caps.max_searches_per_turn} left_today=${left} left_turn=${turnLeft}`);
  console.log(`never_click=${(caps.never_click || []).join(' / ')}`);
  if (kind === 'STOP') {
    console.log(`禁止再开 ${platform} 的职位详情。其他平台额度互不影响。禁止手改状态文件。`);
  }
}

function stopPlatform(caps, state, platform, reason) {
  const p = state.platforms[platform];
  p.blocked = true;
  p.blocked_reason = reason;
  state.note = `${platform}: ${reason}`;
  writeState(caps, state);
  printBanner('STOP', reason, caps, state, platform);
  process.exit(2);
}

function cmdCheck(caps, state, platform) {
  const p = state.platforms[platform];
  const cap = dailyCapFor(caps, platform);
  if (p.blocked) {
    printBanner('STOP', p.blocked_reason || 'blocked', caps, state, platform);
    process.exit(2);
  }
  if (p.detail_opens >= cap) {
    stopPlatform(caps, state, platform, `${platform} daily_detail_cap ${p.detail_opens}/${cap}`);
  }
  const now = Date.now();
  refreshTurn(p, caps, now);
  if (p.turn_opens >= caps.per_turn_detail_cap) {
    printBanner('STOP', `${platform} per_turn_detail_cap ${p.turn_opens}/${caps.per_turn_detail_cap}，等 30 分钟或换日`, caps, state, platform);
    process.exit(2);
  }
  writeState(caps, state);
  printBanner('ALLOW', `${platform} 可以准备开下一条；开之前必须再跑 open ${platform}`, caps, state, platform);
}

function cmdOpen(caps, state, platform) {
  const p = state.platforms[platform];
  const cap = dailyCapFor(caps, platform);
  const now = Date.now();
  if (p.blocked) {
    printBanner('STOP', p.blocked_reason || 'blocked', caps, state, platform);
    process.exit(2);
  }
  if (p.detail_opens >= cap) {
    stopPlatform(caps, state, platform, `${platform} daily_detail_cap ${p.detail_opens}/${cap}`);
  }
  refreshTurn(p, caps, now);
  if (p.turn_opens >= caps.per_turn_detail_cap) {
    printBanner('STOP', `${platform} per_turn_detail_cap ${p.turn_opens}/${caps.per_turn_detail_cap}，等 30 分钟或换日`, caps, state, platform);
    process.exit(2);
  }
  // 强制间隔：只看该平台上次开详情时间
  const waited = p.last_open_at ? now - p.last_open_at : caps.max_gap_ms;
  const need = jitter(caps.min_gap_ms, caps.max_gap_ms);
  const sleepMs = Math.max(0, need - Math.max(0, waited));
  if (sleepMs > 0) {
    console.log(`sleep ${sleepMs}ms`);
    sleep(sleepMs);
  }
  p.detail_opens += 1;
  p.turn_opens += 1;
  p.last_open_at = Date.now();
  state.last_source = 'gate';
  state.note = `gate open ${platform} ${p.detail_opens}/${cap}`;
  if (p.detail_opens >= cap) {
    p.blocked = true;
    p.blocked_reason = `${platform} daily_detail_cap ${p.detail_opens}/${cap}`;
  }
  writeState(caps, state);
  printBanner(
    p.blocked ? 'STOP' : 'ALLOW',
    p.blocked ? p.blocked_reason : `${platform} 本条已计数，可以打开这一条详情（只读 JD）`,
    caps,
    state,
    platform,
  );
  if (p.blocked) process.exit(2);
}

function cmdSearch(caps, state, platform) {
  const p = state.platforms[platform];
  const now = Date.now();
  if (p.blocked) {
    printBanner('STOP', p.blocked_reason || 'blocked', caps, state, platform);
    process.exit(2);
  }
  refreshTurn(p, caps, now);
  if (p.searches >= caps.max_searches_per_turn) {
    printBanner('STOP', `${platform} max_searches_per_turn ${p.searches}/${caps.max_searches_per_turn}`, caps, state, platform);
    process.exit(2);
  }
  const waited = p.last_search_at ? now - p.last_search_at : caps.page_gap_ms;
  const sleepMs = Math.max(0, caps.page_gap_ms - Math.max(0, waited));
  if (sleepMs > 0) {
    console.log(`sleep ${sleepMs}ms`);
    sleep(sleepMs);
  }
  p.searches += 1;
  p.last_search_at = Date.now();
  state.last_source = 'gate';
  writeState(caps, state);
  printBanner('ALLOW', `${platform} 可以换搜索词或翻页（不要连翻）`, caps, state, platform);
}

function cmdRisk(caps, state, platform, reason) {
  stopPlatform(caps, state, platform, reason || `${platform} risk`);
}

function cmdStatus(caps, state) {
  console.log(`date=${state.date} mode=${caps.quota_mode}`);
  for (const id of caps.platforms) {
    const p = state.platforms[id] || emptyPlatform();
    const cap = dailyCapFor(caps, id);
    const flag = p.blocked || p.detail_opens >= cap ? 'STOP' : 'OK';
    console.log(`${id}\t${p.detail_opens}/${cap}\tturn=${p.turn_opens}/${caps.per_turn_detail_cap}\t${flag}${p.blocked_reason ? ` (${p.blocked_reason})` : ''}`);
  }
}

const caps = loadCaps();
const state = readState(caps);
const [cmd, arg1, ...rest] = process.argv.slice(2);

if (cmd === 'status') {
  cmdStatus(caps, state);
} else if (cmd === 'check' || cmd === 'open' || cmd === 'search') {
  const platform = resolvePlatform(arg1, caps);
  if (cmd === 'check') cmdCheck(caps, state, platform);
  else if (cmd === 'open') cmdOpen(caps, state, platform);
  else cmdSearch(caps, state, platform);
} else if (cmd === 'risk') {
  // risk <platform> [原因] 或兼容旧写法 risk captcha（默认锁 boss）
  let platform = normalizePlatform(arg1, caps);
  let reasonParts = rest;
  if (!platform) {
    platform = 'boss';
    reasonParts = [arg1, ...rest].filter(Boolean);
  }
  cmdRisk(caps, state, platform, reasonParts.join(' ') || 'risk');
} else {
  console.error('用法:');
  console.error('  node config/job-board-browse-gate.mjs check|open|search <platform>');
  console.error('  node config/job-board-browse-gate.mjs risk <platform> [原因]');
  console.error('  node config/job-board-browse-gate.mjs status');
  console.error(`平台: ${caps.platforms.join(' / ')}`);
  process.exit(1);
}

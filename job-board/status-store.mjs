/**
 * 岗位进度存在 data/job-board-status.json。
 *
 * 不写 applications.md。那边的状态是一条线（已评估 → 已投 → 回复 → 面试 →
 * 录用/拒绝），写不进「沟通了没有、面试了没有、结果如何」这三件可以分开填的事。
 * 硬写成 Hired / Rejected 还会把真正的投递记录改错。
 *
 * 岗位列表仍来自 pipeline.md（抓取脚本已经在写这个文件）。这里只按
 * url-key.mjs 归一化后的链接保存进度，所以下次重写 pipeline 不会把进度冲掉，
 * 同一条链接也能和追踪表对上。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

// 不走 tracker-utils 的 writeFileAtomic：那个模块会带上 js-yaml。
// 看板要能在只装了 Node、还没 npm install 的 Windows 上双击打开。
// 写法和那边一样：同目录临时文件，再改名替换，遇到 Windows 短暂占用就重试。
const RENAME_RETRY_MS = [1, 2, 5, 10, 25, 50, 100];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeStatusAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content);
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (err) {
        const retry = err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY';
        if (!retry || attempt >= RENAME_RETRY_MS.length) throw err;
        sleepSync(RENAME_RETRY_MS[attempt]);
      }
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export const STATUS_FIELDS = ['applied', 'contacted', 'interview', 'result'];

const ALLOWED = {
  applied: new Set(['no', 'yes']),
  contacted: new Set(['unset', 'yes', 'no']),
  interview: new Set(['unset', 'yes', 'no']),
  result: new Set(['unset', 'success', 'fail']),
};

const FIELD_LABEL = {
  applied: '投递',
  contacted: '沟通',
  interview: '面试',
  result: '结果',
};

export class StatusStoreError extends Error {
  /**
   * @param {string} message
   * @param {'CORRUPT'|'INVALID'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'StatusStoreError';
    this.code = code;
  }
}

/**
 * @returns {{applied: string, contacted: string, interview: string, result: string}}
 */
export function blankStatus() {
  return { applied: 'no', contacted: 'unset', interview: 'unset', result: 'unset' };
}

/**
 * @param {unknown} value
 * @returns {{applied: string, contacted: string, interview: string, result: string, updatedAt?: string}}
 */
export function normalizeStatus(value) {
  if (value == null) return blankStatus();
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StatusStoreError('进度文件里有一条记录不是对象，已停止，避免覆盖原文件。', 'CORRUPT');
  }
  const next = blankStatus();
  for (const field of STATUS_FIELDS) {
    if (value[field] === undefined) continue;
    if (!ALLOWED[field].has(value[field])) {
      throw new StatusStoreError(`进度文件里的${FIELD_LABEL[field]}值无法识别，已停止，避免覆盖原文件。`, 'CORRUPT');
    }
    next[field] = value[field];
  }
  if (typeof value.updatedAt === 'string' && value.updatedAt) next.updatedAt = value.updatedAt;
  return next;
}

/**
 * 把一次点击合并进当前进度。
 * 选「未投」会清掉后面三项。记下沟通、面试或结果时，自动标成已投。
 *
 * @param {object|null|undefined} current
 * @param {object} patch
 */
export function applyStatusPatch(current, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new StatusStoreError('提交的进度不是对象。', 'INVALID');
  }
  const next = normalizeStatus(current);
  let touched = false;
  for (const field of STATUS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    touched = true;
    if (!ALLOWED[field].has(patch[field])) {
      throw new StatusStoreError(`${FIELD_LABEL[field]}的选项无效。`, 'INVALID');
    }
    next[field] = patch[field];
  }
  if (!touched) throw new StatusStoreError('没有要保存的进度。', 'INVALID');

  if (patch.applied === 'no') {
    next.contacted = 'unset';
    next.interview = 'unset';
    next.result = 'unset';
  } else if (next.contacted !== 'unset' || next.interview !== 'unset' || next.result !== 'unset') {
    next.applied = 'yes';
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * @param {string} file
 * @returns {{version: number, updatedAt: string|null, byUrl: Record<string, object>}}
 */
export function loadStatus(file) {
  if (!existsSync(file)) return { version: 1, updatedAt: null, byUrl: {} };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new StatusStoreError(`进度文件读不出来（${err.code || '错误'}），没有改它。`, 'CORRUPT');
  }
  if (!text.trim()) return { version: 1, updatedAt: null, byUrl: {} };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StatusStoreError('进度文件不是合法的 JSON，没有改它。', 'CORRUPT');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StatusStoreError('进度文件格式不对，没有改它。', 'CORRUPT');
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new StatusStoreError('进度文件版本无法识别，没有改它。', 'CORRUPT');
  }
  const raw = parsed.byUrl ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StatusStoreError('进度文件格式不对，没有改它。', 'CORRUPT');
  }
  const byUrl = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.startsWith('https://')) {
      throw new StatusStoreError('进度文件里有无法识别的链接，没有改它。', 'CORRUPT');
    }
    byUrl[key] = normalizeStatus(value);
  }
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    byUrl,
  };
}

/**
 * @param {string} file
 * @param {{version: number, updatedAt: string|null, byUrl: Record<string, object>}} doc
 */
export function saveStatus(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  const payload = {
    version: 1,
    updatedAt: doc.updatedAt,
    byUrl: doc.byUrl,
  };
  writeStatusAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * 读出、改一条、写回。文件损坏时直接抛出，不会用空记录覆盖。
 *
 * @param {string} file
 * @param {string} id
 * @param {object} patch
 */
export function updateJobStatus(file, id, patch) {
  if (typeof id !== 'string' || !id.startsWith('https://')) {
    throw new StatusStoreError('这条岗位没有可保存的链接。', 'INVALID');
  }
  const doc = loadStatus(file);
  const next = applyStatusPatch(doc.byUrl[id], patch);
  doc.byUrl[id] = next;
  doc.updatedAt = next.updatedAt;
  saveStatus(file, doc);
  return next;
}

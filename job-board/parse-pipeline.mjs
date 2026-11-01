/**
 * 把 data/pipeline.md 里的抓取结果拆成一条条岗位。
 *
 * 只认带 http(s) 链接的勾选行。没有链接的跳过说明（例如「默认列表 skipped」）
 * 不是岗位。`[x]` 和划掉的条目会保留，但带 skipped，页面默认不显示。
 * 缺公司、地点、薪资、分数时留空，不报错。
 */

import { normalizeUrl } from '../url-key.mjs';

const ENTRY_RE = /^\s*- \[([ xX!])\]\s+(.*)$/;
const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;

/**
 * 从备注或单独一格里取出 x/5 分数。超出 0–5 的不算分数。
 * @param {string} text
 * @returns {number|null}
 */
export function extractScore(text) {
  const match = String(text ?? '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 5) return null;
  return Math.round(value * 10) / 10;
}

/**
 * @param {string} heading
 * @returns {{id: string, label: string}}
 */
export function classifySection(heading) {
  const text = String(heading ?? '');
  const folded = text.toLowerCase();
  if (folded.includes('pending') || text.includes('建议')) return { id: 'pending', label: '建议投' };
  if (folded.includes('marginal') || text.includes('先不投') || text.includes('边际')) {
    return { id: 'marginal', label: '先不投' };
  }
  if (folded.includes('processed') || text.includes('跳过') || text.includes('已处理')) {
    return { id: 'processed', label: '已处理' };
  }
  const label = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  return { id: 'other', label: label || '其他' };
}

/**
 * 标题里没有平台时，用域名猜国内站。猜不到就留空。
 * @param {string} url
 * @returns {string}
 */
export function platformFromUrl(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (host.endsWith('zhipin.com')) return 'BOSS直聘';
  if (host.endsWith('zhaopin.com')) return '智联招聘';
  if (host.endsWith('liepin.com')) return '猎聘';
  if (host.endsWith('lagou.com')) return '拉勾';
  return '';
}

/**
 * @param {string} body
 * @returns {{body: string, expired: boolean}}
 */
function unwrapExpired(body) {
  const text = String(body ?? '').trim();
  if (!text.startsWith('~~')) return { body: text, expired: false };
  const inner = text.endsWith('~~') ? text.slice(2, -2) : text.slice(2);
  return { body: inner.trim(), expired: true };
}

/**
 * @param {string} body
 * @returns {{url: string, company: string, role: string, location: string, salary: string, note: string, score: number|null}}
 */
export function parseEntryBody(body) {
  const cells = String(body ?? '')
    .split(/\s*[|｜]\s*/)
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);

  let url = '';
  const notes = [];
  let score = null;
  const unlabeled = [];

  for (const cell of cells) {
    if (!url && /^https?:\/\//i.test(cell)) {
      url = cell;
      continue;
    }
    const noteMatch = cell.match(/^note:\s*(.*)$/i);
    if (noteMatch) {
      if (noteMatch[1]) notes.push(noteMatch[1]);
      continue;
    }
    if (/^(posted|trust|rank):/i.test(cell)) continue;
    if (/^#\d+$/.test(cell) || /^\[\d+\]/.test(cell)) continue;
    if (/^PDF\b/i.test(cell)) continue;
    if (/^(\d+(?:\.\d+)?)\s*\/\s*5$/.test(cell)) {
      score = extractScore(cell);
      continue;
    }
    unlabeled.push(cell);
  }

  const note = notes.join('；');
  if (score == null) score = extractScore(note);

  return {
    url,
    company: unlabeled[0] ?? '',
    role: unlabeled[1] ?? '',
    location: unlabeled[2] ?? '',
    salary: unlabeled[3] ?? '',
    note,
    score,
  };
}

/**
 * @param {string} markdown
 * @returns {Array<object>}
 */
export function parsePipeline(markdown) {
  const text = String(markdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let section = { id: 'other', label: '其他' };
  let platform = '';
  /** @type {Map<string, object>} */
  const byId = new Map();
  const order = [];

  for (const line of text.split('\n')) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      if (heading[1].length === 2) {
        section = classifySection(heading[2]);
        platform = '';
      } else {
        platform = heading[2].trim();
      }
      continue;
    }

    const entry = line.match(ENTRY_RE);
    if (!entry) continue;

    const mark = entry[1];
    const unwrapped = unwrapExpired(entry[2]);
    const fields = parseEntryBody(unwrapped.body);
    if (!fields.url) continue;

    const id = normalizeUrl(fields.url);
    if (!id) continue;

    const skipped = mark !== ' ' || unwrapped.expired;
    const job = {
      id,
      url: fields.url,
      company: fields.company,
      role: fields.role,
      platform: platform || platformFromUrl(fields.url),
      location: fields.location,
      salary: fields.salary,
      score: fields.score,
      note: fields.note,
      section: section.id,
      sectionLabel: section.label,
      skipped,
      expired: unwrapped.expired,
      fetchError: mark === '!',
    };

    const previous = byId.get(id);
    if (!previous) {
      byId.set(id, job);
      order.push(id);
      continue;
    }
    // 同一条链接先被标成跳过、后来又出现在待处理里时，以还开着的那条为准。
    if (previous.skipped && !job.skipped) byId.set(id, job);
  }

  return order.map((id) => byId.get(id));
}

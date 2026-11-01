/**
 * 页面上的筛选和排序。浏览器和测试共用这一份，避免两边各写一套。
 * 这个文件不能引用 Node 模块。
 */

export const PROGRESS_FILTERS = [
  { id: 'all', label: '全部进度' },
  { id: 'not-applied', label: '未投' },
  { id: 'applied', label: '已投' },
  { id: 'contacted-yes', label: '有沟通' },
  { id: 'contacted-no', label: '没沟通' },
  { id: 'interview-yes', label: '有面试' },
  { id: 'interview-no', label: '没面试' },
  { id: 'success', label: '成功' },
  { id: 'fail', label: '没成' },
];

export const SORTS = [
  { id: 'score-desc', label: '分数从高到低' },
  { id: 'score-asc', label: '分数从低到高' },
  { id: 'company', label: '公司名' },
];

export const SECTION_FILTERS = [
  { id: 'all', label: '全部清单' },
  { id: 'pending', label: '建议投' },
  { id: 'marginal', label: '先不投' },
  { id: 'processed', label: '已处理' },
];

/**
 * @param {object} job
 * @param {string} progress
 * @returns {boolean}
 */
export function matchesProgress(job, progress) {
  const status = job.status || {};
  switch (progress) {
    case 'not-applied': return status.applied !== 'yes';
    case 'applied': return status.applied === 'yes';
    case 'contacted-yes': return status.contacted === 'yes';
    case 'contacted-no': return status.contacted === 'no';
    case 'interview-yes': return status.interview === 'yes';
    case 'interview-no': return status.interview === 'no';
    case 'success': return status.result === 'success';
    case 'fail': return status.result === 'fail';
    default: return true;
  }
}

/**
 * @param {object[]} jobs
 * @param {object} opts
 * @returns {object[]}
 */
export function filterJobs(jobs, opts = {}) {
  const text = String(opts.text ?? '').trim().toLowerCase();
  const minRaw = opts.minScore;
  const min = minRaw == null || minRaw === '' ? null : Number(minRaw);
  const useMin = min != null && Number.isFinite(min);
  return jobs.filter((job) => {
    if (job.skipped && opts.showSkipped !== true) return false;
    if (opts.platform && opts.platform !== 'all' && job.platform !== opts.platform) return false;
    if (opts.section && opts.section !== 'all' && job.section !== opts.section) return false;
    if (!matchesProgress(job, opts.progress || 'all')) return false;
    if (useMin && (job.score == null || job.score < min)) return false;
    if (!text) return true;
    const hay = [job.company, job.role, job.note, job.location, job.platform, job.salary]
      .join('\n')
      .toLowerCase();
    return hay.includes(text);
  });
}

/**
 * 没分数的排在最后。分数相同则按公司名。
 * @param {object[]} jobs
 * @param {string} key
 * @returns {object[]}
 */
export function sortJobs(jobs, key = 'score-desc') {
  const copy = jobs.slice();
  const byName = (a, b) => String(a.company).localeCompare(String(b.company), 'zh');
  copy.sort((a, b) => {
    if (key === 'company') return byName(a, b) || String(a.role).localeCompare(String(b.role), 'zh');
    const dir = key === 'score-asc' ? 1 : -1;
    if (a.score == null && b.score == null) return byName(a, b);
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    if (a.score !== b.score) return (a.score - b.score) * dir;
    return byName(a, b);
  });
  return copy;
}

/**
 * 统计只算默认会显示的岗位，跳过项单独计数。
 * @param {object[]} jobs
 */
export function summarize(jobs) {
  const active = jobs.filter((job) => !job.skipped);
  return {
    total: active.length,
    skipped: jobs.length - active.length,
    notApplied: active.filter((job) => job.status?.applied !== 'yes').length,
    applied: active.filter((job) => job.status?.applied === 'yes').length,
    success: active.filter((job) => job.status?.result === 'success').length,
    fail: active.filter((job) => job.status?.result === 'fail').length,
  };
}

import { PROGRESS_FILTERS, SECTION_FILTERS, SORTS, filterJobs, sortJobs, summarize } from '/board-view.mjs';

const GROUPS = [
  { field: 'applied', label: '投递', options: [['no', '未投'], ['yes', '已投']] },
  { field: 'contacted', label: '沟通', options: [['yes', '是'], ['no', '否']] },
  { field: 'interview', label: '面试', options: [['yes', '是'], ['no', '否']] },
  { field: 'result', label: '结果', options: [['success', '成功', 'good'], ['fail', '没成', 'bad']] },
];

const statsEl = document.querySelector('#stats');
const toastEl = document.querySelector('#toast');
const listEl = document.querySelector('#list');
const emptyEl = document.querySelector('#empty');
const textEl = document.querySelector('#text');
const platformEl = document.querySelector('#platform');
const sectionEl = document.querySelector('#section');
const progressEl = document.querySelector('#progress');
const sortEl = document.querySelector('#sort');
const minEl = document.querySelector('#min-score');
const skippedEl = document.querySelector('#show-skipped');

/** @type {object[]} */
let jobs = [];
let toastTimer = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fillSelect(select, options, current) {
  while (select.firstChild) select.removeChild(select.firstChild);
  for (const option of options) {
    const node = el('option', '', option.label);
    node.value = option.id;
    select.appendChild(node);
  }
  if (options.some((option) => option.id === current)) select.value = current;
}

function showToast(message, bad) {
  toastEl.hidden = false;
  toastEl.textContent = message;
  toastEl.dataset.bad = bad ? '1' : '0';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

function query() {
  return {
    text: textEl.value,
    platform: platformEl.value,
    section: sectionEl.value,
    progress: progressEl.value,
    minScore: minEl.value,
    showSkipped: skippedEl.checked,
  };
}

function scoreClass(score) {
  if (score == null) return 'score';
  if (score >= 4.5) return 'score high';
  if (score >= 3.5) return 'score mid';
  return 'score low';
}

function renderCard(job) {
  const card = el('article', 'card');
  card.dataset.id = job.id;

  const score = el('div', scoreClass(job.score));
  score.appendChild(el('strong', '', job.score == null ? '—' : String(job.score)));
  score.appendChild(el('span', '', '分'));
  card.appendChild(score);

  const titleRow = el('div', 'title-row');
  const title = job.role || '未填写职位';
  if (/^https?:\/\//i.test(job.url)) {
    const link = el('a', '', title);
    link.href = job.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    titleRow.appendChild(link);
  } else {
    titleRow.appendChild(el('strong', '', title));
  }
  const chip = el('span', `chip ${job.section}`, job.skipped ? '已跳过' : job.sectionLabel);
  titleRow.appendChild(chip);
  card.appendChild(titleRow);

  const bits = [job.company || '未填写公司', job.platform, job.location, job.salary].filter(Boolean);
  card.appendChild(el('p', 'meta', bits.join('  ·  ')));
  if (job.note) card.appendChild(el('p', 'note', job.note));

  const controls = el('div', 'controls');
  for (const group of GROUPS) {
    const row = el('div', 'group');
    row.appendChild(el('span', '', group.label));
    const current = job.status?.[group.field];
    for (const [value, label, tone] of group.options) {
      const button = el('button', '', label);
      button.type = 'button';
      button.dataset.field = group.field;
      button.dataset.value = value;
      if (tone) button.classList.add(tone);
      const pressed = current === value;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      button.addEventListener('click', () => save(job, group.field, value));
      row.appendChild(button);
    }
    controls.appendChild(row);
  }
  card.appendChild(controls);
  return card;
}

function render() {
  const summary = summarize(jobs);
  statsEl.textContent = `共 ${summary.total} 个岗位 · 未投 ${summary.notApplied} · 已投 ${summary.applied} · 成功 ${summary.success} · 没成 ${summary.fail}`
    + (summary.skipped ? ` · 另有 ${summary.skipped} 条已跳过` : '');

  const visible = sortJobs(filterJobs(jobs, query()), sortEl.value || 'score-desc');
  const y = window.scrollY;
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  for (const job of visible) listEl.appendChild(renderCard(job));
  emptyEl.hidden = visible.length > 0;
  if (jobs.length === 0) {
    emptyEl.textContent = '还没有岗位。让助手先把抓到的职位写进 data/pipeline.md，再点刷新。';
  } else if (visible.length === 0) {
    emptyEl.textContent = '没有符合当前筛选的岗位。可以清空搜索，或勾选「显示已跳过」。';
  }
  window.scrollTo(0, y);
}

function lock(id, locked) {
  const card = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  for (const button of card.querySelectorAll('button')) button.disabled = locked;
}

async function save(job, field, value) {
  const next = field !== 'applied' && job.status?.[field] === value ? 'unset' : value;
  lock(job.id, true);
  try {
    const response = await fetch('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, [field]: next }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存失败');
    job.status = data.status;
    showToast('已保存');
  } catch (err) {
    showToast(err.message || '没保存上', true);
    await load();
    return;
  }
  render();
}

async function load() {
  const response = await fetch('/api/jobs');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '读不到岗位');
  jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const platforms = [...new Set(jobs.map((job) => job.platform).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
  fillSelect(platformEl, [{ id: 'all', label: '全部平台' }, ...platforms.map((name) => ({ id: name, label: name }))], platformEl.value || 'all');
  fillSelect(sectionEl, SECTION_FILTERS, sectionEl.value || 'all');
  fillSelect(progressEl, PROGRESS_FILTERS, progressEl.value || 'all');
  fillSelect(sortEl, SORTS, sortEl.value || 'score-desc');
  render();
}

for (const node of [textEl, platformEl, sectionEl, progressEl, sortEl, minEl, skippedEl]) {
  node.addEventListener('input', render);
  node.addEventListener('change', render);
}

document.querySelector('#reload').addEventListener('click', () => {
  load().then(() => showToast('列表已刷新')).catch((err) => showToast(err.message, true));
});

load().catch((err) => {
  statsEl.textContent = '看板没有打开。';
  emptyEl.hidden = false;
  emptyEl.textContent = err.message || '读不到岗位。';
});

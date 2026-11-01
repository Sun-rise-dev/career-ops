// 职位看板怎么读 pipeline.md，以及页面默认怎样藏起已跳过的行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySection, extractScore, parsePipeline } from '../job-board/parse-pipeline.mjs';
import { filterJobs, sortJobs, summarize } from '../job-board/board-view.mjs';
import { blankStatus } from '../job-board/status-store.mjs';

const SAMPLE = `# Pipeline — 初筛（2026-09-04）

## Pending（建议你自己投 / 开聊）

### BOSS 直聘

- [ ] https://www.zhipin.com/job_detail/example-one.html | 示例互动 | AI工作流解决方案交付（Dify/Coze/Agent） | 北京·海淀 | 约11-20K | note: triage 4.8/5 PASS；ToB 客户交付；硬性要求 Coze/Dify/n8n
- [ ] https://www.zhipin.com/job_detail/example-two.html | 示例学园 | ai实施工程师 | 北京·望京 | 约15-25K·14薪 | note: triage 3.8/5 PASS；飞书妙搭/Aily 搭工作流

### 智联招聘

- [ ] https://www.zhaopin.com/jobdetail/example-three.htm | 示例科技 | AI产品助理(FDE方向) | 北京·石景山 | 约10-13K | note: triage 4.5/5 PASS；Coze/Dify/Cursor 搭智能体与工作流

## Marginal（先不投，除非你想看）

### BOSS 直聘

- [ ] https://www.zhipin.com/job_detail/example-four.html | 示例头条 | AI智能体工程师 | 北京·朝阳 | 约8-11K | note: triage 3.2/5；JD 贴但薪资踩 10k 底线，偏内部

## Processed / 跳过

- [x] BOSS | 求职期望「实施工程师」默认列表 | skipped（电力/ERP/AGV/SAP 居多）
`;

test('样例 pipeline 解析出 4 条岗位，没有链接的跳过行不进列表', () => {
  const jobs = parsePipeline(SAMPLE);
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map((job) => job.company), ['示例互动', '示例学园', '示例科技', '示例头条']);
  assert.equal(jobs[0].role, 'AI工作流解决方案交付（Dify/Coze/Agent）');
  assert.equal(jobs[0].platform, 'BOSS 直聘');
  assert.equal(jobs[0].location, '北京·海淀');
  assert.equal(jobs[0].salary, '约11-20K');
  assert.equal(jobs[0].score, 4.8);
  assert.equal(jobs[0].section, 'pending');
  assert.equal(jobs[0].sectionLabel, '建议投');
  assert.equal(jobs[0].skipped, false);
  assert.match(jobs[0].note, /^triage 4\.8\/5 PASS/);
  assert.equal(jobs[0].note.includes('note:'), false);
  assert.equal(jobs[2].platform, '智联招聘');
  assert.equal(jobs[2].score, 4.5);
  assert.equal(jobs[3].section, 'marginal');
  assert.equal(jobs[3].sectionLabel, '先不投');
  assert.equal(jobs[3].score, 3.2);
  assert.equal(jobs.some((job) => job.company === 'BOSS'), false);
});

test('缺字段、Windows 换行、已处理和划掉的行都不会把解析打断', () => {
  const text = [
    '## Pending',
    '- [ ] https://example.com/jobs/only-url',
    '- [ ] https://example.com/jobs/company-only | 只有公司',
    '- [ ] https://jobs.example.com/posting/789 | 极客科技 | AI 研发工程师 | 远程 | note: 没有分数',
    '- [x] #143 | https://jobs.example.com/done/1 | 极客科技 | AI 研发工程师 | 4.2/5 | PDF ✅',
    '- [!] https://private.example/job | 隐藏公司 | 秘密职位 — 需要登录',
    '- [ ] ~~https://example.com/expired | 过期公司 | 过期职位~~',
    '  - [ ] https://www.zhaopin.com/jobdetail/abc.htm | 域名平台 | 实施',
    '- [ ] 只有文字没有链接 | 不该出现',
  ].join('\r\n');
  const jobs = parsePipeline(text);
  assert.equal(jobs.length, 7);
  assert.equal(jobs[0].company, '');
  assert.equal(jobs[0].role, '');
  assert.equal(jobs[0].score, null);
  assert.equal(jobs[0].skipped, false);
  assert.equal(jobs[1].company, '只有公司');
  assert.equal(jobs[1].role, '');
  assert.equal(jobs[2].salary, '');
  assert.equal(jobs[2].location, '远程');
  assert.equal(jobs[2].score, null);
  const done = jobs.find((job) => job.url.includes('/done/1'));
  assert.equal(done.skipped, true);
  assert.equal(done.score, 4.2);
  assert.equal(done.company, '极客科技');
  const broken = jobs.find((job) => job.url.includes('private.example'));
  assert.equal(broken.skipped, true);
  assert.equal(broken.fetchError, true);
  const expired = jobs.find((job) => job.company === '过期公司');
  assert.equal(expired.skipped, true);
  assert.equal(expired.expired, true);
  const guessed = jobs.find((job) => job.company === '域名平台');
  assert.equal(guessed.platform, '智联招聘');
});

test('同一条链接再次出现为未勾选时，不再当成跳过', () => {
  const text = [
    '- [x] https://example.com/jobs/1?utm_source=newsletter | 甲公司 | 旧标题',
    '- [ ] https://example.com/jobs/1 | 甲公司 | 新标题',
  ].join('\n');
  const jobs = parsePipeline(text);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].skipped, false);
  assert.equal(jobs[0].role, '新标题');
  assert.equal(jobs[0].id.includes('utm_source'), false);
});

test('分数只接受 0 到 5', () => {
  assert.equal(extractScore('triage 4.8/5 PASS'), 4.8);
  assert.equal(extractScore('9/5'), null);
  assert.equal(extractScore(''), null);
  assert.equal(classifySection('Processed / 跳过').id, 'processed');
});

test('已跳过的岗位默认不出现，打开开关才出现', () => {
  const jobs = parsePipeline([
    '- [ ] https://example.com/live | 在招 | 工程师 | note: 4.0/5',
    '- [x] https://example.com/skip | 跳过 | 工程师 | note: 2.0/5',
  ].join('\n')).map((job) => ({ ...job, status: blankStatus() }));
  const visible = filterJobs(jobs, {});
  assert.equal(visible.length, 1);
  assert.equal(visible[0].company, '在招');
  assert.equal(filterJobs(jobs, { showSkipped: true }).length, 2);
  const high = sortJobs(filterJobs(jobs, { showSkipped: true, minScore: 3 }), 'score-desc');
  assert.deepEqual(high.map((job) => job.company), ['在招']);
  const summary = summarize(jobs);
  assert.equal(summary.total, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.notApplied, 1);
});

test('可以按进度和关键字筛选，没分数的排在最后', () => {
  const jobs = [
    { company: '乙', role: '实施', note: '', location: '上海', platform: '猎聘', salary: '', score: null, skipped: false, section: 'pending', status: { applied: 'yes', contacted: 'yes', interview: 'no', result: 'unset' } },
    { company: '甲', role: '产品', note: 'Coze', location: '北京', platform: 'BOSS 直聘', salary: '10K', score: 4.8, skipped: false, section: 'pending', status: blankStatus() },
    { company: '丙', role: '助理', note: '', location: '', platform: 'BOSS 直聘', salary: '', score: 3, skipped: false, section: 'marginal', status: { ...blankStatus(), applied: 'yes', result: 'fail' } },
  ];
  assert.deepEqual(sortJobs(jobs, 'score-desc').map((job) => job.company), ['甲', '丙', '乙']);
  assert.deepEqual(sortJobs(jobs, 'score-asc').map((job) => job.company), ['丙', '甲', '乙']);
  assert.deepEqual(filterJobs(jobs, { text: 'coze' }).map((job) => job.company), ['甲']);
  assert.deepEqual(filterJobs(jobs, { progress: 'contacted-yes' }).map((job) => job.company), ['乙']);
  assert.deepEqual(filterJobs(jobs, { progress: 'fail', platform: 'BOSS 直聘' }).map((job) => job.company), ['丙']);
  assert.deepEqual(filterJobs(jobs, { section: 'marginal' }).map((job) => job.company), ['丙']);
});

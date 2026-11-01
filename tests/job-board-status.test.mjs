// 职位看板的进度要写进文件，关掉服务再打开还在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyStatusPatch,
  blankStatus,
  loadStatus,
  updateJobStatus,
  StatusStoreError,
} from '../job-board/status-store.mjs';
import { isLoopback, startJobBoard } from '../job-board/server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, 'job-board', 'server.mjs');
const JOB = 'https://www.zhipin.com/job_detail/example-one.html';

const PIPELINE = `# Pipeline

## Pending（建议你自己投）

### BOSS 直聘

- [ ] ${JOB} | 示例互动 | AI工作流 | 北京·海淀 | 约11-20K | note: triage 4.8/5 PASS
- [x] https://example.com/skipped | 跳过公司 | 跳过职位
`;

function tempBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'job-board-'));
  const pipelinePath = join(dir, 'pipeline.md');
  const statusPath = join(dir, 'job-board-status.json');
  writeFileSync(pipelinePath, PIPELINE);
  return {
    dir,
    pipelinePath,
    statusPath,
    cleanup() { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

test('勾选沟通会自动标成已投；改回未投会清空后面的记录', () => {
  const contacted = applyStatusPatch(blankStatus(), { contacted: 'yes' });
  assert.equal(contacted.applied, 'yes');
  assert.equal(contacted.contacted, 'yes');
  assert.equal(typeof contacted.updatedAt, 'string');

  const cleared = applyStatusPatch(contacted, { applied: 'no', contacted: 'yes' });
  assert.deepEqual(
    { applied: cleared.applied, contacted: cleared.contacted, interview: cleared.interview, result: cleared.result },
    { applied: 'no', contacted: 'unset', interview: 'unset', result: 'unset' },
  );

  assert.throws(() => applyStatusPatch(blankStatus(), { result: 'maybe' }), StatusStoreError);
  assert.throws(() => applyStatusPatch(blankStatus(), {}), StatusStoreError);
});

test('进度写入 JSON，重新读出来还在；坏文件不会被盖掉', () => {
  const board = tempBoard();
  try {
    const saved = updateJobStatus(board.statusPath, 'https://example.com/jobs/1', { interview: 'yes', result: 'success' });
    assert.equal(saved.applied, 'yes');
    assert.equal(saved.interview, 'yes');
    assert.equal(saved.result, 'success');

    const loaded = loadStatus(board.statusPath);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.byUrl['https://example.com/jobs/1'].result, 'success');
    const roundTrip = JSON.parse(readFileSync(board.statusPath, 'utf8'));
    assert.equal(roundTrip.byUrl['https://example.com/jobs/1'].interview, 'yes');

    const again = updateJobStatus(board.statusPath, 'https://example.com/jobs/1', { result: 'fail' });
    assert.equal(again.interview, 'yes');
    assert.equal(again.result, 'fail');
    assert.equal(loadStatus(board.statusPath).byUrl['https://example.com/jobs/1'].result, 'fail');
  } finally {
    board.cleanup();
  }
});

test('损坏的进度文件会拒绝写入，原内容保留', () => {
  const board = tempBoard();
  try {
    writeFileSync(board.statusPath, '{');
    assert.throws(
      () => updateJobStatus(board.statusPath, 'https://example.com/jobs/1', { applied: 'yes' }),
      (err) => err instanceof StatusStoreError && err.code === 'CORRUPT',
    );
    assert.equal(readFileSync(board.statusPath, 'utf8'), '{');
    assert.throws(() => loadStatus(board.statusPath), StatusStoreError);
  } finally {
    board.cleanup();
  }
});

test('无效选项不会创建进度文件', () => {
  const board = tempBoard();
  try {
    assert.throws(
      () => updateJobStatus(board.statusPath, 'https://example.com/jobs/1', { result: 'maybe' }),
      StatusStoreError,
    );
    assert.equal(existsSync(board.statusPath), false);
  } finally {
    board.cleanup();
  }
});

test('通过页面接口改进度，重启服务后仍然在', async () => {
  const board = tempBoard();
  let first;
  let second;
  try {
    first = await startJobBoard({ pipelinePath: board.pipelinePath, statusPath: board.statusPath, port: 0 });
    const posted = await fetch(`${first.url}api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: JOB, contacted: 'yes' }),
    });
    const saved = await posted.json();
    assert.equal(posted.status, 200, JSON.stringify(saved));
    assert.equal(saved.status.applied, 'yes');
    assert.equal(saved.status.contacted, 'yes');
    await first.close();
    first = null;

    second = await startJobBoard({ pipelinePath: board.pipelinePath, statusPath: board.statusPath, port: 0 });
    const listed = await fetch(`${second.url}api/jobs`).then((response) => response.json());
    const job = listed.jobs.find((item) => item.company === '示例互动');
    assert.ok(job, '重启后应该还能看到这条岗位');
    assert.equal(job.score, 4.8);
    assert.equal(job.platform, 'BOSS 直聘');
    assert.equal(job.status.contacted, 'yes');
    assert.equal(job.status.applied, 'yes');
    const skipped = listed.jobs.find((item) => item.company === '跳过公司');
    assert.equal(skipped.skipped, true);

    const rejected = await fetch(`${second.url}api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, result: 'maybe' }),
    });
    assert.equal(rejected.status, 400);
    const still = loadStatus(board.statusPath).byUrl[job.id];
    assert.equal(still.contacted, 'yes');
    assert.equal(still.result, 'unset');
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    board.cleanup();
  }
});

test('只接受本机地址', async () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('192.168.1.8'), false);
  await assert.rejects(
    () => startJobBoard({ pipelinePath: 'x', statusPath: 'y', host: '0.0.0.0', port: 0 }),
    /127\.0\.0\.1/,
  );
});

function runServer(...args) {
  const result = spawnSync(process.execPath, [SERVER, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.signal);
  return result;
}

test('--help 打印用法并退出', () => {
  const result = runServer('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /127\.0\.0\.1/);
  assert.match(result.stdout, /job-board-status\.json/);
});

test('不认识的参数会失败，不会把服务开起来', () => {
  const result = runServer('--bogus');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--bogus/);
  const both = runServer('--help', '--bogus');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--bogus/);
});

test('非法端口会失败', () => {
  const result = runServer('--port', '0');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /端口/);
});

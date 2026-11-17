// A settled strategy task only changes through its persisted revision, so
// re-projecting it on every status read is pure waste: `GET /api/runs` polls
// every 4 seconds and `GET /api/runs/:id` roughly once a second while a
// conversation attaches, and each call costs one `strategy_task_executions`
// lookup plus the display JOIN plus the delivery-row/receipt reads.
//
// The projection + telemetry pair is memoized per (taskExecutionId, revision,
// runId) for terminal tasks only; a task transition (revision bump) must
// recompute, and a settlement revision must be reflected in the next read.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { strategyPackageHashFromDigests } from '@open-design/plugin-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, openDatabase } from '../src/db.js';
import { createSnapshot } from '../src/plugins/snapshots.js';
import { registerRunRoutes } from '../src/routes/runs.js';
import { createChatRunService } from '../src/runtimes/runs.js';
import {
  compareAndTransitionStrategyTaskExecution,
  createStrategyTaskExecution,
  getStrategyTaskExecutionByRunId,
} from '../src/strategies/task-store.js';
import { strategyTaskCreateIdentityFixture } from './strategies/strategy-task-test-fixtures.js';

const PROJECT = 'telemetry-cache-project';
const CONVERSATION = 'telemetry-cache-conversation';

let tempDir: string | undefined;
let server: http.Server | undefined;

async function closeHttp() {
  if (!server) return;
  const current = server;
  server = undefined;
  await new Promise<void>((resolve) => {
    current.close(() => resolve());
    current.closeAllConnections();
  });
}

afterEach(async () => {
  await closeHttp();
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function newRuns(root: string) {
  return createChatRunService({
    createSseResponse: () => ({ send: () => true, end() {}, cleanup() {} }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    runsLogDir: path.join(root, 'runs') as unknown as null,
  });
}

function seedStrategyRun(db: ReturnType<typeof openDatabase>, runs: ReturnType<typeof newRuns>, name: string, settle: boolean) {
  const taskExecutionId = `telemetry-cache-task-${name}`;
  const assetDigests = [
    { path: './SKILL.md', sha256: 'a'.repeat(64) },
    { path: './assets/task-profiles/prototype.md', sha256: 'b'.repeat(64) },
  ];
  const snapshot = createSnapshot(db, {
    projectId: PROJECT,
    conversationId: CONVERSATION,
    runId: null,
    pluginId: 'od-next-strategy',
    pluginVersion: '2.0.0',
    manifestSourceDigest: `telemetry-cache-${name}`,
    strategy: {
      schema: 'open-design.applied-strategy/v2', id: 'od-next-strategy', version: '2.0.0',
      packageHash: strategyPackageHashFromDigests(assetDigests), assetDigests,
      selectedTaskProfile: {
        taskType: 'prototype', version: '2.0.0', path: './assets/task-profiles/prototype.md',
        sha256: 'b'.repeat(64),
      },
      taskProfileVersions: ['2.0.0'], promptRecipe: 'od-next-plan-build-v2',
    },
    taskKind: 'new-generation', inputs: {}, resolvedContext: { items: [] },
    capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'],
    assetsStaged: [], connectorsRequired: [], connectorsResolved: [], mcpServers: [],
  });
  const identity = strategyTaskCreateIdentityFixture();
  const run = runs.create({
    projectId: PROJECT,
    conversationId: CONVERSATION,
    assistantMessageId: `telemetry-cache-assistant-${name}`,
    agentId: 'codex',
    appliedPluginSnapshotId: snapshot.snapshotId,
    odNextTaskInputSnapshot: {
      taskExecutionId,
      snapshotDir: path.join(tempDir!, 'task-input'),
      manifestSha256: identity.taskInputManifestSha256,
    },
  });
  const task = createStrategyTaskExecution(db, {
    taskExecutionId,
    projectId: PROJECT,
    conversationId: CONVERSATION,
    snapshotId: snapshot.snapshotId,
    selectedAgentId: 'codex',
    initialRunId: run.id,
    ...identity,
  });
  if (settle) {
    compareAndTransitionStrategyTaskExecution(db, {
      taskExecutionId,
      expectedRevision: task.revision,
      to: { route: 'full_plan', inputStage: 'request', outcome: 'blocked', executionMode: null },
      blockedContext: { reasonCodes: [`reason_${name}`], visibleText: `Blocked ${name}.` },
    });
  }
  runs.setDeliverableValidation(run, { valid: false, validation: 'no_artifact' });
  runs.finish(run, 'succeeded', 0, null);
  return { runId: run.id, taskExecutionId };
}

async function serve(db: ReturnType<typeof openDatabase>, runs: ReturnType<typeof newRuns>, root: string, telemetrySpy: () => void) {
  const app = express();
  app.use(express.json());
  registerRunRoutes(app, {
    db,
    design: { runs, analytics: { capture() {} }, getAppVersion: () => 'test' },
    http: {
      createSseResponse: () => ({ send() {}, end() {}, cleanup() {} }),
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    },
    paths: { PROJECTS_DIR: path.join(root, 'projects'), RUNTIME_DATA_DIR: root },
    agents: { detectAgents: async () => [], getAgentDef: () => null },
    chat: { startChatRun: async () => undefined },
    plugins: {
      connectorService: {},
      detectSkillPluginCandidateOnRunSuccess() {},
      firePipelineForRun() {},
      loadPluginRegistryView: async () => ({}),
      renderPluginBriefTemplate: (text: string) => text,
    },
    telemetry: {
      reportRunCompletionTelemetryFallback() {},
      resolveRunProjectKindForAnalytics: () => null,
      runArtifactBaselines: { take: () => undefined },
      runRetryEventsForAnalytics: () => [],
      taskTelemetryForRun: () => { telemetrySpy(); return { status: 'accepted' } as never; },
    },
    messages: {
      pinAssistantMessageOnRunCreate: () => ({ ok: true }),
      reconcileAssistantMessageOnRunEnd() {},
    },
  } as unknown as Parameters<typeof registerRunRoutes>[1]);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener missing');
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(url: string): Promise<any> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json();
}

async function seededWorld(names: string[], settle = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-settled-strategy-'));
  tempDir = root;
  const db = openDatabase(root, { dataDir: root });
  const now = Date.now();
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(PROJECT, 'Settled strategy', 1, 1);
  db.prepare('INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(CONVERSATION, PROJECT, 'Settled strategy', 1, 1);
  const runs = newRuns(root);
  const seeded = names.map((name) => seedStrategyRun(db, runs, name, settle));
  return { root, db, runs, seeded };
}

describe('GET /api/runs memoizes the settled strategy projection + telemetry', () => {
  it('does not re-read telemetry for a settled task on repeat status reads', async () => {
    const { root, db, runs, seeded } = await seededWorld(['a', 'b']);
    const telemetrySpy = vi.fn();
    const base = await serve(db, runs, root, telemetrySpy);

    const readA = async () => readJson(`${base}/api/runs/${seeded[0]!.runId}`);
    await readA();
    expect(telemetrySpy).toHaveBeenCalledTimes(1);

    await readA();
    expect(telemetrySpy).toHaveBeenCalledTimes(1);

    const listOnce = async () => {
      const response = await fetch(`${base}/api/runs?projectId=${PROJECT}`);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ runs: Array<{ id: string }> }>;
    };
    await listOnce();
    // One warm task already project-cached, one fresh: exactly one new read.
    expect(telemetrySpy).toHaveBeenCalledTimes(2);
    await listOnce();
    expect(telemetrySpy).toHaveBeenCalledTimes(2);
  });

  it('re-projects once the task settles (revision bump) and caches the settled verdict', async () => {
    const { root, db, runs, seeded } = await seededWorld(['a'], false);
    const telemetrySpy = vi.fn();
    const base = await serve(db, runs, root, telemetrySpy);

    const running = await readJson(`${base}/api/runs/${seeded[0]!.runId}`);
    expect(running.strategyTask?.terminal).toBe(false);
    expect(telemetrySpy).toHaveBeenCalledTimes(1);

    // A running task is never cached, so the live verdict stays honest.
    await readJson(`${base}/api/runs/${seeded[0]!.runId}`);
    expect(telemetrySpy).toHaveBeenCalledTimes(2);

    const settled = getStrategyTaskExecutionByRunId(db, seeded[0]!.runId);
    compareAndTransitionStrategyTaskExecution(db, {
      taskExecutionId: seeded[0]!.taskExecutionId,
      expectedRevision: settled!.revision,
      to: { route: 'full_plan', inputStage: 'request', outcome: 'blocked', executionMode: null },
      blockedContext: { reasonCodes: ['reason_a'], visibleText: 'Blocked.' },
    });

    const fresh = await readJson(`${base}/api/runs/${seeded[0]!.runId}`);
    expect(fresh.strategyTask?.terminal).toBe(true);
    expect(fresh.strategyTask?.blockedContext?.reasonCodes).toEqual(['reason_a']);
    expect(telemetrySpy).toHaveBeenCalledTimes(3);

    // Settled reads reuse the revision-keyed projection.
    await readJson(`${base}/api/runs/${seeded[0]!.runId}`);
    expect(telemetrySpy).toHaveBeenCalledTimes(3);
  });
});

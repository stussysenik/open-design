import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

type StartedServer = {
  url: string;
  server: http.Server;
  shutdown: () => Promise<void> | void;
};

describe('PUT /api/projects/:id/tabs', () => {
  let baseUrl: string;
  let shutdown: () => Promise<void> | void;
  let server: http.Server;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await shutdown();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('round-trips the persisted Design Files hidden flag', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tabs-route-hidden', name: 'Tabs Route Hidden' }),
    });
    expect(created.status).toBe(200);

    const saved = await fetch(`${baseUrl}/api/projects/tabs-route-hidden/tabs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabs: [],
        active: '__design_files__',
        browserTabs: [],
        designFilesTabHidden: true,
      }),
    });
    expect(saved.status).toBe(200);

    const loaded = await fetch(`${baseUrl}/api/projects/tabs-route-hidden/tabs`);
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toMatchObject({ designFilesTabHidden: true });
  });

  it('round-trips excluded folder paths', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tabs-route-excluded', name: 'Tabs Route Excluded' }),
    });
    expect(created.status).toBe(200);

    const saved = await fetch(`${baseUrl}/api/projects/tabs-route-excluded/tabs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabs: [],
        active: '__design_files__',
        browserTabs: [],
        excludedFolders: ['vendor', 'node_modules/cache'],
      }),
    });
    expect(saved.status).toBe(200);

    const loaded = await fetch(`${baseUrl}/api/projects/tabs-route-excluded/tabs`);
    await expect(loaded.json()).resolves.toMatchObject({
      excludedFolders: ['vendor', 'node_modules/cache'],
    });
  });
});

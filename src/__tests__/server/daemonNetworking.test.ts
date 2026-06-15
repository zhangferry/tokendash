import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../../server/index.js';
import { listenWithFallback, TOKEN_DASH_HOST } from '../../server/daemon.js';

function listenOnHost(host: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"message":"foreign service"}');
    });
    server.listen(0, host);
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not resolve test listener port'));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.once('error', reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

describe('TokenDash daemon networking', () => {
  it('falls back when the preferred IPv4 loopback port is occupied', async () => {
    const occupied = await listenOnHost(TOKEN_DASH_HOST);
    const tokenDash = await listenWithFallback(createApp(occupied.port), occupied.port);

    try {
      expect(tokenDash.port).toBe(occupied.port + 1);
      const foreign = await fetchJson(`http://${TOKEN_DASH_HOST}:${occupied.port}/api/app-info`);
      const fallback = await fetchJson(`http://${TOKEN_DASH_HOST}:${tokenDash.port}/api/app-info`);

      expect(foreign.status).toBe(200);
      expect(foreign.body).not.toMatchObject({ packageName: '@zhangferry-dev/tokendash' });
      expect(fallback).toMatchObject({
        status: 200,
        body: {
          packageName: '@zhangferry-dev/tokendash',
          version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        },
      });
    } finally {
      await closeServer(tokenDash.server);
      await closeServer(occupied.server);
    }
  });
});

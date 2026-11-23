import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import { Aedes } from 'aedes';
import type { P2PMessage } from './transport';
import { MqttTransport } from './transport';

function randomHex(byteLength: number): string {
  let text = '';
  for (let offset = 0; offset < byteLength; offset += 32_768) {
    const chunk = crypto.getRandomValues(new Uint8Array(Math.min(32_768, byteLength - offset)));
    text += [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return text;
}

describe('MqttTransport chunking and encryption', () => {
  let broker: Aedes;
  let server: NetServer;
  let url = '';

  beforeAll(async () => {
    broker = await Aedes.createBroker({ heartbeatInterval: 1_000 });
    server = createServer((socket) => broker.handle(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('broker did not bind');
    url = `mqtt://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('sends a >60KB uncompressible message and a targeted reply', async () => {
    const options = {
      brokers: [url],
      disableWebRtc: true,
      connectTimeoutMs: 2_000,
      log: () => {},
    };
    const host = new MqttTransport('chunk-host', options);
    const guest = new MqttTransport('chunk-guest', options);
    try {
      await host.connect('CHUNK1');
      await guest.connect('CHUNK1');

      const text = randomHex(100_000);
      const received = Promise.withResolvers<P2PMessage>();
      const unsubscribe = guest.onMessage((_from, message) => received.resolve(message));
      await host.broadcast({ t: 'system', text });
      const message = await received.promise;
      expect(message).toMatchObject({ t: 'system', text });

      const reply = Promise.withResolvers<P2PMessage>();
      const unsubscribeHost = host.onMessage((_from, message2) => reply.resolve(message2));
      await guest.send('chunk-host', { t: 'chat', text: 'p2p 経由の返信' });
      await expect(reply.promise).resolves.toMatchObject({ t: 'chat', text: 'p2p 経由の返信' });

      unsubscribe();
      unsubscribeHost();
      expect(guest.p2pPeers()).toBe(0);
      expect(guest.relayPeers()).toBeGreaterThanOrEqual(1);
    } finally {
      await host.close();
      await guest.close();
    }
  }, 20_000);
});
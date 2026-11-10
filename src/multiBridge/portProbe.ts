/**
 * HAP-NodeJS does not handle a busy TCP port: the listen error is thrown
 * from an unhandled 'error' event and takes the whole child bridge process
 * (all bridges) down. Probe each port first and skip a bridge whose port
 * is taken.
 */

import * as net from 'node:net';

export type PortProbe = (port: number) => Promise<boolean>;

export const isTcpPortFree: PortProbe = (port) => new Promise<boolean>((resolve) => {
  const server = net.createServer();
  server.unref();
  server.once('error', () => resolve(false));
  server.listen({ port, exclusive: true }, () => {
    server.close(() => resolve(true));
  });
});

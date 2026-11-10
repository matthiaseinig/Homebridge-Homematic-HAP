/**
 * HAP-NodeJS does not handle a busy TCP port: the listen error is thrown
 * from an unhandled 'error' event and takes the whole child bridge process
 * (all bridges) down. Probe each port first and skip a bridge whose port
 * is taken.
 */
import * as net from 'node:net';
export const isTcpPortFree = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, exclusive: true }, () => {
        server.close(() => resolve(true));
    });
});
//# sourceMappingURL=portProbe.js.map
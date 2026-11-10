/**
 * HAP-NodeJS does not handle a busy TCP port: the listen error is thrown
 * from an unhandled 'error' event and takes the whole child bridge process
 * (all bridges) down. Probe each port first and skip a bridge whose port
 * is taken.
 */
export type PortProbe = (port: number) => Promise<boolean>;
export declare const isTcpPortFree: PortProbe;

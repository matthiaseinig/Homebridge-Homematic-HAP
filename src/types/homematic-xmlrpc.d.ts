declare module 'homematic-xmlrpc' {
  interface XmlRpcClient {
    methodCall(
      method: string,
      params: unknown[],
      callback: (err: Error | null, value: unknown) => void,
    ): void;
  }

  interface CreateClientOptions {
    host: string;
    port: number;
    path?: string;
    rejectUnauthorized?: boolean;
  }

  export function createClient(opts: CreateClientOptions): XmlRpcClient;
}

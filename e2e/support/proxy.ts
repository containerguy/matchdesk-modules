import http from "node:http";
import net from "node:net";

/**
 * Kleiner Reverse Proxy für den Test. Er spielt die Rolle des Nginx Proxy Manager:
 * `/game-servers/billiard/…` geht an den Billard-Server, alles andere an Matchdesk.
 * So liegen beide unter derselben Adresse (same origin), genau wie im Betrieb.
 */
export type Route = { prefix: string; port: number };

export function startProxy(routes: Route[], fallbackPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const target = (url: string | undefined) => routes.find((route) => (url ?? "/").startsWith(route.prefix))?.port ?? fallbackPort;

  const server = http.createServer((request, response) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: target(request.url), path: request.url, method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  // WebSocket-Upgrade durchreichen (im Nginx Proxy Manager: „Websockets Support“).
  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(target(request.url), "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          })
      });
    });
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

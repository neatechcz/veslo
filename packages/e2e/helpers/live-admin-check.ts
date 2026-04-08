import http from 'node:http';

export type AdminBrowserCallback = {
  code: string;
  sessionId: string;
  redirectUri: string;
};

export type WaitForAdminBrowserCallbackOptions = {
  timeoutMs: number;
  onReady?: (details: { redirectUri: string }) => Promise<void> | void;
};

export async function waitForAdminBrowserCallback(
  options: WaitForAdminBrowserCallbackOptions,
): Promise<AdminBrowserCallback> {
  return new Promise<AdminBrowserCallback>((resolve, reject) => {
    const server = http.createServer();
    let redirectUri = '';
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const timer = setTimeout(() => {
      settle(() => {
        server.close();
        reject(new Error(`Timed out after ${options.timeoutMs}ms waiting for the admin browser callback.`));
      });
    }, options.timeoutMs);

    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname !== '/admin-callback') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code')?.trim() || '';
        const sessionId =
          url.searchParams.get('transactionId')?.trim() ||
          url.searchParams.get('sessionId')?.trim() ||
          '';

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><h1>Admin sign-in received</h1><p>You can return to Codex.</p></body></html>');

        clearTimeout(timer);
        settle(() => {
          server.close();
          resolve({ code, sessionId, redirectUri });
        });
      } catch (error) {
        clearTimeout(timer);
        settle(() => {
          server.close();
          reject(error);
        });
      }
    });

    server.once('error', (error) => {
      clearTimeout(timer);
      settle(() => {
        reject(error);
      });
    });

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        clearTimeout(timer);
        settle(() => {
          server.close();
          reject(new Error('Failed to bind the local admin callback server.'));
        });
        return;
      }

      redirectUri = `http://127.0.0.1:${address.port}/admin-callback`;

      try {
        await options.onReady?.({ redirectUri });
      } catch (error) {
        clearTimeout(timer);
        settle(() => {
          server.close();
          reject(error);
        });
      }
    });
  });
}

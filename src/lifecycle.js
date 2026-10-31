"use strict";
function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}
function installLifecycle(
  server,
  {
    management,
    close,
    onDrain = () => {},
    onClosed = () => {},
    signals = process,
  },
) {
  let pending;
  function shutdown() {
    if (pending) return pending;
    onDrain();
    pending = (async () => {
      await closeServer(server);
      await close(); // Pool.end waits for leased transaction clients to be returned.
      await closeServer(management);
      onClosed();
    })();
    return pending;
  }
  const handler = () =>
    shutdown().catch((error) => {
      console.error("[shutdown]", error.message);
      process.exitCode = 1;
    });
  signals.on("SIGTERM", handler);
  signals.on("SIGINT", handler);
  return {
    shutdown,
    detach: () => {
      signals.off("SIGTERM", handler);
      signals.off("SIGINT", handler);
    },
  };
}
module.exports = { closeServer, installLifecycle };

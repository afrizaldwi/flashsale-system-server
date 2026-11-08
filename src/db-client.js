"use strict";
const { Client } = require("pg");

// Pool's idle listener is removed on checkout. Keep a lifetime listener on
// every Client, including gaps between transaction queries and after release.
class ResilientClient extends Client {
  constructor(options) {
    super(options);
    this.connectionFailure = null;
    this.on("error", (error) => {
      this.connectionFailure ||= error;
      console.error("[DB client] connection failed:", error.message);
    });
  }
  query(...args) {
    if (!this.connectionFailure) return super.query(...args);
    const callback = args.at(-1);
    if (typeof callback === "function") {
      process.nextTick(callback, this.connectionFailure);
      return;
    }
    return Promise.reject(this.connectionFailure);
  }
}
function releaseClient(client, error) {
  client.release(client.connectionFailure || error);
}
module.exports = { ResilientClient, releaseClient };

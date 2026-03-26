import assert from "node:assert/strict";
import test from "node:test";

import { RpClient } from "../dist/client.js";

test("RpClient.close skips graceful client shutdown while connect is still in progress", async () => {
  const client = new RpClient();
  let clientCloseCalls = 0;
  let transportCloseCalls = 0;

  client.client = {
    close: async () => {
      clientCloseCalls += 1;
    },
  };
  client.transport = {
    close: async () => {
      transportCloseCalls += 1;
    },
  };
  client._status = "connecting";

  await client.close();

  assert.equal(clientCloseCalls, 0);
  assert.equal(transportCloseCalls, 1);
  assert.equal(client.status, "disconnected");
});

test("RpClient.close gracefully closes the MCP client after a successful connection", async () => {
  const client = new RpClient();
  let clientCloseCalls = 0;
  let transportCloseCalls = 0;

  client.client = {
    close: async () => {
      clientCloseCalls += 1;
    },
  };
  client.transport = {
    close: async () => {
      transportCloseCalls += 1;
    },
  };
  client._status = "connected";

  await client.close();

  assert.equal(clientCloseCalls, 1);
  assert.equal(transportCloseCalls, 1);
  assert.equal(client.status, "disconnected");
});

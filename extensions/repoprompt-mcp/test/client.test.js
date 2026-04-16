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

test("RpClient.callTool uses the configured default tool timeout", async () => {
  const client = new RpClient();
  let receivedOptions;

  client.client = {
    callTool: async (_request, _metadata, options) => {
      receivedOptions = options;
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
  client.setToolCallTimeoutMs(1234);

  const result = await client.callTool("context_builder");

  assert.deepEqual(receivedOptions, { timeout: 1234 });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
});

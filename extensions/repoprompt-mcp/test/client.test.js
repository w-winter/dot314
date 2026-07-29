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
  assert.equal(client.toolCatalogFreshness, "unavailable");
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
  assert.equal(client.toolCatalogFreshness, "unavailable");
});

test("RpClient.connect does not create a transport after cancellation during initial close", async () => {
  let transportCreations = 0;
  const closeWork = deferred();
  const client = new RpClient({
    createTransport() {
      transportCreations += 1;
      return { close: async () => {} };
    },
    createClient() {
      throw new Error("SDK client must not be created");
    },
  });
  client.close = async () => closeWork.promise;
  const controller = new AbortController();
  const connectPromise = client.connect("fake-rp", [], undefined, undefined, controller.signal);

  controller.abort(new Error("connection lifecycle cancelled"));
  closeWork.resolve();

  await assert.rejects(connectPromise, /connection lifecycle cancelled/u);
  assert.equal(transportCreations, 0);
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

test("RpClient.callTool forwards an AbortSignal with the configured timeout", async () => {
  const client = new RpClient();
  const controller = new AbortController();
  let receivedOptions;

  client.client = {
    callTool: async (_request, _metadata, options) => {
      receivedOptions = options;
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
  client.setToolCallTimeoutMs(1234);

  await client.callTool("context_builder", {}, undefined, controller.signal);

  assert.deepEqual(receivedOptions, { timeout: 1234, signal: controller.signal });
});

test("RpClient.callTool does not record intentional cancellation as a connection error", async () => {
  const client = new RpClient();
  const controller = new AbortController();
  controller.abort();
  client.client = {
    callTool: async () => {
      throw new Error("request cancelled");
    },
  };
  client._status = "connected";

  await assert.rejects(client.callTool("context_builder", {}, undefined, controller.signal), /request cancelled/u);

  assert.equal(client.status, "connected");
  assert.equal(client.error, undefined);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function catalog(...names) {
  return {
    tools: names.map((name) => ({
      name,
      description: `${name} description`,
      inputSchema: { type: "object" },
    })),
  };
}

function createConnectionControl(responses, options = {}) {
  const events = [];
  let notificationHandler;
  let listToolsCalls = 0;
  let activeListToolsCalls = 0;
  let maxActiveListToolsCalls = 0;
  let clientCloseCalls = 0;
  let transportCloseCalls = 0;

  const client = {
    setNotificationHandler(_schema, handler) {
      events.push("setNotificationHandler");
      notificationHandler = handler;
      if (options.notificationRegistrationError) {
        throw options.notificationRegistrationError;
      }
    },
    async connect() {
      events.push("connect");
    },
    async listTools() {
      listToolsCalls += 1;
      activeListToolsCalls += 1;
      maxActiveListToolsCalls = Math.max(maxActiveListToolsCalls, activeListToolsCalls);

      try {
        const response = responses.shift();
        assert.notEqual(response, undefined, "unexpected listTools call");
        if (response instanceof Error) {
          throw response;
        }
        return await response;
      } finally {
        activeListToolsCalls -= 1;
      }
    },
    async close() {
      clientCloseCalls += 1;
    },
  };

  const transport = {
    async close() {
      transportCloseCalls += 1;
    },
  };

  return {
    client,
    transport,
    events,
    get listToolsCalls() {
      return listToolsCalls;
    },
    get maxActiveListToolsCalls() {
      return maxActiveListToolsCalls;
    },
    get clientCloseCalls() {
      return clientCloseCalls;
    },
    get transportCloseCalls() {
      return transportCloseCalls;
    },
    notifyToolListChanged() {
      assert.ok(notificationHandler, "tool-list notification handler should be registered");
      notificationHandler({ method: "notifications/tools/list_changed" });
    },
  };
}

function createClientWithConnections(...connections) {
  let clientIndex = 0;
  let transportIndex = 0;

  return new RpClient({
    createClient() {
      const connection = connections[clientIndex];
      clientIndex += 1;
      assert.ok(connection, "unexpected SDK client creation");
      return connection.client;
    },
    createTransport() {
      const connection = connections[transportIndex];
      transportIndex += 1;
      assert.ok(connection, "unexpected transport creation");
      return connection.transport;
    },
  });
}

test("RpClient registers tool-list notifications before connecting and refreshes the catalog", async () => {
  const connection = createConnectionControl([
    catalog("app_settings"),
    catalog("app_settings", "get_file_tree"),
  ]);
  const client = createClientWithConnections(connection);

  await client.connect("fake-rp", []);
  assert.deepEqual(connection.events, ["setNotificationHandler", "connect"]);
  assert.deepEqual(client.tools.map((tool) => tool.name), ["app_settings"]);
  assert.equal(client.toolCatalogFreshness, "fresh");
  assert.equal(client.getConnectionInfo()?.toolCatalogFreshness, "fresh");

  connection.notifyToolListChanged();
  await client.refreshTools();

  assert.equal(connection.listToolsCalls, 2);
  assert.deepEqual(client.tools.map((tool) => tool.name), ["app_settings", "get_file_tree"]);
  assert.equal(client.toolCatalogFreshness, "fresh");
});

test("RpClient discards a tool list invalidated in flight and coalesces refresh callers", async () => {
  const staleResponse = deferred();
  const connection = createConnectionControl([
    catalog("app_settings"),
    staleResponse.promise,
    catalog("app_settings", "agent_manage"),
  ]);
  const client = createClientWithConnections(connection);
  await client.connect("fake-rp", []);

  const firstRefresh = client.refreshTools();
  const secondRefresh = client.refreshTools();
  connection.notifyToolListChanged();
  staleResponse.resolve(catalog("app_settings", "stale_tool"));

  const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);

  assert.equal(connection.listToolsCalls, 3);
  assert.equal(connection.maxActiveListToolsCalls, 1);
  assert.deepEqual(firstResult, secondResult);
  assert.deepEqual(client.tools.map((tool) => tool.name), ["app_settings", "agent_manage"]);
  assert.equal(client.toolCatalogFreshness, "fresh");
});

test("RpClient drains a notification received at the initial catalog handoff before connecting", async () => {
  const connection = createConnectionControl([
    catalog("app_settings"),
    catalog("app_settings", "get_file_tree"),
  ]);
  const client = createClientWithConnections(connection);
  const refreshTools = client.refreshTools.bind(client);
  let emitAtFirstHandoff = true;

  client.refreshTools = async (...args) => {
    const tools = await refreshTools(...args);
    if (emitAtFirstHandoff) {
      emitAtFirstHandoff = false;
      connection.notifyToolListChanged();
    }
    return tools;
  };

  await client.connect("fake-rp", []);

  assert.equal(connection.listToolsCalls, 2);
  assert.equal(connection.maxActiveListToolsCalls, 1);
  assert.deepEqual(client.tools.map((tool) => tool.name), ["app_settings", "get_file_tree"]);
  assert.equal(client.status, "connected");
  assert.equal(client.toolCatalogFreshness, "fresh");
});

test("RpClient continues to the newest generation when an older list request fails", async () => {
  const obsoleteResponse = deferred();
  const connection = createConnectionControl([
    catalog("app_settings"),
    obsoleteResponse.promise,
    catalog("app_settings", "context_builder"),
  ]);
  const client = createClientWithConnections(connection);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);

  try {
    await client.connect("fake-rp", []);

    connection.notifyToolListChanged();
    const sharedRefresh = client.refreshTools();
    connection.notifyToolListChanged();
    obsoleteResponse.reject(new Error("obsolete generation failed"));

    const tools = await sharedRefresh;

    assert.equal(connection.listToolsCalls, 3);
    assert.equal(connection.maxActiveListToolsCalls, 1);
    assert.deepEqual(tools.map((tool) => tool.name), ["app_settings", "context_builder"]);
    assert.equal(client.toolCatalogFreshness, "fresh");
    assert.equal(client.error, undefined);
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
  }
});

test("RpClient ignores old-epoch success failure and notification", async () => {
  for (const settlement of ["success", "failure"]) {
    const oldResponse = deferred();
    const oldConnection = createConnectionControl([catalog("classic_tool"), oldResponse.promise]);
    const newConnection = createConnectionControl([catalog("ce_tool")]);
    const client = createClientWithConnections(oldConnection, newConnection);

    await client.connect("classic-rp", []);
    const oldRefresh = client.refreshTools();
    await client.close();
    await client.connect("ce-rp", []);
    oldConnection.notifyToolListChanged();

    if (settlement === "success") {
      oldResponse.resolve(catalog("stale_classic_tool"));
    } else {
      oldResponse.reject(new Error("old connection failed"));
    }

    await assert.rejects(oldRefresh, /connection changed/u);
    assert.equal(oldConnection.listToolsCalls, 2);
    assert.deepEqual(client.tools.map((tool) => tool.name), ["ce_tool"]);
    assert.equal(client.status, "connected");
    assert.equal(client.toolCatalogFreshness, "fresh");
    assert.equal(client.error, undefined);
  }
});

test("RpClient marks the retained catalog stale after a current-generation background failure", async () => {
  const connection = createConnectionControl([
    catalog("app_settings"),
    new Error("catalog unavailable"),
    catalog("app_settings", "context_builder"),
  ]);
  const client = createClientWithConnections(connection);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);

  try {
    await client.connect("fake-rp", [], { SECRET_TOKEN: "do-not-log" });

    connection.notifyToolListChanged();
    assert.equal(client.toolCatalogFreshness, "stale");
    await assert.rejects(client.refreshTools(), /catalog unavailable/u);

    assert.equal(client.status, "connected");
    assert.deepEqual(client.tools.map((tool) => tool.name), ["app_settings"]);
    assert.equal(client.toolCatalogFreshness, "stale");
    assert.equal(client.error, "catalog unavailable");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /epoch \d+, generation 1, observed 1/u);
    assert.doesNotMatch(warnings[0], /do-not-log/u);

    connection.notifyToolListChanged();
    await client.refreshTools();
    assert.deepEqual(client.tools.map((tool) => tool.name), ["app_settings", "context_builder"]);
    assert.equal(client.toolCatalogFreshness, "fresh");
    assert.equal(client.error, undefined);
  } finally {
    console.warn = originalWarn;
  }
});

test("RpClient recovers after transport factory failure", async () => {
  const successfulConnection = createConnectionControl([catalog("app_settings")]);
  let transportFactoryCalls = 0;
  const client = new RpClient({
    createTransport() {
      transportFactoryCalls += 1;
      if (transportFactoryCalls === 1) {
        throw new Error("transport factory failed");
      }
      return successfulConnection.transport;
    },
    createClient() {
      return successfulConnection.client;
    },
  });

  await assert.rejects(client.connect("fake-rp", []), /transport factory failed/u);

  assert.equal(client.status, "disconnected");
  assert.equal(client.toolCatalogFreshness, "unavailable");
  assert.equal(client.error, "transport factory failed");
  assert.equal(successfulConnection.clientCloseCalls, 0);
  assert.equal(successfulConnection.transportCloseCalls, 0);

  await client.connect("fake-rp", []);
  assert.equal(client.status, "connected");
  assert.equal(client.toolCatalogFreshness, "fresh");
  assert.equal(client.error, undefined);
});

test("RpClient closes transport and recovers after client factory failure", async () => {
  const failedTransport = createConnectionControl([]).transport;
  let failedTransportCloseCalls = 0;
  failedTransport.close = async () => {
    failedTransportCloseCalls += 1;
  };
  const successfulConnection = createConnectionControl([catalog("app_settings")]);
  const transports = [failedTransport, successfulConnection.transport];
  let clientFactoryCalls = 0;

  const client = new RpClient({
    createTransport() {
      const transport = transports.shift();
      assert.ok(transport, "unexpected transport creation");
      return transport;
    },
    createClient() {
      clientFactoryCalls += 1;
      if (clientFactoryCalls === 1) {
        throw new Error("client factory failed");
      }
      return successfulConnection.client;
    },
  });

  await assert.rejects(client.connect("fake-rp", []), /client factory failed/u);

  assert.equal(failedTransportCloseCalls, 1);
  assert.equal(successfulConnection.clientCloseCalls, 0);
  assert.equal(client.status, "disconnected");
  assert.equal(client.toolCatalogFreshness, "unavailable");

  await client.connect("fake-rp", []);
  assert.equal(client.status, "connected");
  assert.equal(client.toolCatalogFreshness, "fresh");
});

test("RpClient closes client and transport and recovers after notification registration failure", async () => {
  const failedConnection = createConnectionControl(
    [catalog("unused")],
    { notificationRegistrationError: new Error("notification registration failed") }
  );
  const successfulConnection = createConnectionControl([catalog("app_settings")]);
  const client = createClientWithConnections(failedConnection, successfulConnection);

  await assert.rejects(client.connect("fake-rp", []), /notification registration failed/u);

  assert.equal(failedConnection.clientCloseCalls, 1);
  assert.equal(failedConnection.transportCloseCalls, 1);
  assert.equal(client.status, "disconnected");
  assert.equal(client.toolCatalogFreshness, "unavailable");
  assert.equal(client.error, "notification registration failed");

  await client.connect("fake-rp", []);
  failedConnection.notifyToolListChanged();

  assert.equal(failedConnection.listToolsCalls, 0);
  assert.deepEqual(client.tools.map((tool) => tool.name), ["app_settings"]);
  assert.equal(client.status, "connected");
  assert.equal(client.toolCatalogFreshness, "fresh");
  assert.equal(client.error, undefined);
});

test("RpClient initial catalog failure leaves no authoritative catalog", async () => {
  const connection = createConnectionControl([new Error("initial catalog unavailable")]);
  const client = createClientWithConnections(connection);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);

  try {
    await assert.rejects(client.connect("fake-rp", []), /initial catalog unavailable/u);

    assert.equal(client.status, "disconnected");
    assert.deepEqual(client.tools, []);
    assert.equal(client.toolCatalogFreshness, "unavailable");
    assert.equal(client.error, "initial catalog unavailable");
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
  }
});

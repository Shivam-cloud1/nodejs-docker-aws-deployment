const { createApp } = require("../src/app");

function createMemoryClient() {
  const items = new Map();
  return {
    async send(command) {
      const { input } = command;
      switch (command.constructor.name) {
        case "ScanCommand":
          return { Items: [...items.values()] };
        case "GetCommand":
          return { Item: items.get(input.Key.id) };
        case "PutCommand":
          items.set(input.Item.id, input.Item);
          return {};
        case "DeleteCommand": {
          const previous = items.get(input.Key.id);
          items.delete(input.Key.id);
          return { Attributes: previous };
        }
        default:
          throw new Error(`Unexpected command: ${command.constructor.name}`);
      }
    },
  };
}

async function withServer(app, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("items API", () => {
  it("supports item create, read, update, list, and delete", async () => {
    const app = createApp(createMemoryClient(), "items");

    await withServer(app, async (baseUrl) => {
      const createdResponse = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "  sample  ", description: " first " }),
      });
      expect(createdResponse.status).toBe(201);
      const item = await createdResponse.json();
      expect(item.name).toBe("sample");
      expect(item.description).toBe("first");
      expect(item.id).toBeTruthy();

      const fetchedResponse = await fetch(`${baseUrl}/items/${item.id}`);
      expect((await fetchedResponse.json()).id).toBe(item.id);

      const updatedResponse = await fetch(`${baseUrl}/items/${item.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "updated" }),
      });
      const updated = await updatedResponse.json();
      expect(updated.name).toBe("updated");
      expect(updated.description).toBe("first");

      const listedResponse = await fetch(`${baseUrl}/items`);
      expect((await listedResponse.json()).length).toBe(1);

      const deletedResponse = await fetch(`${baseUrl}/items/${item.id}`, {
        method: "DELETE",
      });
      expect(deletedResponse.status).toBe(200);

      const missingResponse = await fetch(`${baseUrl}/items/${item.id}`);
      expect(missingResponse.status).toBe(404);
    });
  });

  it("rejects malformed JSON and invalid item bodies", async () => {
    const app = createApp(createMemoryClient(), "items");

    await withServer(app, async (baseUrl) => {
      const malformedResponse = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(malformedResponse.status).toBe(400);

      const invalidResponse = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: " " }),
      });
      expect(invalidResponse.status).toBe(400);
    });
  });
});

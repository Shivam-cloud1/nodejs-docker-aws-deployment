const { randomUUID } = require("node:crypto");
const express = require("express");
const serverlessExpress = require("@codegenie/serverless-express");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

const defaultClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function parseItem(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.name !== "string" ||
    body.name.trim().length === 0
  ) {
    return { error: "Request body must include a non-empty string name." };
  }

  if (body.description !== undefined && typeof body.description !== "string") {
    return { error: "description must be a string." };
  }

  return {
    item: {
      name: body.name.trim(),
      description:
        body.description === undefined ? undefined : body.description.trim(),
    },
  };
}

function createApp(client = defaultClient, tableName = process.env.TABLE_NAME) {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    if (!tableName) {
      return next(new Error("TABLE_NAME environment variable is required."));
    }
    return next();
  });

  app.get("/items", async (_req, res) => {
    const items = [];
    let lastKey;
    do {
      const result = await client.send(
        new ScanCommand({
          TableName: tableName,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    res.json(items);
  });

  app.get("/items/:id", async (req, res) => {
    const result = await client.send(
      new GetCommand({ TableName: tableName, Key: { id: req.params.id } }),
    );
    if (!result.Item) {
      return res.status(404).json({ message: "Item not found." });
    }
    return res.json(result.Item);
  });

  app.post("/items", async (req, res) => {
    const parsed = parseItem(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const now = new Date().toISOString();
    const item = {
      id: randomUUID(),
      ...parsed.item,
      description: parsed.item.description || "",
      createdAt: now,
      updatedAt: now,
    };
    await client.send(new PutCommand({ TableName: tableName, Item: item }));
    return res.status(201).json(item);
  });

  app.put("/items/:id", async (req, res) => {
    const parsed = parseItem(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const existing = await client.send(
      new GetCommand({ TableName: tableName, Key: { id: req.params.id } }),
    );
    if (!existing.Item) {
      return res.status(404).json({ message: "Item not found." });
    }

    const item = {
      ...existing.Item,
      ...parsed.item,
      description:
        parsed.item.description === undefined
          ? existing.Item.description
          : parsed.item.description,
      updatedAt: new Date().toISOString(),
    };
    await client.send(new PutCommand({ TableName: tableName, Item: item }));
    return res.json(item);
  });

  app.delete("/items/:id", async (req, res) => {
    const result = await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { id: req.params.id },
        ReturnValues: "ALL_OLD",
      }),
    );
    if (!result.Attributes) {
      return res.status(404).json({ message: "Item not found." });
    }
    return res.json({ message: "Item deleted." });
  });

  app.use((err, _req, res, _next) => {
    const status = err.status === 400 ? 400 : 500;
    if (status === 500) {
      console.error("API request failed:", err);
    }
    return res.status(status).json({
      message:
        status === 400
          ? "Request body must be valid JSON."
          : "Internal server error.",
    });
  });

  return app;
}

const app = createApp();
exports.app = app;
exports.createApp = createApp;
exports.handler = serverlessExpress({ app });

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Local API listening on http://localhost:${port}`);
  });
}

const { randomUUID } = require("node:crypto");
const express = require("express");
const serverlessExpress = require("@codegenie/serverless-express");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
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

  if (
    body.priceCents !== undefined &&
    (!Number.isSafeInteger(body.priceCents) || body.priceCents <= 0)
  ) {
    return { error: "priceCents must be a positive integer." };
  }

  return {
    item: {
      name: body.name.trim(),
      ...(body.description === undefined
        ? {}
        : { description: body.description.trim() }),
      ...(body.priceCents === undefined
        ? {}
        : { priceCents: body.priceCents }),
    },
  };
}

function parseCartItem(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.productId !== "string" ||
    body.productId.trim().length === 0 ||
    !Number.isSafeInteger(body.quantity) ||
    body.quantity <= 0
  ) {
    return {
      error: "Request body must include a productId and positive integer quantity.",
    };
  }

  return { productId: body.productId.trim(), quantity: body.quantity };
}

async function getCartItems(client, cartTableName, cartId) {
  const result = await client.send(
    new QueryCommand({
      TableName: cartTableName,
      KeyConditionExpression: "cartId = :cartId",
      ExpressionAttributeValues: { ":cartId": cartId },
    }),
  );
  return (result.Items || []).filter((item) => item.itemKey !== "META");
}

function isTransactionCancelled(error) {
  return error && error.name === "TransactionCanceledException";
}

function createApp(
  client = defaultClient,
  tableName = process.env.TABLE_NAME,
  cartTableName = process.env.CART_TABLE_NAME,
  ordersTableName = process.env.ORDERS_TABLE_NAME,
) {
  const app = express();
  app.use(express.json());
  const pathPrefix = process.env.API_PATH_PREFIX;
  if (pathPrefix) {
    const normalizedPrefix = `/${pathPrefix.replace(/^\/+|\/+$/g, "")}`;
    app.use((req, _res, next) => {
      if (req.url === normalizedPrefix || req.url.startsWith(`${normalizedPrefix}/`)) {
        req.url = req.url.slice(normalizedPrefix.length) || "/";
      }
      return next();
    });
  }
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

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.post("/cart", async (_req, res, next) => {
    if (!cartTableName) {
      return next(new Error("CART_TABLE_NAME environment variable is required."));
    }

    const cartId = randomUUID();
    const createdAt = new Date().toISOString();
    await client.send(
      new PutCommand({
        TableName: cartTableName,
        Item: { cartId, itemKey: "META", status: "OPEN", createdAt },
      }),
    );
    return res.status(201).json({ cartId, status: "OPEN", createdAt });
  });

  app.get("/cart/:cartId", async (req, res, next) => {
    if (!cartTableName) {
      return next(new Error("CART_TABLE_NAME environment variable is required."));
    }

    const cart = await client.send(
      new GetCommand({
        TableName: cartTableName,
        Key: { cartId: req.params.cartId, itemKey: "META" },
      }),
    );
    if (!cart.Item) {
      return res.status(404).json({ message: "Cart not found." });
    }

    const items = await getCartItems(client, cartTableName, req.params.cartId);
    const totalCents = items.reduce(
      (total, item) => total + item.priceCents * item.quantity,
      0,
    );
    if (!Number.isSafeInteger(totalCents)) {
      return res.status(400).json({ message: "Cart total is too large." });
    }

    return res.json({
      cartId: req.params.cartId,
      status: cart.Item.status,
      items: items.map(({ cartId: _cartId, itemKey: _itemKey, ...item }) => item),
      totalCents,
    });
  });

  app.post("/cart/:cartId/items", async (req, res, next) => {
    if (!cartTableName) {
      return next(new Error("CART_TABLE_NAME environment variable is required."));
    }

    const parsed = parseCartItem(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const cart = await client.send(
      new GetCommand({
        TableName: cartTableName,
        Key: { cartId: req.params.cartId, itemKey: "META" },
      }),
    );
    if (!cart.Item) {
      return res.status(404).json({ message: "Cart not found." });
    }
    if (cart.Item.status !== "OPEN") {
      return res.status(409).json({ message: "Cart is already checked out." });
    }

    const product = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { id: parsed.productId },
      }),
    );
    if (!product.Item) {
      return res.status(404).json({ message: "Product not found." });
    }
    if (
      !Number.isSafeInteger(product.Item.priceCents) ||
      product.Item.priceCents <= 0
    ) {
      return res.status(409).json({
        message: "Product must have a positive integer priceCents before it can be added.",
      });
    }

    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: cartTableName,
                Key: { cartId: req.params.cartId, itemKey: "META" },
                ConditionExpression: "#status = :open",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":open": "OPEN" },
              },
            },
            {
              Update: {
                TableName: cartTableName,
                Key: {
                  cartId: req.params.cartId,
                  itemKey: `PRODUCT#${parsed.productId}`,
                },
                UpdateExpression:
                  "SET #productId = :productId, #name = :name, #priceCents = :priceCents ADD #quantity :quantity",
                ConditionExpression:
                  "attribute_not_exists(#quantity) OR #quantity <= :maxExisting",
                ExpressionAttributeNames: {
                  "#productId": "productId",
                  "#name": "name",
                  "#priceCents": "priceCents",
                  "#quantity": "quantity",
                },
                ExpressionAttributeValues: {
                  ":productId": parsed.productId,
                  ":name": product.Item.name,
                  ":priceCents": product.Item.priceCents,
                  ":quantity": parsed.quantity,
                  ":maxExisting": Number.MAX_SAFE_INTEGER - parsed.quantity,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isTransactionCancelled(error)) {
        return res.status(409).json({
          message: "Cart changed or is already checked out; refresh it and retry.",
        });
      }
      throw error;
    }

    return res.status(200).json({ message: "Item added to cart." });
  });

  app.delete("/cart/:cartId/items/:productId", async (req, res, next) => {
    if (!cartTableName) {
      return next(new Error("CART_TABLE_NAME environment variable is required."));
    }

    const cart = await client.send(
      new GetCommand({
        TableName: cartTableName,
        Key: { cartId: req.params.cartId, itemKey: "META" },
      }),
    );
    if (!cart.Item) {
      return res.status(404).json({ message: "Cart not found." });
    }
    if (cart.Item.status !== "OPEN") {
      return res.status(409).json({ message: "Cart is already checked out." });
    }

    const itemKey = `PRODUCT#${req.params.productId}`;
    const item = await client.send(
      new GetCommand({
        TableName: cartTableName,
        Key: { cartId: req.params.cartId, itemKey },
      }),
    );
    if (!item.Item) {
      return res.status(404).json({ message: "Cart item not found." });
    }

    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: cartTableName,
                Key: { cartId: req.params.cartId, itemKey: "META" },
                ConditionExpression: "#status = :open",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":open": "OPEN" },
              },
            },
            {
              Delete: {
                TableName: cartTableName,
                Key: { cartId: req.params.cartId, itemKey },
                ConditionExpression: "attribute_exists(cartId)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isTransactionCancelled(error)) {
        return res.status(409).json({
          message: "Cart changed or is already checked out; refresh it and retry.",
        });
      }
      throw error;
    }

    return res.json({ message: "Item removed from cart." });
  });

  app.post("/cart/:cartId/checkout", async (req, res, next) => {
    if (!cartTableName || !ordersTableName) {
      return next(
        new Error(
          "CART_TABLE_NAME and ORDERS_TABLE_NAME environment variables are required.",
        ),
      );
    }

    const cartResult = await client.send(
      new GetCommand({
        TableName: cartTableName,
        Key: { cartId: req.params.cartId, itemKey: "META" },
      }),
    );
    if (!cartResult.Item) {
      return res.status(404).json({ message: "Cart not found." });
    }

    if (cartResult.Item.status === "CHECKED_OUT") {
      const previousOrder = await client.send(
        new GetCommand({
          TableName: ordersTableName,
          Key: { orderId: cartResult.Item.orderId },
        }),
      );
      if (!previousOrder.Item) {
        return next(new Error("Checked-out cart order could not be found."));
      }
      return res.json(previousOrder.Item);
    }

    const items = await getCartItems(client, cartTableName, req.params.cartId);
    if (items.length === 0) {
      return res.status(400).json({ message: "Cannot check out an empty cart." });
    }

    const totalCents = items.reduce(
      (total, item) => total + item.priceCents * item.quantity,
      0,
    );
    if (!Number.isSafeInteger(totalCents)) {
      return res.status(400).json({ message: "Cart total is too large." });
    }

    const order = {
      orderId: randomUUID(),
      cartId: req.params.cartId,
      items: items.map(({ cartId: _cartId, itemKey: _itemKey, ...item }) => item),
      totalCents,
      paymentStatus: "SIMULATED",
      createdAt: new Date().toISOString(),
    };

    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: ordersTableName,
                Item: order,
                ConditionExpression: "attribute_not_exists(orderId)",
              },
            },
            {
              Update: {
                TableName: cartTableName,
                Key: { cartId: req.params.cartId, itemKey: "META" },
                UpdateExpression:
                  "SET #status = :checkedOut, #orderId = :orderId, #checkedOutAt = :checkedOutAt",
                ConditionExpression: "#status = :open",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#orderId": "orderId",
                  "#checkedOutAt": "checkedOutAt",
                },
                ExpressionAttributeValues: {
                  ":open": "OPEN",
                  ":checkedOut": "CHECKED_OUT",
                  ":orderId": order.orderId,
                  ":checkedOutAt": order.createdAt,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isTransactionCancelled(error)) {
        const latestCart = await client.send(
          new GetCommand({
            TableName: cartTableName,
            Key: { cartId: req.params.cartId, itemKey: "META" },
          }),
        );
        if (latestCart.Item && latestCart.Item.status === "CHECKED_OUT") {
          const previousOrder = await client.send(
            new GetCommand({
              TableName: ordersTableName,
              Key: { orderId: latestCart.Item.orderId },
            }),
          );
          if (previousOrder.Item) {
            return res.json(previousOrder.Item);
          }
        }
        return res.status(409).json({
          message: "Cart changed during checkout; refresh it and retry.",
        });
      }
      throw error;
    }

    return res.status(201).json(order);
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

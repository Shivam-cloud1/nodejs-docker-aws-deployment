const { createApp } = require("../src/app");

function createMemoryClient() {
  const tables = {
    items: new Map(),
    carts: new Map(),
    orders: new Map(),
  };
  const keyOf = (key) =>
    key.cartId && key.itemKey
      ? `${key.cartId}:${key.itemKey}`
      : key.id || key.orderId;
  const getTable = (tableName) => {
    const table = tables[tableName];
    if (!table) {
      throw new Error(`Unexpected table: ${tableName}`);
    }
    return table;
  };
  const cancelTransaction = () => {
    const error = new Error("Transaction cancelled.");
    error.name = "TransactionCanceledException";
    throw error;
  };

  return {
    async send(command) {
      const { input } = command;
      switch (command.constructor.name) {
        case "ScanCommand":
          return { Items: [...getTable(input.TableName).values()] };
        case "QueryCommand":
          return {
            Items: [...getTable(input.TableName).values()].filter(
              (item) => item.cartId === input.ExpressionAttributeValues[":cartId"],
            ),
          };
        case "GetCommand":
          return { Item: getTable(input.TableName).get(keyOf(input.Key)) };
        case "PutCommand":
          getTable(input.TableName).set(keyOf(input.Item), input.Item);
          return {};
        case "DeleteCommand": {
          const table = getTable(input.TableName);
          const key = keyOf(input.Key);
          const previous = table.get(key);
          table.delete(key);
          return { Attributes: previous };
        }
        case "TransactWriteCommand": {
          const operations = input.TransactItems;
          for (const operation of operations) {
            if (operation.ConditionCheck) {
              const condition = operation.ConditionCheck;
              const item = getTable(condition.TableName).get(
                keyOf(condition.Key),
              );
              if (!item || item.status !== "OPEN") {
                cancelTransaction();
              }
            }
            if (operation.Update) {
              const update = operation.Update;
              const table = getTable(update.TableName);
              const item = table.get(keyOf(update.Key));
              if (update.Key.itemKey === "META" && item?.status !== "OPEN") {
                cancelTransaction();
              }
              if (update.Key.itemKey !== "META" && item) {
                const names = update.ExpressionAttributeNames;
                const values = update.ExpressionAttributeValues;
                if (
                  item[names["#quantity"]] >
                  values[":maxExisting"]
                ) {
                  cancelTransaction();
                }
              }
            }
            if (operation.Delete) {
              const deletion = operation.Delete;
              if (
                !getTable(deletion.TableName).has(keyOf(deletion.Key))
              ) {
                cancelTransaction();
              }
            }
            if (operation.Put) {
              const put = operation.Put;
              if (getTable(put.TableName).has(keyOf(put.Item))) {
                cancelTransaction();
              }
            }
          }

          for (const operation of operations) {
            if (operation.Update) {
              const update = operation.Update;
              const table = getTable(update.TableName);
              const key = keyOf(update.Key);
              const names = update.ExpressionAttributeNames;
              const values = update.ExpressionAttributeValues;
              const item = table.get(key) || {
                ...update.Key,
              };

              if (update.Key.itemKey === "META") {
                item[names["#status"]] = values[":checkedOut"];
                item[names["#orderId"]] = values[":orderId"];
                item[names["#checkedOutAt"]] = values[":checkedOutAt"];
              } else {
                for (const name of Object.keys(names)) {
                  if (name !== "#quantity") {
                    item[names[name]] = values[`:${name.slice(1)}`];
                  }
                }
                item[names["#quantity"]] =
                  (item[names["#quantity"]] || 0) + values[":quantity"];
              }
              table.set(key, item);
            }
            if (operation.Delete) {
              const deletion = operation.Delete;
              getTable(deletion.TableName).delete(keyOf(deletion.Key));
            }
            if (operation.Put) {
              const put = operation.Put;
              getTable(put.TableName).set(keyOf(put.Item), put.Item);
            }
          }
          return {};
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

describe("cart API", () => {
    async function createProductAndCart(baseUrl) {
      const productResponse = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test product", priceCents: 1299 }),
      });
      const product = await productResponse.json();
      const cartResponse = await fetch(`${baseUrl}/cart`, { method: "POST" });
      const cart = await cartResponse.json();
      return { product, cart };
    }

    it("adds and removes cart items using server-side product prices", async () => {
      const app = createApp(createMemoryClient(), "items", "carts", "orders");

      await withServer(app, async (baseUrl) => {
        const { product, cart } = await createProductAndCart(baseUrl);
        const addResponse = await fetch(`${baseUrl}/cart/${cart.cartId}/items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            productId: product.id,
            quantity: 2,
            priceCents: 1,
          }),
        });
        expect(addResponse.status).toBe(200);

        const fetchedResponse = await fetch(`${baseUrl}/cart/${cart.cartId}`);
        const fetchedCart = await fetchedResponse.json();
        expect(fetchedCart.totalCents).toBe(2598);
        expect(fetchedCart.items).toEqual([
          {
            productId: product.id,
            name: "Test product",
            priceCents: 1299,
            quantity: 2,
          },
        ]);

        const deleteResponse = await fetch(
          `${baseUrl}/cart/${cart.cartId}/items/${product.id}`,
          { method: "DELETE" },
        );
        expect(deleteResponse.status).toBe(200);
        expect((await (await fetch(`${baseUrl}/cart/${cart.cartId}`)).json()).items)
          .toEqual([]);
      });
    });

    describe("EC2 ALB path prefix", () => {
      it("strips the configured prefix and serves the ALB health check", async () => {
        const previousPrefix = process.env.API_PATH_PREFIX;
        process.env.API_PATH_PREFIX = "/ec2";
        const app = createApp(createMemoryClient(), "items", "carts", "orders");

        try {
          await withServer(app, async (baseUrl) => {
            const healthResponse = await fetch(`${baseUrl}/ec2/health`);
            expect(healthResponse.status).toBe(200);
            expect(await healthResponse.json()).toEqual({ status: "ok" });

            const itemsResponse = await fetch(`${baseUrl}/ec2/items`);
            expect(itemsResponse.status).toBe(200);
            expect(await itemsResponse.json()).toEqual([]);
          });
        } finally {
          if (previousPrefix === undefined) {
            delete process.env.API_PATH_PREFIX;
          } else {
            process.env.API_PATH_PREFIX = previousPrefix;
          }
        }
      });
    });

    it("simulates checkout once and prevents changes to a checked-out cart", async () => {
      const app = createApp(createMemoryClient(), "items", "carts", "orders");

      await withServer(app, async (baseUrl) => {
        const { product, cart } = await createProductAndCart(baseUrl);
        await fetch(`${baseUrl}/cart/${cart.cartId}/items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId: product.id, quantity: 3 }),
        });

        const checkoutResponse = await fetch(
          `${baseUrl}/cart/${cart.cartId}/checkout`,
          { method: "POST" },
        );
        expect(checkoutResponse.status).toBe(201);
        const order = await checkoutResponse.json();
        expect(order.paymentStatus).toBe("SIMULATED");
        expect(order.totalCents).toBe(3897);

        const retryResponse = await fetch(
          `${baseUrl}/cart/${cart.cartId}/checkout`,
          { method: "POST" },
        );
        expect(retryResponse.status).toBe(200);
        expect((await retryResponse.json()).orderId).toBe(order.orderId);

        const addAfterCheckout = await fetch(
          `${baseUrl}/cart/${cart.cartId}/items`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ productId: product.id, quantity: 1 }),
          },
        );
        expect(addAfterCheckout.status).toBe(409);
      });
    });

    it("requires a product to have a price before adding it to a cart", async () => {
      const app = createApp(createMemoryClient(), "items", "carts", "orders");

      await withServer(app, async (baseUrl) => {
        const productResponse = await fetch(`${baseUrl}/items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Unpriced product" }),
        });
        const product = await productResponse.json();
        const cartResponse = await fetch(`${baseUrl}/cart`, { method: "POST" });
        const cart = await cartResponse.json();
        const addResponse = await fetch(`${baseUrl}/cart/${cart.cartId}/items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId: product.id, quantity: 1 }),
        });

        expect(addResponse.status).toBe(409);
      });
    });
  });

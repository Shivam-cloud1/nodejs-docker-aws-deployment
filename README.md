# Node.js CRUD API on AWS Lambda

This project exposes an Express CRUD API for items and carts. AWS SAM deploys
an HTTP API, a Node.js 22 Lambda container image using AWS's Lambda base image,
and DynamoDB tables for items, carts, and simulated orders.

The HTTP API's default route forwards requests through an API Gateway VPC Link
to an internal Application Load Balancer (ALB), which invokes the Lambda
function. The ALB is private and is not directly reachable from the internet.
The deployment uses the account's existing default VPC and two subnets in
different Availability Zones. The ALB and VPC Link can incur ongoing charges.

## API

| Method | Path | Action |
| --- | --- | --- |
| `GET` | `/items` | List items |
| `GET` | `/items/{id}` | Get an item |
| `POST` | `/items` | Create an item |
| `PUT` | `/items/{id}` | Update an item |
| `DELETE` | `/items/{id}` | Delete an item |
| `POST` | `/cart` | Create a cart |
| `GET` | `/cart/{cartId}` | Get cart contents and total |
| `POST` | `/cart/{cartId}/items` | Add a product to a cart |
| `DELETE` | `/cart/{cartId}/items/{productId}` | Remove a product from a cart |
| `POST` | `/cart/{cartId}/checkout` | Simulate checkout |

Create and update requests accept JSON such as:

```json
{
  "name": "Example",
  "description": "Optional description",
  "priceCents": 1299
}
```

Cart item requests use a product ID and quantity; the API reads the price from
the product record rather than trusting a client-supplied price:

```json
{
  "productId": "product-id-from-post-items",
  "quantity": 2
}
```

Checkout records an order with `paymentStatus: "SIMULATED"`. It does not
connect to a payment provider or charge money. Prices are integer minor units
(`priceCents`), and products need a positive `priceCents` before they can be
added to a cart.

The API currently has no authentication. Cart IDs are random, but this is
still a demo API and should not be used for real customer accounts or payments.

## Deploy from your machine

Prerequisites: AWS CLI credentials, Docker, and AWS SAM CLI.

```sh
npm ci
npm test
sam build --use-container
sam deploy --guided --resolve-image-repos
```

The test suite uses Jest.

Grant the deployment identity permissions to create/update CloudFormation
stacks, Lambda functions, API Gateway APIs, IAM roles, DynamoDB tables, and ECR
repositories. The deployed API base URL is printed in the stack outputs.

## GitHub Actions CI/CD

The workflow runs tests for pull requests and pushes. A push to `main` (or
manual workflow dispatch) also builds the Lambda image and deploys the SAM
stack.

1. Configure an AWS IAM role for GitHub Actions OIDC trust, scoped to this
   repository and the `main` branch.
2. Grant the role the deployment permissions listed above.
3. Add the repository secret `AWS_ROLE_ARN` with that role's ARN.
4. The workflow deploys to AWS Sydney (`ap-southeast-2`).

No long-lived AWS access keys are stored in GitHub.

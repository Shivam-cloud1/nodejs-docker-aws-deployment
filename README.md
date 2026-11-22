# Node.js CRUD API on AWS Lambda

This project exposes an Express CRUD API for items and carts. AWS SAM deploys
an HTTP API, a Node.js 22 Lambda container image using AWS's Lambda base image,
and DynamoDB tables for items, carts, and simulated orders.

The HTTP API routes through an API Gateway VPC Link to a shared internet-facing
Application Load Balancer (ALB). The ALB forwards normal API paths to Lambda
and `/ec2/*` paths to the Docker API running on EC2. The ALB is public on HTTP
port 80; the EC2 container port is only reachable from the ALB. The deployment
uses the account's existing default VPC and two subnets in different
Availability Zones. The ALB and VPC Link can incur ongoing charges.

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

## Run the API on a single EC2 instance

`Dockerfile` is specifically for Lambda. `Dockerfile.ec2` builds a regular
Node.js HTTP server image for EC2. This deployment can run alongside the
Lambda stack and uses the same DynamoDB tables.

1. On your computer, create a separate ECR repository, then build and push the
   EC2 image. Create the repository once:

   ```powershell
   $region = "ap-southeast-2"
   $accountId = aws sts get-caller-identity --query Account --output text
   $repository = "nodejs-crud-api-ec2"
   aws ecr create-repository --repository-name $repository --region $region
   aws ecr get-login-password --region $region | docker login --username AWS --password-stdin "$accountId.dkr.ecr.$region.amazonaws.com"
   docker build -f Dockerfile.ec2 -t "${repository}:latest" .
   docker tag "${repository}:latest" "$accountId.dkr.ecr.$region.amazonaws.com/${repository}:latest"
   docker push "$accountId.dkr.ecr.$region.amazonaws.com/${repository}:latest"
   ```

2. Deploy [ec2.yaml](./ec2.yaml) as a separate stack. It creates one Amazon
   Linux 2023 instance, installs Docker, pulls the image, and runs the API.
   The instance profile grants SSM access, ECR pull access, and access to the
   existing DynamoDB tables. Get the shared ALB listener and security group
   IDs from the `nodejs-crud-api` CloudFormation stack resources:

   ```powershell
   $listenerArn = aws cloudformation describe-stack-resource --stack-name nodejs-crud-api --logical-resource-id ApplicationLoadBalancerListener --region $region --query StackResourceDetail.PhysicalResourceId --output text
   $albSecurityGroupId = aws cloudformation describe-stack-resource --stack-name nodejs-crud-api --logical-resource-id ApplicationLoadBalancerSecurityGroup --region $region --query StackResourceDetail.PhysicalResourceId --output text
   aws cloudformation deploy --template-file ec2.yaml --stack-name nodejs-crud-api-ec2 --region $region --capabilities CAPABILITY_IAM --parameter-overrides "ContainerImageUri=$accountId.dkr.ecr.$region.amazonaws.com/$repository`:latest" "LoadBalancerListenerArn=$listenerArn" "LoadBalancerSecurityGroupId=$albSecurityGroupId"
   ```

3. Use the `AlbDnsName` output of the `nodejs-crud-api` stack to test both
   backends:

   ```text
   http://<AlbDnsName>/items       # Lambda
   http://<AlbDnsName>/ec2/items   # EC2 Docker container
   ```

The ALB listener is internet-facing and the API has no authentication. This is
for learning only; do not expose it publicly for production use.

The EC2 instance, ECR storage, and public IPv4 address can incur charges. This
stack runs alongside the Lambda/API Gateway/ALB stack; terminating or deleting
the EC2 stack does not remove those existing resources or DynamoDB data.

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

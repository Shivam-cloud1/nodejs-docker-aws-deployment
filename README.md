# Node.js CRUD API on AWS Lambda

This project exposes an Express CRUD API for items. AWS SAM deploys an HTTP
API, a Node.js 22 Lambda container image using AWS's Lambda base image, and a
DynamoDB table.

## API

| Method | Path | Action |
| --- | --- | --- |
| `GET` | `/items` | List items |
| `GET` | `/items/{id}` | Get an item |
| `POST` | `/items` | Create an item |
| `PUT` | `/items/{id}` | Update an item |
| `DELETE` | `/items/{id}` | Delete an item |

Create and update requests accept JSON such as:

```json
{
  "name": "Example",
  "description": "Optional description"
}
```

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
4. The workflow deploys to AWS Mumbai (`ap-south-1`).

No long-lived AWS access keys are stored in GitHub.

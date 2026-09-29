import {
  AccountHasNoApiKeyError,
  AccountNameTakenError,
  createAccountWithApiKey,
  rotateApiKey,
} from "../modules/auth/api-keys";

/**
 * Operator CLI for API key provisioning.
 *
 * Exists because the PRD defines no public key-issuance endpoint, and adding an
 * unauthenticated one would be worse than a command an operator runs deliberately.
 * The plaintext key is printed once here and is not recoverable afterwards
 * (PR-AUTH-003).
 *
 *   npm run provision-account -- create <account-name>
 *   npm run provision-account -- rotate <account-id>
 */

const USAGE = `usage: provision-account <create|rotate> <account-name|account-id>

  create <name>   Create an account and issue its first API key
  rotate <id>     Issue a replacement key, immediately invalidating the current one
`;

function requireArgument(name: string): string {
  const value = process.argv[3];
  if (value === undefined || value.trim().length === 0) {
    process.stderr.write(`error: ${name} is required\n\n${USAGE}`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const action = process.argv[2];

  switch (action) {
    case "create": {
      const issued = await createAccountWithApiKey(requireArgument("account name"));
      process.stdout.write(
        `Account ${issued.accountId} created.\n` +
          `API key (shown once): ${issued.apiKey}\n` +
          `Key prefix: ${issued.prefix}\n`,
      );
      return;
    }
    case "rotate": {
      const accountId = requireArgument("account id");
      const issued = await rotateApiKey(accountId);
      process.stdout.write(
        `API key rotated for ${issued.accountId}.\n` +
          `API key (shown once): ${issued.apiKey}\n` +
          `Key prefix: ${issued.prefix}\n` +
          "The previous key no longer authenticates.\n",
      );
      return;
    }
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`error: unknown action "${action}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  if (error instanceof AccountNameTakenError || error instanceof AccountHasNoApiKeyError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  // Never echo a stack that could contain a connection string or a key.
  console.error("provision-account failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

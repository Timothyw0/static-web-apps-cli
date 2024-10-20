import { TokenCredential } from "@azure/identity";
import chalk from "chalk";
import dotenv from "dotenv";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { logger, logGitHubIssueMessageAndExit } from "../../../core/utils/logger.js";
import { authenticateWithAzureIdentity, listSubscriptions, listTenants } from "../../../core/account.js";
import { AZURE_LOGIN_CONFIG, ENV_FILENAME } from "../../../core/constants.js";
import { pathExists, safeReadJson } from "../../../core/utils/file.js";
import { updateGitIgnore } from "../../../core/git.js";
import { chooseSubscription, chooseTenant } from "../../../core/prompts.js";
import { Environment } from "../../../core/swa-cli-persistence-plugin/impl/azure-environment.js";

const defaultScope = `${Environment.AzureCloud.resourceManagerEndpointUrl}/.default`;

export async function loginCommand(options: SWACLIConfig) {
  try {
    const { credentialChain, subscriptionId } = await login(options);

    if (credentialChain && subscriptionId) {
      logger.log(chalk.green(`✔ Successfully setup project!`));
    } else {
      logger.log(chalk.red(`✘ Failed to setup project!`));
      logGitHubIssueMessageAndExit();
    }
  } catch (error) {
    logger.error(`Failed to setup project: ${(error as any).message}`);
    logGitHubIssueMessageAndExit();
  }
}

export async function login(options: SWACLIConfig): Promise<any> {
  let credentialChain: TokenCredential | undefined = undefined;

  logger.log(`Checking Azure session...`);

  let tenantId: string | undefined = options.tenantId;
  let clientId: string | undefined = options.clientId;
  let clientSecret: string | undefined = options.clientSecret;

  credentialChain = await authenticateWithAzureIdentity({ tenantId, clientId, clientSecret }, options.useKeychain, options.clearCredentials);

  if (await credentialChain.getToken(defaultScope)) {
    logger.log(chalk.green(`✔ Successfully logged into Azure!`));
  }

  options = await tryGetAzTenantAndSubscription(options);
  return await setupProjectCredentials(options, credentialChain);
}

async function setupProjectCredentials(options: SWACLIConfig, credentialChain: TokenCredential) {
  let { subscriptionId, tenantId, clientId, clientSecret } = options;

  // If the user has not specified a tenantId, we will prompt them to choose one
  if (!tenantId) {
    const tenants = await listTenants(credentialChain);
    if (tenants.length === 0) {
      throw new Error(
        `No Azure tenants found in your account.\n  Please read https://docs.microsoft.com/azure/cost-management-billing/manage/troubleshoot-sign-in-issue`,
      );
    } else if (tenants.length === 1) {
      logger.silly(`Found 1 tenant: ${tenants[0].tenantId}`);
      tenantId = tenants[0].tenantId;
    } else {
      const tenant = await chooseTenant(tenants, options.tenantId);
      tenantId = tenant?.tenantId;
      // login again with the new tenant
      // TODO: can we silently authenticate the user with the new tenant?
      credentialChain = await authenticateWithAzureIdentity({ tenantId, clientId, clientSecret }, options.useKeychain, true);

      if (await credentialChain.getToken(defaultScope)) {
        logger.log(chalk.green(`✔ Successfully logged into Azure tenant: ${tenantId}`));
      }
    }
  }

  logger.silly(`Selected tenant: ${tenantId}`);

  // If the user has not specified a subscriptionId, we will prompt them to choose one
  if (!subscriptionId) {
    const subscriptions = await listSubscriptions(credentialChain);
    if (subscriptions.length === 0) {
      throw new Error(
        `No valid subscription found for tenant ${tenantId}.\n  Please read https://docs.microsoft.com/azure/cost-management-billing/manage/no-subscriptions-found`,
      );
    } else if (subscriptions.length === 1) {
      logger.silly(`Found 1 subscription: ${subscriptions[0].subscriptionId}`);
      subscriptionId = subscriptions[0].subscriptionId;
    } else {
      const subscription = await chooseSubscription(subscriptions, subscriptionId);
      subscriptionId = subscription?.subscriptionId;
    }
  }

  logger.silly(`Selected subscription: ${subscriptionId}`);

  logger.silly(`Project credentials:`);
  logger.silly({ subscriptionId, tenantId, clientId, clientSecret });

  await storeProjectCredentialsInEnvFile(subscriptionId, tenantId, clientId, clientSecret);

  return {
    credentialChain,
    subscriptionId: subscriptionId as string,
  };
}

async function storeProjectCredentialsInEnvFile(
  subscriptionId: string | undefined,
  tenantId: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
) {
  const envFile = path.join(process.cwd(), ENV_FILENAME);
  const envFileExists = existsSync(envFile);
  const envFileContent = envFileExists ? await fs.readFile(envFile, "utf8") : "";
  const buf = Buffer.from(envFileContent);

  // in case the .env file format changes in the future, we can use the following to parse the file
  const config = dotenv.parse(buf);
  const oldEnvFileLines = Object.keys(config).map((key) => `${key}=${config[key]}`);
  const newEnvFileLines = [];

  let entry = `AZURE_SUBSCRIPTION_ID=${subscriptionId}`;
  if (subscriptionId && !envFileContent.includes(entry)) {
    newEnvFileLines.push(entry);
  }

  entry = `AZURE_TENANT_ID=${tenantId}`;
  if (tenantId && !envFileContent.includes(entry)) {
    newEnvFileLines.push(entry);
  }

  entry = `AZURE_CLIENT_ID=${clientId}`;
  if (clientId && !envFileContent.includes(entry)) {
    newEnvFileLines.push(entry);
  }

  entry = `AZURE_CLIENT_SECRET=${clientSecret}`;
  if (clientSecret && !envFileContent.includes(entry)) {
    newEnvFileLines.push(entry);
  }

  // write file if we have at least one new env line
  if (newEnvFileLines.length > 0) {
    const envFileContentWithProjectDetails = [...oldEnvFileLines, ...newEnvFileLines].join("\n");
    await fs.writeFile(envFile, envFileContentWithProjectDetails);

    logger.log(chalk.green(`✔ Saved project credentials in ${ENV_FILENAME} file.`));

    await updateGitIgnore(ENV_FILENAME);
  }
}

async function tryGetAzTenantAndSubscription(options: SWACLIConfig) {
  const doesAzureConfigExist = await pathExists(AZURE_LOGIN_CONFIG);
  if (!doesAzureConfigExist) {
    return options;
  } else {
    logger.silly(`Found an existing Azure config file, getting Tenant and Subscription Id from ${AZURE_LOGIN_CONFIG}`);

    const azureProfile = await safeReadJson(AZURE_LOGIN_CONFIG);
    if (azureProfile) {
      const allSubscriptions = (azureProfile as AzureProfile).subscriptions;
      if (allSubscriptions) {
        const defaultAzureInfo = allSubscriptions.find((subscription) => subscription.isDefault == true);
        if (defaultAzureInfo) {
          options.tenantId = defaultAzureInfo.tenantId;
          options.subscriptionId = defaultAzureInfo.id;
        }
      }
    }

    return options;
  }
}

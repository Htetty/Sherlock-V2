import "dotenv/config";
import { createProbot } from "probot";
import { snapshotFromAppApiInstallation } from "./server.js";
import {
  createSupabaseInstallationDataStore,
  toGitHubIdString,
  type RepositorySnapshot,
} from "./services/github-installations.js";
import { getSupabaseServiceRoleClient } from "./services/supabase-clients.js";

type AppInstallationListItem = Parameters<
  typeof snapshotFromAppApiInstallation
>[0];

async function listCurrentInstallations(
  appOctokit: {
    request(
      route: string,
      parameters: Record<string, unknown>,
    ): Promise<{ data: unknown }>;
  },
): Promise<AppInstallationListItem[]> {
  const installations: AppInstallationListItem[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await appOctokit.request("GET /app/installations", {
      page,
      per_page: 100,
    });
    if (!Array.isArray(response.data)) {
      throw new Error("GitHub returned an invalid installation list.");
    }
    installations.push(...response.data);
    if (response.data.length < 100) break;
    if (page === 100) {
      throw new Error(
        "GitHub installation reconciliation exceeded the 10,000-row safety limit.",
      );
    }
  }
  return installations;
}

async function listInstallationRepositories(
  probot: ReturnType<typeof createProbot>,
  installationId: string,
): Promise<RepositorySnapshot[]> {
  const numericId = Number(installationId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new Error("Installation id is outside the safe integer range.");
  }
  const octokit = (await probot.auth(numericId)) as {
    rest: {
      apps: {
        listReposAccessibleToInstallation(input: {
          page: number;
          per_page: number;
        }): Promise<{
          data: {
            repositories: Array<{
              id: unknown;
              name: string;
              full_name: string;
              private: boolean;
              owner: { login?: string } | null;
            }>;
          };
        }>;
      };
    };
  };
  const repositories: RepositorySnapshot[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await octokit.rest.apps.listReposAccessibleToInstallation({
      page,
      per_page: 100,
    });
    for (const repository of response.data.repositories) {
      const repositoryId = toGitHubIdString(repository.id);
      const ownerLogin = repository.owner?.login;
      if (!repositoryId || !ownerLogin) {
        throw new Error("GitHub returned an invalid repository identity.");
      }
      repositories.push({
        repositoryId,
        ownerLogin,
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
      });
    }
    if (response.data.repositories.length < 100) break;
    if (page === 100) {
      throw new Error(
        `Repository reconciliation for installation ${installationId} exceeded the 10,000-row safety limit.`,
      );
    }
  }
  return repositories;
}

const supabase = await getSupabaseServiceRoleClient();
const store = createSupabaseInstallationDataStore(
  supabase as unknown as Parameters<
    typeof createSupabaseInstallationDataStore
  >[0],
);
const probot = createProbot();
const appOctokit = (await probot.auth()) as {
  request(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};
const eventAt = new Date().toISOString();
const installations = await listCurrentInstallations(appOctokit);

for (const rawInstallation of installations) {
  const snapshot = snapshotFromAppApiInstallation(rawInstallation);
  await store.upsertInstallationSnapshot(snapshot, { eventAt });
  await store.reconcileInstallationRepositories(
    snapshot.installationId,
    await listInstallationRepositories(probot, snapshot.installationId),
    eventAt,
  );
}

const audit = await supabase.rpc("dashboard_data_reconciliation_status");
if (audit.error) {
  throw new Error(`Dashboard reconciliation audit failed: ${audit.error.message}`);
}
const status = audit.data as {
  missing_installations?: number;
  missing_repositories?: number;
  missing_command_installations?: number;
  pending_enqueues?: number;
} | null;
if (
  !status ||
  Number(status.missing_installations ?? -1) !== 0 ||
  Number(status.missing_repositories ?? -1) !== 0 ||
  Number(status.missing_command_installations ?? -1) !== 0
) {
  throw new Error(
    `Dashboard reconciliation remains incomplete: ${JSON.stringify(status)}`,
  );
}

const validation = await supabase.rpc("validate_dashboard_data_foreign_keys");
if (validation.error) {
  throw new Error(
    `Dashboard foreign-key validation failed: ${validation.error.message}`,
  );
}

console.log(
  `Dashboard reconciliation completed for ${installations.length} active installation(s); all three dashboard foreign keys are validated. Pending investigation enqueues: ${Number(status.pending_enqueues ?? 0)}.`,
);

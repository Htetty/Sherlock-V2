import express from "express";
import { getAuthContext } from "../middleware/require-auth.js";
import type {
  AuthorizedRepositoryRecord,
  InstallationDataStore,
} from "../services/github-installations.js";
import type { ProductReadStore } from "../services/product-read.js";
import { apiErrors, sendRouteError } from "./api-errors.js";

export type GitHubIssueView = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  htmlUrl: string;
  author: { login: string; avatarUrl: string | null };
  labels: string[];
  createdAt: string;
  updatedAt: string;
};

export type GitHubIssueReader = (input: {
  installationId: string;
  owner: string;
  repository: string;
  state: "open" | "closed" | "all";
  page: number;
  perPage: number;
}) => Promise<{ issues: GitHubIssueView[]; hasNextPage: boolean }>;

export type RepositoriesRouterDeps = {
  requireAuth: express.RequestHandler;
  getInstallationStore: () => Promise<InstallationDataStore>;
  getProductReadStore: () => Promise<ProductReadStore>;
  listGitHubIssues: GitHubIssueReader;
};

const GITHUB_ID = /^[0-9]+$/;

function repositoryResponse(repository: AuthorizedRepositoryRecord) {
  return {
    id: repository.repositoryId,
    fullName: repository.fullName,
    htmlUrl: `https://github.com/${repository.fullName}`,
    private: repository.private,
    ownerAvatarUrl: repository.ownerAvatarUrl,
    installationId: repository.installationId,
  };
}

function parseIssueQuery(query: express.Request["query"]): {
  state: "open" | "closed" | "all";
  page: number;
  perPage: number;
} {
  const state =
    query.state === undefined
      ? "open"
      : query.state === "open" ||
          query.state === "closed" ||
          query.state === "all"
        ? query.state
        : null;
  const page = Number(query.page ?? 1);
  const perPage = Number(query.perPage ?? 30);
  if (
    !state ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  ) {
    throw apiErrors.invalidRequest(
      "state must be open, closed, or all; page and perPage must be valid positive integers.",
    );
  }
  return { state: state as "open" | "closed" | "all", page, perPage };
}

async function authorizedRepository(
  deps: RepositoriesRouterDeps,
  userId: string,
  repositoryId: string,
) {
  if (!GITHUB_ID.test(repositoryId)) return null;
  const store = await deps.getInstallationStore();
  return (
    (await store.listRepositoriesForUser(userId)).find(
      (repository) => repository.repositoryId === repositoryId,
    ) ?? null
  );
}

export function createRepositoriesRouter(
  deps: RepositoriesRouterDeps,
): express.Router {
  const router = express.Router();

  router.get("/", deps.requireAuth, async (_req, res) => {
    try {
      const auth = getAuthContext(res);
      const store = await deps.getInstallationStore();
      const repositories = await store.listRepositoriesForUser(auth.userId);
      res.json({ repositories: repositories.map(repositoryResponse) });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.get("/:repositoryId/issues", deps.requireAuth, async (req, res) => {
    try {
      const auth = getAuthContext(res);
      const repository = await authorizedRepository(
        deps,
        auth.userId,
        req.params.repositoryId,
      );
      if (!repository) throw apiErrors.notFound();
      const query = parseIssueQuery(req.query);
      const result = await deps.listGitHubIssues({
        installationId: repository.installationId,
        owner: repository.ownerLogin,
        repository: repository.name,
        ...query,
      });
      res.json({
        repository: repositoryResponse(repository),
        issues: result.issues,
        pagination: {
          page: query.page,
          perPage: query.perPage,
          hasNextPage: result.hasNextPage,
        },
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  router.get(
    "/:repositoryId/issues/:issueNumber/investigation",
    deps.requireAuth,
    async (req, res) => {
      try {
        const auth = getAuthContext(res);
        const repository = await authorizedRepository(
          deps,
          auth.userId,
          req.params.repositoryId,
        );
        const issueNumber = Number(req.params.issueNumber);
        if (
          !repository ||
          !Number.isSafeInteger(issueNumber) ||
          issueNumber < 1
        ) {
          throw apiErrors.notFound();
        }
        const reader = await deps.getProductReadStore();
        const investigation = await reader.findIssueInvestigation({
          userId: auth.userId,
          installationId: repository.installationId,
          repositoryId: repository.repositoryId,
          issueNumber,
        });
        if (!investigation) throw apiErrors.notFound();
        res.json(investigation);
      } catch (error) {
        sendRouteError(res, error);
      }
    },
  );

  return router;
}

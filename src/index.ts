import { Probot } from "probot";
import { createInvestigationId } from "../backend/services/artifacts.js";

export default (app: Probot) => {
  app.on("issue_comment.created", async (context) => {
    const commentBody = context.payload.comment.body.toLowerCase();

    if (!commentBody.includes("investigate")) {
      return;
    }

    const investigationId = createInvestigationId();

    const investigationPayload = {
      investigationId,
      repoOwner: context.payload.repository.owner.login,
      repoName: context.payload.repository.name,
      repoUrl: context.payload.repository.html_url,
      defaultBranch: context.payload.repository.default_branch,
      issueNumber: context.payload.issue.number,
      issueTitle: context.payload.issue.title,
      issueBody: context.payload.issue.body ?? "",
      issueUrl: context.payload.issue.html_url,
      triggerComment: context.payload.comment.body,
      triggeredBy: context.payload.comment.user?.login ?? "unknown",
    };

    console.log(`[${investigationId}] Investigation payload:`);
    console.log(JSON.stringify(investigationPayload, null, 2));

    await context.octokit.rest.issues.createComment(
      context.issue({
        body: `Investigation started.\n\nInvestigation: ${investigationId}`,
      }),
    );

    const backendUrl =
      process.env.INVESTIGATION_BACKEND_URL ?? "http://localhost:4000";
    const response = await fetch(new URL("/investigations", backendUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(investigationPayload),
    });

    if (!response.ok) {
      await context.octokit.rest.issues.createComment(
        context.issue({
          body: `Sherlock could not complete this investigation because the investigation backend failed.\n\nInvestigation: ${investigationId}\nOutcome: execution_failed`,
        }),
      );

      throw new Error(
        `Investigation backend returned ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as { githubComment?: unknown };

    const resultComment =
      typeof result.githubComment === "string" && result.githubComment
        ? result.githubComment
        : `Investigation finished.\n\nInvestigation: ${investigationId}`;

    await context.octokit.rest.issues.createComment(
      context.issue({ body: resultComment }),
    );
  });
};

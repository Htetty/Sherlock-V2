import { Probot } from "probot";

export default (app: Probot) => {
  app.on("issue_comment.created", async (context) => {
    const commentBody = context.payload.comment.body.toLowerCase();

    if (!commentBody.includes("investigate")) {
      return;
    }

    const repoOwner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;
    const repoUrl = context.payload.repository.html_url;
    const defaultBranch = context.payload.repository.default_branch;
    const issueNumber = context.payload.issue.number;
    const issueTitle = context.payload.issue.title;
    const issueBody = context.payload.issue.body ?? "";
    const issueUrl = context.payload.issue.html_url;
    const triggerComment = context.payload.comment.body;
    const triggeredBy = context.payload.comment.user?.login ?? "unknown";

    const investigationPayload = {
      repoOwner,
      repoName,
      repoUrl,
      defaultBranch,
      issueNumber,
      issueTitle,
      issueBody,
      issueUrl,
      triggerComment,
      triggeredBy,
    };

    console.log("Investigation payload:");
    console.log(JSON.stringify(investigationPayload, null, 2));

    await fetch("http://localhost:4000/investigations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(investigationPayload),
    });

    const issueComment = context.issue({
      body: "Investigation started.",
    });

    await context.octokit.rest.issues.createComment(issueComment);
  });
};

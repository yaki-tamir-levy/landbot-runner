Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const owner = Deno.env.get("GITHUB_OWNER");
  const repo = Deno.env.get("GITHUB_REPO");
  const workflow = Deno.env.get("GITHUB_WORKFLOW");
  const branch = Deno.env.get("GITHUB_BRANCH") ?? "main";
  const token = Deno.env.get("GITHUB_TOKEN");

  if (!owner || !repo || !workflow || !token) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing GitHub environment variables" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;

  const githubResponse = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref: branch })
  });

  if (!githubResponse.ok) {
    const errorText = await githubResponse.text();
    return new Response(
      JSON.stringify({
        ok: false,
        status: githubResponse.status,
        error: errorText
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ ok: true, dispatched: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});

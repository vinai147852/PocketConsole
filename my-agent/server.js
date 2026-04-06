const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_WORKSPACE = path.resolve(process.env.DEFAULT_WORKSPACE || path.join(__dirname, ".."));
const EDITABLE_EXTENSIONS = [".html", ".css", ".js", ".json", ".txt"];
const MAX_FILES_IN_CONTEXT = Number(process.env.MAX_FILES_IN_CONTEXT) || 40;
const MAX_FILE_CHARS = Number(process.env.MAX_FILE_CHARS) || 30000;

let ghPath = null;

// ── Find gh.exe ──────────────────────────────────────────────────────────────
function resolveGhPath(callback) {
  execFile("where.exe", ["gh"], { timeout: 5000 }, (err, stdout) => {
    if (!err && stdout.trim()) {
      ghPath = stdout.trim().split(/\r?\n/)[0].trim();
      console.log(`[STARTUP] gh found in PATH at: ${ghPath}`);
      return callback(null);
    }

  const candidates = [
    `C:\\Program Files\\GitHub CLI\\gh.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\GitHub CLI\\gh.exe`,
    `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\gh.exe`,
    `C:\\ProgramData\\chocolatey\\bin\\gh.exe`,
    `${process.env.USERPROFILE}\\scoop\\shims\\gh.exe`,
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (found) {
    ghPath = found;
    console.log(`[STARTUP] gh found at: ${ghPath}`);
    return callback(null);
  }
  // Fallback: search PATH via powershell
  const psCommand = [
    "$m=[System.Environment]::GetEnvironmentVariable('PATH','Machine')",
    "$u=[System.Environment]::GetEnvironmentVariable('PATH','User')",
    "$env:PATH=$m+';'+$u",
    "$c=Get-Command gh -ErrorAction SilentlyContinue",
    "if($c){$c.Source}",
  ].join(";");
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], (err, stdout) => {
    if (!err && stdout.trim()) {
      ghPath = stdout.trim().split(/\r?\n/)[0].trim();
      console.log(`[STARTUP] gh found via PATH at: ${ghPath}`);
      return callback(null);
    }
    callback(new Error("Could not locate gh.exe. Install GitHub CLI and ensure it is available in PATH."));
  });
  });
}

function checkCopilotReady(callback) {
  execFile(ghPath, ["copilot", "--", "--version"], { timeout: 15000 }, (err, stdout, stderr) => {
    const combined = `${stdout || ""}\n${stderr || ""}`;
    if (!err && /GitHub Copilot CLI\s+\d+/i.test(combined)) {
      const versionLine = combined.split(/\r?\n/).find((l) => /GitHub Copilot CLI\s+\d+/i.test(l)) || "Copilot CLI ready";
      console.log(`[STARTUP] ${versionLine.trim()}`);
      return callback(null);
    }
    if (combined.includes("not compatible") || combined.includes("Update GitHub Copilot CLI")) {
      return callback(new Error("GitHub Copilot CLI needs an update. Run: gh copilot and accept the update."));
    }
    if (combined.includes("Please run `gh auth login`") || combined.includes("not logged in")) {
      return callback(new Error("GitHub CLI is not authenticated. Run: gh auth login"));
    }
    return callback(new Error("Copilot CLI is not ready. Run: gh copilot -- --version and fix any prompts/errors."));
  });
}

// ── Read all workspace files as context ──────────────────────────────────────
function readWorkspaceFiles(workspacePath) {
  const files = {};
  let count = 0;
  function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (count >= MAX_FILES_IN_CONTEXT) return;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspacePath, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        scan(full);
      } else if (EDITABLE_EXTENSIONS.includes(path.extname(entry.name))) {
        try {
          const content = fs.readFileSync(full, "utf8");
          files[rel] = content.length > MAX_FILE_CHARS
            ? `${content.slice(0, MAX_FILE_CHARS)}\n\n/* ...truncated for context... */`
            : content;
          count += 1;
        } catch {
          // skip unreadable files
        }
      }
    }
  }
  scan(workspacePath);
  return files;
}

function resolveWorkspacePath(input) {
  if (!input || typeof input !== "string" || !input.trim()) {
    return DEFAULT_WORKSPACE;
  }
  const resolved = path.resolve(input.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Workspace path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  return resolved;
}

// ── Call Copilot CLI in prompt mode ──────────────────────────────────────────
function callCopilotCliPrompt(prompt, callback) {
  const psCommand = [
    `$gh = '${ghPath.replace(/'/g, "''")}'`,
    "& $gh copilot -- -p $env:COPILOT_PROMPT --disable-builtin-mcps --available-tools=read,view,glob,grep,list_agents,read_agent,report_intent",
  ].join("; ");

  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psCommand],
    {
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, COPILOT_PROMPT: prompt },
    },
    (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || "").trim();
        return callback(new Error(detail || "Copilot CLI failed"));
      }
      callback(null, stdout || "");
    }
  );
}

function extractJsonObject(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function resolveSafePath(workspacePath, relativePath) {
  const safe = path.normalize(relativePath || "");
  if (!safe || safe.startsWith("..") || path.isAbsolute(safe)) {
    throw new Error(`Unsafe path: ${relativePath}`);
  }
  return path.join(workspacePath, safe);
}

// ── Apply operations safely (path-traversal protected) ───────────────────────
function applyOperations(operations, workspacePath) {
  const log = [];
  for (const op of (operations || [])) {
    const action = String(op.action || "").toLowerCase();
    const targetPath = op.path || op.file;
    if (!targetPath) {
      log.push("Skipped: operation missing path/file");
      continue;
    }

    try {
      const full = resolveSafePath(workspacePath, targetPath);

      if (action === "create_dir" || action === "mkdir") {
        fs.mkdirSync(full, { recursive: true });
        log.push(`Created directory: ${targetPath}`);
        continue;
      }

      if (action === "write_file" || action === "create_file") {
        const dir = path.dirname(full);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(full, String(op.content || ""), "utf8");
        log.push(`Wrote file: ${targetPath}`);
        continue;
      }

      if (action === "replace_in_file" || action === "edit") {
        let content = fs.readFileSync(full, "utf8");
        if (!content.includes(String(op.find || ""))) {
          log.push(`Text not found in ${targetPath}: "${String(op.find).slice(0, 60)}"`);
          continue;
        }
        content = content.replace(String(op.find), String(op.replace || ""));
        fs.writeFileSync(full, content, "utf8");
        log.push(`Edited file: ${targetPath}`);
        continue;
      }

      log.push(`Skipped: unknown action '${action}' for ${targetPath}`);
    } catch (e) {
      log.push(`Error on ${targetPath}: ${e.message}`);
    }
  }
  return log;
}

function deriveFallbackOperations(prompt) {
  const text = String(prompt || "");
  const lower = text.toLowerCase();

  const appMatch = text.match(/(?:application|app)\s+named\s+([a-zA-Z0-9_-]+)/i);
  if (appMatch) {
    const appName = appMatch[1];
    const pkg = {
      name: appName.toLowerCase(),
      version: "1.0.0",
      private: true,
      main: "index.js",
      scripts: {
        start: "node index.js",
      },
    };
    return {
      answer: `Created ${appName} application scaffold.`,
      operations: [
        { action: "create_dir", path: appName },
        { action: "write_file", path: `${appName}/package.json`, content: `${JSON.stringify(pkg, null, 2)}\n` },
        { action: "write_file", path: `${appName}/index.js`, content: "console.log(\"Hello, World!\");\n" },
      ],
    };
  }

  const folderMatch = text.match(/(?:folder|directory)\s+(?:named\s+)?([a-zA-Z0-9_-]+)/i);
  if (folderMatch && lower.includes("create")) {
    const folder = folderMatch[1];
    return {
      answer: `Created folder ${folder}.`,
      operations: [{ action: "create_dir", path: folder }],
    };
  }

  return null;
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/config", (req, res) => {
  res.json({ defaultWorkspace: DEFAULT_WORKSPACE });
});

app.post("/ask", (req, res) => {
  if (!ghPath) return res.json({ result: "Error: gh.exe not found. Restart the server." });

  const prompt = req.body.prompt;
  if (!prompt || typeof prompt !== "string") {
    return res.json({ result: "Error: prompt must be a non-empty string." });
  }
  console.log(`[PROMPT RECEIVED] ${prompt}`);

  let workspacePath;
  try {
    workspacePath = resolveWorkspacePath(req.body.workspacePath);
  } catch (e) {
    return res.json({ result: `Error: ${e.message}` });
  }
  console.log(`[WORKSPACE] ${workspacePath}`);

  const directFallback = deriveFallbackOperations(prompt);
  if (directFallback) {
    const opLog = applyOperations(directFallback.operations, workspacePath);
    const parts = [directFallback.answer];
    if (opLog.length) parts.push("\n" + opLog.join("\n"));
    const result = parts.join("\n");
    console.log(`[RESULT SENT] ${result}`);
    return res.json({ result });
  }

  const workspaceFiles = readWorkspaceFiles(workspacePath);
  const fileContext = Object.entries(workspaceFiles)
    .map(([name, content]) => `### ${name}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  const systemPrompt = `You are a file editor agent for a local Node.js project.
The workspace contains these files:

${fileContext}

Current editable workspace root:
${workspacePath}

When the user sends an instruction, respond ONLY with a single valid JSON object (no markdown, no extra text).
Do not execute tools or shell commands. Just produce JSON operations for this server to apply.

JSON schema:
{
  "answer": "short explanation of what you did, or your answer if it is a question",
  "operations": [
    { "action": "create_dir", "path": "relative/path" },
    { "action": "write_file", "path": "relative/path/file.ext", "content": "full file content" },
    { "action": "replace_in_file", "path": "relative/path/file.ext", "find": "exact substring", "replace": "replacement" }
  ]
}

Rules:
- For questions/overviews, set operations to [].
- Paths must always be relative to the workspace root (never absolute paths).
- You may create NEW folders/files inside the workspace using create_dir/write_file.
- For replace_in_file, "find" must be an EXACT substring from file content above.
- Never wrap the JSON in markdown fences.`;

  const combinedPrompt = `${systemPrompt}\n\nUser instruction:\n${prompt}`;

  callCopilotCliPrompt(combinedPrompt, (err, raw) => {
    if (err) {
      console.log(`[ERROR] ${err.message}`);
      return res.json({ result: `Error: ${err.message}` });
    }

    let parsed;
    try {
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
      const jsonText = extractJsonObject(cleaned) || cleaned;
      parsed = JSON.parse(jsonText);
    } catch {
      console.log(`[WARN] AI did not return JSON, sending raw text`);
      return res.json({ result: raw.trim() || "(no output)" });
    }

    let safeAnswer = typeof parsed.answer === "string" ? parsed.answer : "Done.";
    const opsFromNewSchema = Array.isArray(parsed.operations) ? parsed.operations : [];
    const legacyEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
    const mappedLegacyOps = legacyEdits.map((e) => ({
      action: "replace_in_file",
      path: e.file,
      find: e.find,
      replace: e.replace,
    }));
    let allOperations = [...opsFromNewSchema, ...mappedLegacyOps];

    if (allOperations.length === 0) {
      const fallback = deriveFallbackOperations(prompt);
      if (fallback) {
        safeAnswer = fallback.answer;
        allOperations = fallback.operations;
      }
    }

    const operationLog = applyOperations(allOperations, workspacePath);
    const parts = [safeAnswer];
    if (operationLog.length) parts.push("\n" + operationLog.join("\n"));

    const result = parts.filter(Boolean).join("\n");
    console.log(`[RESULT SENT] ${result}`);
    res.json({ result });
  });
});

resolveGhPath((err) => {
  if (err) {
    console.error(`[STARTUP ERROR] ${err.message}`);
    process.exit(1);
  }
  checkCopilotReady((readyErr) => {
    if (readyErr) {
      console.error(`[STARTUP ERROR] ${readyErr.message}`);
      process.exit(1);
    }
    app.listen(PORT, () => {
      console.log(`my-agent server running at http://localhost:${PORT}`);
    });
  });
});

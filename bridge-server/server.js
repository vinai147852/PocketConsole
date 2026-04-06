const http = require("http");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const websocketServer = new WebSocket.Server({ server, path: "/ws" });

const PORT = Number(process.env.PORT) || 8080;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const TASK_TTL_MS = Number(process.env.TASK_TTL_MS) || 1000 * 60 * 60;
const STATIC_DIR = path.join(__dirname, "public");

const agents = new Map();
const clients = new Map();
const tasks = new Map();
const queuedTaskIds = [];

app.use(cors({ origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(",").map((item) => item.trim()) }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(STATIC_DIR));

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function authenticateHttp(req, res, next) {
  if (!BRIDGE_API_KEY) {
    return next();
  }

  const provided = req.header("x-bridge-key") || req.query.key;
  if (provided !== BRIDGE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

function safeSend(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    prompt: task.prompt,
    result: task.result,
    error: task.error,
    clientId: task.clientId,
    targetAgentId: task.targetAgentId,
    assignedAgentId: task.assignedAgentId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

function notifyClient(task, eventType) {
  const message = {
    type: eventType,
    task: publicTask(task),
  };

  if (!task.clientId) {
    return;
  }

  const clientConnection = clients.get(task.clientId);
  if (clientConnection) {
    safeSend(clientConnection.socket, message);
  }
}

function pickAgent(targetAgentId) {
  if (targetAgentId) {
    const targeted = agents.get(targetAgentId);
    if (!targeted || !targeted.isReady) {
      return null;
    }
    return targeted;
  }

  const readyAgents = Array.from(agents.values())
    .filter((agent) => agent.isReady)
    .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt));

  return readyAgents[0] || null;
}

function dispatchTask(task) {
  const agent = pickAgent(task.targetAgentId);
  if (!agent) {
    task.status = task.targetAgentId ? "waiting-for-target-agent" : "queued";
    task.updatedAt = nowIso();
    if (!queuedTaskIds.includes(task.id)) {
      queuedTaskIds.push(task.id);
    }
    notifyClient(task, "task.queued");
    return false;
  }

  task.status = "assigned";
  task.assignedAgentId = agent.id;
  task.updatedAt = nowIso();
  agent.isReady = false;
  agent.currentTaskId = task.id;

  safeSend(agent.socket, {
    type: "task.assigned",
    task: publicTask(task),
  });

  notifyClient(task, "task.assigned");
  return true;
}

function flushQueue() {
  for (let index = 0; index < queuedTaskIds.length; ) {
    const taskId = queuedTaskIds[index];
    const task = tasks.get(taskId);

    if (!task || task.status === "completed" || task.status === "failed") {
      queuedTaskIds.splice(index, 1);
      continue;
    }

    if (dispatchTask(task)) {
      queuedTaskIds.splice(index, 1);
      continue;
    }

    index += 1;
  }
}

function createTask({ prompt, clientId, targetAgentId, metadata }) {
  const task = {
    id: generateId("task"),
    prompt,
    clientId: clientId || null,
    targetAgentId: targetAgentId || null,
    assignedAgentId: null,
    metadata: metadata || null,
    result: null,
    error: null,
    status: "received",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
  };

  tasks.set(task.id, task);
  dispatchTask(task);
  return task;
}

function completeTask({ taskId, result, error }) {
  const task = tasks.get(taskId);
  if (!task) {
    return false;
  }

  task.result = typeof result === "string" ? result : null;
  task.error = typeof error === "string" ? error : null;
  task.status = task.error ? "failed" : "completed";
  task.updatedAt = nowIso();
  task.completedAt = task.updatedAt;

  if (task.assignedAgentId) {
    const agent = agents.get(task.assignedAgentId);
    if (agent) {
      agent.isReady = true;
      agent.currentTaskId = null;
      agent.lastSeenAt = nowIso();
    }
  }

  notifyClient(task, task.error ? "task.failed" : "task.completed");
  flushQueue();
  return true;
}

function cleanupExpiredTasks() {
  const threshold = Date.now() - TASK_TTL_MS;
  for (const [taskId, task] of tasks.entries()) {
    if (Date.parse(task.updatedAt) < threshold) {
      tasks.delete(taskId);
      const queuedIndex = queuedTaskIds.indexOf(taskId);
      if (queuedIndex !== -1) {
        queuedTaskIds.splice(queuedIndex, 1);
      }
    }
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "bridge-server",
    agentsOnline: Array.from(agents.values()).filter((agent) => agent.socket.readyState === WebSocket.OPEN).length,
    queuedTasks: queuedTaskIds.length,
    totalTasks: tasks.size,
    timestamp: nowIso(),
  });
});

app.get("/api/agents", authenticateHttp, (req, res) => {
  res.json({
    agents: Array.from(agents.values()).map((agent) => ({
      id: agent.id,
      label: agent.label,
      isReady: agent.isReady,
      currentTaskId: agent.currentTaskId,
      lastSeenAt: agent.lastSeenAt,
    })),
  });
});

app.post("/api/tasks", authenticateHttp, (req, res) => {
  const prompt = typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  const clientId = typeof req.body.clientId === "string" ? req.body.clientId.trim() : "";
  const targetAgentId = typeof req.body.targetAgentId === "string" ? req.body.targetAgentId.trim() : "";

  if (!prompt) {
    return res.status(400).json({ error: "prompt is required" });
  }

  const task = createTask({
    prompt,
    clientId,
    targetAgentId,
    metadata: req.body.metadata || null,
  });

  return res.status(202).json({ task: publicTask(task) });
});

app.get("/api/tasks/:taskId", authenticateHttp, (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  return res.json({ task: publicTask(task) });
});

websocketServer.on("connection", (socket) => {
  let connectionId = null;
  let role = null;

  safeSend(socket, {
    type: "hello",
    message: "Connected to bridge server",
    requiresApiKey: Boolean(BRIDGE_API_KEY),
    timestamp: nowIso(),
  });

  socket.on("message", (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      safeSend(socket, { type: "error", error: "Invalid JSON message" });
      return;
    }

    if (BRIDGE_API_KEY && message.apiKey !== BRIDGE_API_KEY) {
      safeSend(socket, { type: "error", error: "Unauthorized" });
      socket.close();
      return;
    }

    if (message.type === "register.agent") {
      const agentId = (message.agentId || "").trim() || generateId("agent");
      role = "agent";
      connectionId = agentId;
      agents.set(agentId, {
        id: agentId,
        label: (message.label || "Local Agent").trim() || "Local Agent",
        socket,
        isReady: message.isReady !== false,
        currentTaskId: null,
        lastSeenAt: nowIso(),
      });
      safeSend(socket, { type: "registered.agent", agentId });
      flushQueue();
      return;
    }

    if (message.type === "register.client") {
      const clientId = (message.clientId || "").trim() || generateId("client");
      role = "client";
      connectionId = clientId;
      clients.set(clientId, {
        id: clientId,
        socket,
        lastSeenAt: nowIso(),
      });
      safeSend(socket, { type: "registered.client", clientId });
      return;
    }

    if (message.type === "agent.ready" && role === "agent" && connectionId) {
      const agent = agents.get(connectionId);
      if (agent) {
        agent.isReady = true;
        agent.lastSeenAt = nowIso();
        agent.currentTaskId = null;
        flushQueue();
      }
      return;
    }

    if (message.type === "task.create") {
      const prompt = typeof message.prompt === "string" ? message.prompt.trim() : "";
      if (!prompt) {
        safeSend(socket, { type: "error", error: "prompt is required" });
        return;
      }

      const task = createTask({
        prompt,
        clientId: role === "client" ? connectionId : message.clientId,
        targetAgentId: message.targetAgentId,
        metadata: message.metadata || null,
      });

      safeSend(socket, { type: "task.accepted", task: publicTask(task) });
      return;
    }

    if (message.type === "task.result" && role === "agent") {
      const didComplete = completeTask({
        taskId: message.taskId,
        result: message.result,
        error: message.error,
      });

      if (!didComplete) {
        safeSend(socket, { type: "error", error: "Unknown taskId" });
      }
      return;
    }

    if (message.type === "ping") {
      safeSend(socket, { type: "pong", timestamp: nowIso() });
      return;
    }

    safeSend(socket, { type: "error", error: `Unsupported message type: ${message.type}` });
  });

  socket.on("close", () => {
    if (role === "agent" && connectionId) {
      const agent = agents.get(connectionId);
      if (agent && agent.currentTaskId) {
        const task = tasks.get(agent.currentTaskId);
        if (task && task.status === "assigned") {
          task.status = "queued";
          task.assignedAgentId = null;
          task.updatedAt = nowIso();
          if (!queuedTaskIds.includes(task.id)) {
            queuedTaskIds.push(task.id);
          }
        }
      }
      agents.delete(connectionId);
      flushQueue();
    }

    if (role === "client" && connectionId) {
      clients.delete(connectionId);
    }
  });
});

setInterval(cleanupExpiredTasks, 60_000);

server.listen(PORT, () => {
  console.log(`bridge-server listening on http://localhost:${PORT}`);
});

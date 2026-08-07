const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ================= IN-MEMORY STATE =================
let switchState = "OFF"; // "ON" or "OFF"

const authCodes = new Map();
const accessTokens = new Set();

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function requireBearerToken(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !accessTokens.has(token)) {
    return res.status(401).json({ error: "invalid_token" });
  }
  next();
}

// GET / — dashboard
app.get("/", (req, res) => {
  const isOn = switchState === "ON";
  const html = `<!DOCTYPE html>
<html><head><title>Cloud Smart Switch</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:Arial;background:#f2f2f2;text-align:center;margin-top:60px;}
h1{color:#333;}
.status{font-size:28px;font-weight:bold;margin:20px 0;color:${isOn ? "#28a745" : "#dc3545"};}
button{padding:18px 50px;font-size:20px;border:none;border-radius:10px;cursor:pointer;color:white;background:${isOn ? "#dc3545" : "#28a745"};}
.card{display:inline-block;background:white;padding:40px;border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.1);}
</style></head><body>
<div class="card">
  <h1>Cloud Smart Switch</h1>
  <div class="status" id="status">State: ${switchState}</div>
  <button id="toggleBtn" onclick="toggleSwitch()">Turn ${isOn ? "OFF" : "ON"}</button>
</div>
<script>
async function toggleSwitch(){
  const res = await fetch('/toggle',{method:'POST'});
  const data = await res.json();
  updateUI(data.state);
}
function updateUI(state){
  document.getElementById('status').innerText = 'State: ' + state;
  const btn = document.getElementById('toggleBtn');
  btn.innerText = 'Turn ' + (state === 'ON' ? 'OFF' : 'ON');
  btn.style.background = state === 'ON' ? '#dc3545' : '#28a745';
  document.getElementById('status').style.color = state === 'ON' ? '#28a745' : '#dc3545';
}
setInterval(async () => {
  const res = await fetch('/status');
  const data = await res.json();
  updateUI(data.state);
}, 3000);
</script></body></html>`;
  res.send(html);
});

// GET /status
app.get("/status", (req, res) => {
  res.json({ state: switchState });
});

// POST /toggle
app.post("/toggle", (req, res) => {
  switchState = switchState === "ON" ? "OFF" : "ON";
  res.json({ state: switchState });
});

// POST /update  (from ESP32)
app.post("/update", (req, res) => {
  const { state } = req.body;
  if (state !== "ON" && state !== "OFF") {
    return res.status(400).json({ error: "state must be 'ON' or 'OFF'" });
  }
  switchState = state;
  res.json({ success: true, state: switchState });
});

// GET & POST /oauth/authorize
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
  const code = randomToken(16);
  authCodes.set(code, { redirect_uri, createdAt: Date.now() });
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

app.post("/oauth/authorize", (req, res) => {
  const { redirect_uri } = req.body;
  if (!redirect_uri) return res.status(400).json({ error: "redirect_uri required" });
  const code = randomToken(16);
  authCodes.set(code, { redirect_uri, createdAt: Date.now() });
  res.json({ code });
});

// POST /oauth/token
app.post("/oauth/token", (req, res) => {
  const { code, grant_type, refresh_token } = req.body;

  if (grant_type === "refresh_token") {
    const newToken = randomToken();
    accessTokens.add(newToken);
    return res.json({
      token_type: "Bearer",
      access_token: newToken,
      refresh_token: refresh_token || randomToken(),
      expires_in: 3600
    });
  }

  if (!code || !authCodes.has(code)) {
    return res.status(400).json({ error: "invalid_grant" });
  }

  authCodes.delete(code);
  const accessToken = randomToken();
  const refreshToken = randomToken();
  accessTokens.add(accessToken);

  res.json({
    token_type: "Bearer",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600
  });
});

// POST /google-fulfillment
app.post("/google-fulfillment", requireBearerToken, (req, res) => {
  const { requestId, inputs } = req.body;
  const intent = inputs && inputs[0] && inputs[0].intent;

  if (intent === "action.devices.SYNC") {
    return res.json({
      requestId,
      payload: {
        agentUserId: "cloud-smart-switch-user",
        devices: [{
          id: "switch-1",
          type: "action.devices.types.SWITCH",
          traits: ["action.devices.traits.OnOff"],
          name: { defaultNames: ["Cloud Smart Switch"], name: "Smart Switch", nicknames: ["My Switch"] },
          willReportState: false
        }]
      }
    });
  }

  if (intent === "action.devices.QUERY") {
    return res.json({
      requestId,
      payload: { devices: { "switch-1": { on: switchState === "ON", online: true } } }
    });
  }

  if (intent === "action.devices.EXECUTE") {
    const commands = inputs[0].payload.commands;
    const results = [];
    commands.forEach(cmd => {
      cmd.devices.forEach(device => {
        cmd.execution.forEach(exec => {
          if (exec.command === "action.devices.commands.OnOff") {
            switchState = exec.params.on ? "ON" : "OFF";
          }
        });
        results.push({ ids: [device.id], status: "SUCCESS", states: { on: switchState === "ON", online: true } });
      });
    });
    return res.json({ requestId, payload: { commands: results } });
  }

  res.status(400).json({ error: "Unsupported intent" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cloud Smart Switch server running on port ${PORT}`);
});

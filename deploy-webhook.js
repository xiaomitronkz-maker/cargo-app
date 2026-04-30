'use strict';

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.WEBHOOK_PORT || 9001;
const DEPLOY_PATH = process.env.DEPLOY_PATH || '/root/cargo-app';
const CLIENT_PATH = path.join(DEPLOY_PATH, 'client');
const PM2_APP_NAME = process.env.PM2_APP_NAME || 'cargo';

let deploying = false;

app.use(express.json({ limit: '1mb' }));

function log(message, details) {
  if (details) {
    console.log(`[deploy] ${message}`, details);
    return;
  }
  console.log(`[deploy] ${message}`);
}

function runStep(label, command, args, cwd) {
  return new Promise((resolve, reject) => {
    log(`${label} started`);

    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      console.error(`[deploy] ${label} failed to start`, error);
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[deploy] ${label} failed`, {
          code,
          stderr: stderr.trim(),
          stdout: stdout.trim(),
        });
        reject(new Error(`${label} failed with code ${code}`));
        return;
      }

      log(`${label} finished`);
      if (stdout.trim()) log(`${label} stdout`, stdout.trim());
      if (stderr.trim()) log(`${label} stderr`, stderr.trim());
      resolve();
    });
  });
}

async function deploy() {
  await runStep('git pull', 'git', ['pull', '--ff-only'], DEPLOY_PATH);
  await runStep('backend npm install', 'npm', ['install'], DEPLOY_PATH);
  await runStep('client npm install', 'npm', ['install'], CLIENT_PATH);
  await runStep('client build', 'npm', ['run', 'build'], CLIENT_PATH);
  await runStep('pm2 restart', 'pm2', ['restart', PM2_APP_NAME, '--update-env'], DEPLOY_PATH);
}

async function webhookHandler(req, res) {
  log('webhook received', {
    event: req.get('x-github-event') || 'manual',
    delivery: req.get('x-github-delivery') || null,
  });

  const event = req.get('x-github-event');
  if (event === 'ping') {
    return res.json({ ok: true, message: 'pong' });
  }
  if (event && event !== 'push') {
    return res.json({ ok: true, message: `ignored ${event}` });
  }

  if (deploying) {
    return res.status(409).json({ ok: false, error: 'Deployment already running' });
  }

  deploying = true;
  try {
    await deploy();
    res.json({ ok: true, message: 'deploy finished' });
  } catch (error) {
    console.error('[deploy] deploy failed', error);
    res.status(500).json({ ok: false, error: error.message });
  } finally {
    deploying = false;
  }
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'cargo-app deploy webhook' });
});

app.post('/webhook', webhookHandler);
app.post('/github-webhook', webhookHandler);

app.listen(PORT, '0.0.0.0', () => {
  log(`webhook server listening on http://0.0.0.0:${PORT}`);
  log(`deploy path: ${DEPLOY_PATH}`);
  log(`pm2 app: ${PM2_APP_NAME}`);
});

'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.WEBHOOK_PORT || 9000;
const APP_DIR = process.env.APP_DIR || __dirname;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

let deployRunning = false;

function log(message, details) {
  if (details) {
    console.log(`[deploy-webhook] ${message}`, details);
    return;
  }
  console.log(`[deploy-webhook] ${message}`);
}

function verifyGitHubSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) return false;
  if (!signature || !signature.startsWith('sha256=')) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')}`;

  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  return signatureBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

function runStep(label, command, args) {
  return new Promise((resolve, reject) => {
    log(`${label} started`);

    const child = spawn(command, args, { cwd: APP_DIR });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      console.error(`[deploy-webhook] ${label} failed to start:`, error);
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[deploy-webhook] ${label} failed`, {
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
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
  log('deploy started', { appDir: APP_DIR });
  await runStep('git pull', 'git', ['pull', '--ff-only']);
  await runStep('npm install', 'npm', ['install']);
  await runStep('client build', 'npm', ['run', 'build', '--prefix', 'client']);
  await runStep('pm2 restart', 'pm2', ['restart', 'cargo', '--update-env']);
  log('deploy finished');
}

function startDeployInBackground() {
  if (deployRunning) return false;

  deployRunning = true;
  setImmediate(() => {
    deploy()
      .catch((error) => {
        console.error('[deploy-webhook] deploy failed:', error);
      })
      .finally(() => {
        deployRunning = false;
      });
  });

  return true;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'cargo-deploy-webhook' });
});

app.post('/github-webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  log('webhook received', {
    event: req.get('x-github-event') || null,
    delivery: req.get('x-github-delivery') || null,
  });

  if (!WEBHOOK_SECRET) {
    console.error('[deploy-webhook] WEBHOOK_SECRET is not set');
    return res.status(500).json({ ok: false, error: 'WEBHOOK_SECRET is not configured' });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = req.get('x-hub-signature-256') || '';

  if (!verifyGitHubSignature(rawBody, signature)) {
    console.error('[deploy-webhook] invalid GitHub signature');
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  const event = req.get('x-github-event');
  if (event && event !== 'push') {
    return res.status(202).json({ ok: true, message: `ignored ${event}` });
  }

  if (deployRunning) {
    return res.status(202).json({ ok: true, message: 'deploy already running' });
  }

  startDeployInBackground();
  return res.status(202).json({ ok: true, message: 'deploy started' });
});

app.listen(PORT, '0.0.0.0', () => {
  log(`webhook started on http://0.0.0.0:${PORT}`);
  log('configuration', {
    appDir: APP_DIR,
    hasSecret: Boolean(WEBHOOK_SECRET),
  });
});

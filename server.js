import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import http from 'http';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createPatch, applyPatch, parsePatch } from 'diff';
import { exec as _exec } from 'child_process';
import util from 'util';

dotenv.config();
const exec = util.promisify(_exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Workspace root (all file ops limited to this directory)
const WORKSPACE_ROOT = path.join(__dirname, 'workspace');

// Ensure workspace exists
async function ensureWorkspace() {
  try {
    await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  } catch (err) {
    console.error('Failed to create workspace', err);
  }
}
await ensureWorkspace();

// Utility: resolve and ensure path stays within workspace
function resolveWorkspacePath(rel) {
  const target = path.normalize(rel || '');
  const resolved = path.resolve(WORKSPACE_ROOT, target);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Path outside workspace forbidden');
  }
  return resolved;
}

// Ensure git repo exists in workspace, initialize if not
async function ensureGitRepo() {
  const gitDir = path.join(WORKSPACE_ROOT, '.git');
  if (!existsSync(gitDir)) {
    try {
      await exec(`git init`, { cwd: WORKSPACE_ROOT });
      console.log('Initialized git repository in workspace');
    } catch (err) {
      console.warn('Failed to init git repo:', err.message);
    }
  }
}

// Simple git add + commit with provided message
async function gitCommit(paths, message) {
  try {
    await ensureGitRepo();
    if (paths && paths.length) {
      const escaped = paths.map(p => `"${p}"`).join(' ');
      await exec(`git add -- ${escaped}`, { cwd: WORKSPACE_ROOT });
    } else {
      await exec(`git add -A`, { cwd: WORKSPACE_ROOT });
    }
    const commitMsg = message ? message.replace(/"/g, '\\"') : 'Assistant applied changes';
    await exec(`git commit -m "${commitMsg}"`, { cwd: WORKSPACE_ROOT });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Get git log (simple)
async function gitLog(limit = 50) {
  await ensureGitRepo();
  // Format: hash|author|date|subject
  const cmd = `git log -n ${limit} --pretty=format:%H|%an|%ad|%s --date=iso`;
  const r = await exec(cmd, { cwd: WORKSPACE_ROOT });
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const [hash, author, date, ...subj] = line.split('|');
    return { hash, author, date, subject: subj.join('|') };
  });
}

// Revert a commit (creates a revert commit)
async function gitRevert(hash) {
  await ensureGitRepo();
  try {
    await exec(`git revert --no-edit ${hash}`, { cwd: WORKSPACE_ROOT });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ----------------- File API -----------------
app.get('/api/list', async (req, res) => {
  try {
    const rel = req.query.path || '.';
    const dir = resolveWorkspacePath(rel);
    const items = await fs.readdir(dir, { withFileTypes: true });
    const result = items.map((it) => ({
      name: it.name,
      path: path.join(rel, it.name).replace(/\\/g, '/'),
      isDirectory: it.isDirectory()
    }));
    res.json({ root: rel, items: result });
  } catch (err) {
    console.error('/api/list error', err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/read', async (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path query required' });
    const file = resolveWorkspacePath(rel);
    const stat = await fs.stat(file);
    if (stat.isDirectory()) return res.status(400).json({ error: 'path is directory' });
    const content = await fs.readFile(file, 'utf-8');
    res.json({ path: rel, content });
  } catch (err) {
    console.error('/api/read error', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/save', async (req, res) => {
  try {
    const { path: rel, content } = req.body;
    if (!rel) return res.status(400).json({ error: 'path required' });
    const file = resolveWorkspacePath(rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content || '', 'utf-8');
    res.json({ ok: true, path: rel });
  } catch (err) {
    console.error('/api/save error', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/create', async (req, res) => {
  try {
    const { path: rel, isDirectory = false } = req.body;
    if (!rel) return res.status(400).json({ error: 'path required' });
    const target = resolveWorkspacePath(rel);
    if (isDirectory) {
      await fs.mkdir(target, { recursive: true });
      return res.json({ ok: true, path: rel, isDirectory: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, '', { flag: 'wx' }).catch(async (err) => {
        if (err.code === 'EEXIST') {
          return;
        }
        throw err;
      });
      return res.json({ ok: true, path: rel, isDirectory: false });
    }
  } catch (err) {
    console.error('/api/create error', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const { path: rel } = req.body;
    if (!rel) return res.status(400).json({ error: 'path required' });
    const target = resolveWorkspacePath(rel);
    await fs.rm(target, { recursive: true, force: true });
    res.json({ ok: true, path: rel });
  } catch (err) {
    console.error('/api/delete error', err);
    res.status(400).json({ error: err.message });
  }
});

// ----------------- LLM helpers -----------------
async function callOpenAIChat({ messages, model = 'gpt-4o-mini', temperature = 0.2, max_tokens = 1024, stream = false }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set on server');
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = { model, messages, temperature, max_tokens };
  if (stream) body.stream = true;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }
  if (stream) {
    // return response readable stream
    return res;
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? JSON.stringify(json);
  return { raw: json, text: content };
}

async function callQwen({ prompt, model = 'qwen-coder', temperature = 0.2, max_tokens = 1024 }) {
  const qwenUrl = process.env.QWEN_URL;
  if (!qwenUrl) throw new Error('QWEN_URL not set on server');
  const body = { model, prompt, max_tokens, temperature };
  const res = await fetch(qwenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qwen server error ${res.status}: ${text}`);
  }
  const json = await res.json();
  const text = json.choices?.[0]?.text ?? json.choices?.[0]?.message?.content ?? json.output ?? JSON.stringify(json);
  return { raw: json, text };
}

// ----------------- JSON parsing & repair -----------------
function lightweightRepair(text) {
  let block = text;
  // remove triple backticks and optional json code fence
  block = block.replace(/```(?:json)?\n?/g, '').replace(/```$/g, '');
  // remove leading/trailing lines that are not part of JSON
  const first = block.indexOf('{');
  const last = block.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    block = block.slice(first, last + 1);
  }
  // remove trailing commas
  block = block.replace(/,\s*([}\]])/g, '$1');
  // attempt to balance braces
  const open = (block.match(/{/g) || []).length;
  const close = (block.match(/}/g) || []).length;
  if (open > close) block = block + '}'.repeat(open - close);
  return block;
}

function tryParseJSONBlock(text) {
  try {
    const repaired = lightweightRepair(text);
    return JSON.parse(repaired);
  } catch (err) {
    return null;
  }
}

async function repairJSONWithLLM(rawText, provider = 'openai', model) {
  // Ask the LLM to return only the corrected JSON object block
  const system = `You are a JSON repair assistant. The user gave an output that should contain a single JSON object. Return only the corrected JSON object, exactly one object, with valid JSON syntax. Do not include any explanation, backticks or other text.`;
  const user = `Here is the original output that failed to parse:\n\n${rawText}\n\nReturn just the corrected JSON object.`;
  if (provider === 'openai') {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const r = await callOpenAIChat({ messages, model, temperature: 0.0, max_tokens: 2048 });
    return r.text;
  } else if (provider === 'qwen') {
    const prompt = system + '\n\n' + user;
    const r = await callQwen({ prompt, model, temperature: 0.0, max_tokens: 2048 });
    return r.text;
  } else {
    throw new Error('unknown provider for repair');
  }
}

// ----------------- Diffs for preview & hunk helpers -----------------
async function getFileContentOrEmpty(relPath) {
  try {
    const resolved = resolveWorkspacePath(relPath);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || stat.isDirectory()) return '';
    const content = await fs.readFile(resolved, 'utf-8');
    return content;
  } catch {
    return '';
  }
}

function makeUnifiedDiff(pathLabel, oldStr, newStr) {
  return createPatch(pathLabel, oldStr || '', newStr || '', '', '');
}

// Split unified diff into hunks (array of {hunkText, header})
function splitDiffIntoHunks(unifiedDiff) {
  // Use parsePatch to extract hunks (from 'diff' lib)
  try {
    const patches = parsePatch(unifiedDiff);
    const hunks = [];
    for (const p of patches) {
      for (const h of p.hunks) {
        // build hunk text: header + h.lines joined
        const header = `@@ ${h.oldStart},${h.oldLines} ${h.newStart},${h.newLines} @@`;
        const lines = h.lines.join('\n');
        const full = `${header}\n${lines}\n`;
        hunks.push({ header, hunkText: full });
      }
    }
    return hunks;
  } catch (err) {
    // fallback: split on @@ markers
    const parts = unifiedDiff.split('\n@@').map((p, i) => (i === 0 ? p : '@@' + p));
    return parts.slice(1).map(p => ({ header: p.split('\n')[0], hunkText: p }));
  }
}

// Apply a unified patch that may contain only select hunks for a file
function applySelectedHunks(oldStr, originalUnifiedPatch, selectedHunkTexts) {
  // Build a new patch that includes only selected hunks; keep the file headers from originalUnifiedPatch
  const patches = parsePatch(originalUnifiedPatch);
  if (!patches || !patches.length) return { ok: false, error: 'could not parse original patch' };
  const p = patches[0];
  const patchHeader = `*** ${p.oldFileName}\n--- ${p.newFileName}\n`;
  const patchBody = selectedHunkTexts.join('\n');
  const newPatch = patchHeader + patchBody;
  try {
    const result = applyPatch(oldStr, newPatch);
    if (result === false) return { ok: false, error: 'applyPatch returned false' };
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ----------------- Assistant: preview (no apply) -----------------
app.post('/assistant', async (req, res) => {
  try {
    const { message, provider = 'openai', model, temperature = 0.2, max_tokens = 1024, repairOnFail = true } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const system = `You are a local coding assistant with direct file access. When the user gives an instruction, you must:
1) Produce a JSON "actions" array describing file operations to perform. Each action must be an object with:
   - "action": one of "create", "edit", "delete"
   - "path": relative path inside the workspace (like "src/foo.js")
   - For "create" and "edit" include "content" (string). For "create" optionally include "isDirectory": true.
2) Also produce a human-readable "assistant_text" explaining what you did or will do.
3) Output must contain a single JSON object block (no other surrounding text) so the server can parse it.
Example:
{
  "actions": [
    { "action": "create", "path": "src/newfile.js", "content": "// sample code" },
    { "action": "edit", "path": "src/existing.js", "content": "modified content" }
  ],
  "assistant_text": "I created src/newfile.js and updated src/existing.js to fix X."
}
Only reference files inside the workspace. Do not attempt to access system paths. If the user's intent is only a review or explanation, you may return actions: [] and include just assistant_text with suggested code snippets.`;

    let modelResult;
    if (provider === 'openai') {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: message }
      ];
      modelResult = await callOpenAIChat({ messages, model, temperature, max_tokens });
    } else if (provider === 'qwen') {
      const prompt = `${system}\n\nUser:\n${message}\n\nReturn:`;
      modelResult = await callQwen({ prompt, model, temperature, max_tokens });
    } else {
      return res.status(400).json({ error: `Unknown provider ${provider}` });
    }

    const rawText = modelResult.text;

    // Parse JSON block
    let parsed = tryParseJSONBlock(rawText);
    if (!parsed && repairOnFail) {
      // Attempt to repair with a follow-up LLM call
      try {
        const repairText = await repairJSONWithLLM(rawText, provider, model);
        parsed = tryParseJSONBlock(repairText);
        if (parsed) {
          if (!parsed.assistant_text) parsed.assistant_text = repairText;
        }
      } catch (err) {
        console.warn('Repair LLM failed', err.message);
      }
    }

    if (!parsed) {
      return res.json({
        provider,
        assistant_text: rawText,
        raw_model_text: rawText,
        actions: [],
        diffs: []
      });
    }

    // Build diffs for each action (without applying)
    const diffs = [];
    for (const act of parsed.actions || []) {
      try {
        if (!act || !act.action || !act.path) {
          diffs.push({ action: act, ok: false, error: 'invalid action object' });
          continue;
        }
        if (act.action === 'delete') {
          const before = await getFileContentOrEmpty(act.path);
          const diff = makeUnifiedDiff(act.path, before, '');
          const hunks = splitDiffIntoHunks(diff);
          diffs.push({ action: act, ok: true, diff, hunks });
        } else if (act.action === 'create') {
          const before = await getFileContentOrEmpty(act.path);
          const after = act.isDirectory ? '' : (act.content ?? '');
          const diff = makeUnifiedDiff(act.path, before, after);
          const hunks = splitDiffIntoHunks(diff);
          diffs.push({ action: act, ok: true, diff, hunks });
        } else if (act.action === 'edit') {
          const before = await getFileContentOrEmpty(act.path);
          const after = act.content ?? '';
          const diff = makeUnifiedDiff(act.path, before, after);
          const hunks = splitDiffIntoHunks(diff);
          diffs.push({ action: act, ok: true, diff, hunks });
        } else {
          diffs.push({ action: act, ok: false, error: 'unknown action type' });
        }
      } catch (err) {
        diffs.push({ action: act, ok: false, error: err.message });
      }
    }

    res.json({
      provider,
      assistant_text: parsed.assistant_text ?? rawText,
      raw_model_text: rawText,
      actions: parsed.actions ?? [],
      diffs
    });
  } catch (err) {
    console.error('/assistant error', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------- SSE Streaming assistant_text -----------------
app.get('/assistant/stream', async (req, res) => {
  // expects query params: message, provider (optional), model (optional)
  try {
    const message = req.query.message;
    const provider = req.query.provider || 'openai';
    const model = req.query.model;
    if (!message) return res.status(400).send('message query required');

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders();

    if (provider === 'openai') {
      // Build messages
      const system = `You are a helpful coding assistant. Be concise and include code blocks when returning code.`;
      const messages = [{ role: 'system', content: system }, { role: 'user', content: message }];

      // call OpenAI with stream=true and proxy the SSE style chunks to client
      const resp = await callOpenAIChat({ messages, model, temperature: 0.2, max_tokens: 2048, stream: true });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');

      async function pump() {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const parts = chunk.split(/\n\n/);
          for (const part of parts) {
            if (!part.trim()) continue;
            res.write(`data: ${part.replace(/\n/g, '\\n')}\n\n`);
          }
        }
        res.write('event: done\ndata: \n\n');
        res.end();
      }
      pump().catch(err => {
        console.error('stream pump error', err);
        try { res.write('event: error\ndata: ' + err.message + '\n\n'); res.end(); } catch {}
      });
    } else {
      // Qwen streaming may not be available; fall back to generating full response and sending it once
      const prompt = message;
      const r = await callQwen({ prompt, model, temperature: 0.2, max_tokens: 2048 });
      res.write(`data: ${r.text.replace(/\n/g, '\\n')}\n\n`);
      res.write('event: done\ndata: \n\n');
      res.end();
    }
  } catch (err) {
    console.error('/assistant/stream error', err);
    try { res.write('event: error\ndata: ' + (err.message || 'error') + '\n\n'); res.end(); } catch {}
  }
});

// ----------------- Apply selected actions (writes + git commit + per-hunk apply) -----------------
app.post('/assistant/apply', async (req, res) => {
  try {
    // actions: array where each action may have `selectedHunks`: array of hunkText strings to apply (optional)
    const { actions = [], commitMessage = 'Assistant applied changes' } = req.body || {};
    if (!Array.isArray(actions)) return res.status(400).json({ error: 'actions must be array' });

    const actionsApplied = [];
    const pathsTouched = [];

    for (const act of actions) {
      try {
        if (!act || !act.action || !act.path) {
          actionsApplied.push({ ok: false, action: act, error: 'invalid action object' });
          continue;
        }
        const relPath = act.path;
        const resolved = resolveWorkspacePath(relPath);
        if (act.action === 'create') {
          if (act.isDirectory) {
            await fs.mkdir(resolved, { recursive: true });
            actionsApplied.push({ ok: true, action: 'create', path: relPath, isDirectory: true });
          } else {
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, act.content ?? '', 'utf-8');
            pathsTouched.push(relPath);
            actionsApplied.push({ ok: true, action: 'create', path: relPath });
          }
        } else if (act.action === 'edit') {
          // support per-hunk patching if act.originalDiff and act.selectedHunks provided
          if (Array.isArray(act.selectedHunks) && act.selectedHunks.length) {
            const before = await getFileContentOrEmpty(relPath);
            const applyRes = applySelectedHunks(before, act.originalDiff || '', act.selectedHunks);
            if (applyRes.ok) {
              await fs.writeFile(resolved, applyRes.result, 'utf-8');
              pathsTouched.push(relPath);
              actionsApplied.push({ ok: true, action: 'edit', path: relPath, hunksApplied: act.selectedHunks.length });
            } else {
              actionsApplied.push({ ok: false, action: act, error: applyRes.error });
            }
          } else {
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, act.content ?? '', 'utf-8');
            pathsTouched.push(relPath);
            actionsApplied.push({ ok: true, action: 'edit', path: relPath });
          }
        } else if (act.action === 'delete') {
          await fs.rm(resolved, { recursive: true, force: true });
          pathsTouched.push(relPath);
          actionsApplied.push({ ok: true, action: 'delete', path: relPath });
        } else {
          actionsApplied.push({ ok: false, action: act, error: 'unknown action type' });
        }
      } catch (err) {
        actionsApplied.push({ ok: false, action: act, error: err.message });
      }
    }

    // Git commit touched files
    let gitResult = null;
    try {
      gitResult = await gitCommit(pathsTouched, commitMessage);
    } catch (err) {
      gitResult = { ok: false, error: err.message };
    }

    // Read back changed files contents
    const changedFiles = {};
    for (const a of actionsApplied.filter(x => x.ok && (x.action === 'create' || x.action === 'edit'))) {
      try {
        const content = await fs.readFile(resolveWorkspacePath(a.path), 'utf-8');
        changedFiles[a.path] = content;
      } catch (err) {
        changedFiles[a.path] = `<<failed to read: ${err.message}>>`;
      }
    }

    res.json({
      ok: true,
      actionsApplied,
      gitResult,
      changedFiles
    });
  } catch (err) {
    console.error('/assistant/apply error', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------- Git endpoints -----------------
app.get('/git/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const logs = await gitLog(limit);
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/git/revert', async (req, res) => {
  try {
    const { hash } = req.body || {};
    if (!hash) return res.status(400).json({ ok: false, error: 'hash required' });
    const r = await gitRevert(hash);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT} (workspace: ${WORKSPACE_ROOT})`));
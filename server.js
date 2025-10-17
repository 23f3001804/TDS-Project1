// server.js
const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));

// Configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AIPIPE_API_KEY = process.env.AIPIPE_API_KEY;
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai';
const SECRET_KEY = process.env.SECRET_KEY || 'default-secret-key';
const PORT = process.env.PORT || 3000;

// Initialize GitHub client
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Store task states (use DB in production)
const taskStates = new Map();

// Helper: Verify secret (safe version)
function verifySecret(providedSecret) {
  if (!providedSecret || !SECRET_KEY) return false;

  // Trim spaces/newlines just in case (Render can preserve them)
  const input = Buffer.from(providedSecret.trim());
  const secret = Buffer.from(SECRET_KEY.trim());

  // Prevent crash if lengths differ
  if (input.length !== secret.length) return false;

  try {
    return crypto.timingSafeEqual(input, secret);
  } catch {
    return false;
  }
}


// Helper: Parse attachments
function parseAttachments(attachments) {
  if (!attachments || !Array.isArray(attachments)) return [];
  return attachments.map(att => {
    if (att.type === 'image' && att.data) {
      return {
        type: 'image',
        filename: att.filename || 'image.png',
        data: att.data,
        description: att.description || ''
      };
    } else if (att.type === 'text' && att.content) {
      return {
        type: 'text',
        filename: att.filename || 'document.txt',
        content: att.content,
        description: att.description || ''
      };
    }
    return null;
  }).filter(Boolean);
}

// Helper: Build prompt
function buildPrompt(brief, attachments, round = 1, existingCode = null) {
  let prompt = '';
  if (round === 1) {
    prompt = `Create a fully functional single-page web app based on this brief:\n\n${brief}\n\n`;
    if (attachments?.length) {
      prompt += `Additional Requirements:\n`;
      attachments.forEach((att, idx) => {
        if (att.type === 'image')
          prompt += `\n${idx + 1}. Image: ${att.filename} - ${att.description}`;
        else if (att.type === 'text')
          prompt += `\n${idx + 1}. From ${att.filename}:\n${att.content}\n`;
      });
    }
    prompt += `\nProvide ONLY the HTML code with inline CSS and JS.`;
  } else {
    prompt = `You are updating this web app:\n\n${existingCode}\n\nUpdate brief:\n${brief}\n\nReturn full updated HTML.`;
  }
  return prompt;
}

// Helper: Call LLM API
async function callLLM(prompt) {
  try {
    if (LLM_PROVIDER === 'anthropic') {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }]
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );
      return response.data.content[0].text;
    } else if (LLM_PROVIDER === 'aipipe') {
      const response = await axios.post(
        'https://aipipe.org/openrouter/v1/chat/completions',
        {
          model: 'openai/gpt-4.1-nano',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert web developer. Generate complete HTML apps with inline CSS and JS. Return ONLY HTML code.'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 8192
        },
        {
          headers: {
            'Authorization': `Bearer ${AIPIPE_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.choices?.[0]?.message?.content || response.data.output_text || '';
    } else {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4-turbo-preview',
          messages: [
            {
              role: 'system',
              content:
                'You are an expert web developer. Generate complete HTML apps with inline CSS and JS. Return ONLY HTML code.'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 8192
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.choices[0].message.content;
    }
  } catch (error) {
    console.error('LLM API Error:', error.response?.data || error.message);
    throw new Error(`LLM API failed: ${error.message}`);
  }
}

// Helper: Extract clean HTML
function extractHTML(llmResponse) {
  let html = llmResponse.trim();
  const htmlMatch = html.match(/```html\s*\n([\s\S]*?)\n```/);
  if (htmlMatch) html = htmlMatch[1];
  else if (html.includes('```')) {
    const codeMatch = html.match(/```\s*\n([\s\S]*?)\n```/);
    if (codeMatch) html = codeMatch[1];
  }

  html = html.trim();
  if (!html.toLowerCase().startsWith('<!doctype') && !html.toLowerCase().startsWith('<html')) {
    html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Generated App</title></head><body>${html}</body></html>`;
  }
  return html;
}

// Helper: Create or update GitHub repo
async function createGitHubRepo(repoName, htmlContent, brief, round = 1) {
  try {
    let repo, sha = null;
    if (round === 1) {
      repo = await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        description: `Auto-generated app: ${brief.substring(0, 100)}`,
        private: false
      });
    } else {
      repo = await octokit.repos.get({ owner: GITHUB_USERNAME, repo: repoName });
      try {
        const { data: file } = await octokit.repos.getContent({
          owner: GITHUB_USERNAME,
          repo: repoName,
          path: 'index.html'
        });
        sha = file.sha;
      } catch {}
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_USERNAME,
      repo: repoName,
      path: 'index.html',
      message: round === 1 ? 'Initial commit' : `Update round ${round}`,
      content: Buffer.from(htmlContent).toString('base64'),
      ...(sha && { sha })
    });

    return { repoUrl: repo.data.html_url, repoName };
  } catch (error) {
    console.error('GitHub error:', error.response?.data || error.message);
    throw new Error(`GitHub operation failed: ${error.message}`);
  }
}

// Helper: Enable GitHub Pages
async function enableGitHubPages(repoName) {
  try {
    await octokit.repos.createPagesSite({
      owner: GITHUB_USERNAME,
      repo: repoName,
      source: { branch: 'main', path: '/' }
    });
  } catch (error) {
    if (error.status !== 409) console.error('GitHub Pages error:', error.message);
  }
  return `https://${GITHUB_USERNAME}.github.io/${repoName}`;
}

// Helper: Send evaluation POST
async function sendEvaluation(url, payload) {
  try {
    await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    console.log('✓ Evaluation API notified');
  } catch {
    console.log('⚠ Evaluation API notification failed');
  }
}

// 📦 API Endpoint
app.post('/api-endpoint', async (req, res) => {
  const startTime = Date.now();
  try {
    const { secret, task_id, brief, attachments, evaluation_url, round = 1, repo_name } = req.body;
    if (!secret || !verifySecret(secret))
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing secret' });
    if (!task_id || !brief || !evaluation_url)
      return res.status(400).json({ error: 'Bad Request', message: 'Missing required fields' });

    res.status(202).json({ message: 'Task accepted', task_id, round });

    (async () => {
      try {
        const parsedAttachments = parseAttachments(attachments);
        const taskState = taskStates.get(task_id) || {};
        const repoName = repo_name || taskState.repoName || `app-${task_id}-${Date.now()}`;

        const prompt = buildPrompt(brief, parsedAttachments, round, taskState.lastCode || null);

        const llmResponse = await callLLM(prompt);
        const htmlContent = extractHTML(llmResponse);

        const { repoUrl } = await createGitHubRepo(repoName, htmlContent, brief, round);
        const deploymentUrl = await enableGitHubPages(repoName);

        taskStates.set(task_id, {
          task_id,
          repoName,
          repoUrl,
          deploymentUrl,
          round,
          status: 'completed',
          updatedAt: new Date().toISOString()
        });

        await sendEvaluation(evaluation_url, {
          task_id,
          round,
          status: 'completed',
          repo_url: repoUrl,
          deployment_url: deploymentUrl,
          processing_time_ms: Date.now() - startTime,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error(`❌ Task ${task_id} failed:`, error.message);
        taskStates.set(task_id, { task_id, status: 'failed', error: error.message });
        await sendEvaluation(evaluation_url, {
          task_id,
          round,
          status: 'failed',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    })();
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// 🧾 Get task status
app.get('/task/:id', (req, res) => {
  const task = taskStates.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not Found', message: 'Task not found or not started yet' });
  res.json(task);
});

// 🌐 Root
app.get('/', (req, res) => {
  res.send(`<h2>Project 1 TDS</h2><p>Welcome!</p><ul><li><a href="/health">Check Health</a></li><li>POST /api-endpoint</li></ul>`);
});

// 🩺 Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    llm_provider: LLM_PROVIDER,
    github_username: GITHUB_USERNAME,
    timestamp: new Date().toISOString()
  });
});

// 🚀 Start Server
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Student API Server Started');
  console.log('='.repeat(60));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🤖 LLM Provider: ${LLM_PROVIDER.toUpperCase()}`);
  console.log(`👤 GitHub User: ${GITHUB_USERNAME}`);
  console.log('='.repeat(60) + '\n');
});

module.exports = app;

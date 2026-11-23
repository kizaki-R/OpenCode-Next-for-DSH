#!/usr/bin/env node

import { ModelCatalog } from '../lib/catalog.js';
import { TokenManager } from '../lib/token-manager.js';
import { OpenCodeOAuthAdapter } from '../lib/adapter.js';

async function smoke() {
  console.log('=== dsh-opencode-oauth Smoke Test ===\n');

  // 1. Check Auth
  console.log('1. Checking OAuth credential...');
  const tokenManager = new TokenManager();
  let token = null;
  try {
    token = await tokenManager.getValidToken();
    const cached = tokenManager.getCached();
    console.log(`   ✔ Found valid token from [${cached?.source}] (${token.length} chars).`);
  } catch (err) {
    console.error(`   ✖ Auth check failed: ${err.message}`);
    process.exit(1);
  }

  // 2. Check Catalog
  console.log('2. Syncing model catalog...');
  const catalog = new ModelCatalog();
  const models = await catalog.init();
  console.log(`   ✔ Discovered ${models.length} active free models.`);

  // 3. Test Inference Stream
  const testModel = process.argv[2] || 'deepseek-v4.1-flash-free';
  console.log(`3. Testing live inference stream with "${testModel}"...`);

  const adapter = new OpenCodeOAuthAdapter(catalog, tokenManager);
  const t0 = Date.now();
  let reasoning = '';
  let content = '';

  try {
    const stream = adapter.stream({
      model: testModel,
      messages: [{ role: 'user', content: 'Say "DSH_OAUTH_ONLINE" in one word.' }],
      // reasoning 模型會先吐思考，32 個 token 會被吃光、內容留白。留足額度，
      // 否則這個測試會「通過」但其實什麼都沒驗到。
      maxTokens: 512
    });

    for await (const chunk of stream) {
      if (chunk.type === 'reasoning-delta') {
        reasoning += chunk.text;
      } else if (chunk.type === 'text-delta') {
        content += chunk.text;
      }
    }

    console.log(`   ✔ Stream completed in ${Date.now() - t0}ms.`);
    if (reasoning) {
      console.log(`   • Reasoning: ${reasoning.trim().slice(0, 80)}...`);
    }
    console.log(`   • Output: ${content.trim()}`);

    // 串流結束才算通過還不夠 —— 空輸出代表連線雖然活著，管線卻是壞的。
    if (content.trim() === '') {
      console.error('   ✖ Stream completed but produced no text (reasoning may have consumed the budget)');
      process.exit(1);
    }
    console.log('\n\x1b[32m✔ Smoke test passed successfully!\x1b[0m');
  } catch (err) {
    console.error(`   ✖ Inference test failed: ${err.message}`);
    process.exit(1);
  }
}

smoke();

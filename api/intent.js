export const config = {
  runtime: 'edge', 
};

/**
 * 辅助函数：延迟等待
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 辅助函数：带重试机制的 Fetch
 */
async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }
      if (i === maxRetries) return res;
      await sleep(1000 * (i + 1)); 
    } catch (e) {
      lastError = e;
      if (e.name === 'AbortError') throw e;
      if (i === maxRetries) throw e; 
      await sleep(1000 * (i + 1));
    }
  }
}

/**
 * Serper Search API
 */
async function fetchSerperSearch(query, apiKey) {
  if (!query || !apiKey) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); 

    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: query,
        num: 10,      
        gl: "us",     
        hl: "en"      
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.organic || []; 
  } catch (error) {
    console.error("Serper Search Error:", error);
    return null;
  }
}

/**
 * Jina Reader API (Content Scraping)
 * [已更新] 增加了 API Key 支持，提升抓取稳定性
 */
async function fetchJinaContent(url, apiKey = null) {
  if (!url) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); 

    const headers = { "X-Return-Format": "markdown" };
    // 如果有 Key，则添加鉴权头
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`https://r.jina.ai/${url}`, {
      method: "GET",
      headers: headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;
    
    const text = await response.text();
    const MAX_CHARS = 35000; 
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n\n...(truncated)" : text;
  } catch (error) {
    return null; 
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  // 修改点：只接收 keyword
  const { keyword } = body;
  const apiKey = process.env.GEMINI_API_KEY;
  const baseUrl = process.env.GEMINI_BASE_URL;
  // 注意：这里建议在环境变量中配置一套新的 SEARCH_INTENT_PROMPT
  // 如果没有，可以使用默认的通用分析提示词
  const systemPrompt = process.env.SEARCH_INTENT_PROMPT || "You are a Search Intent Analysis Expert. Analyze the provided search results to determine user intent, content gaps, and SEO strategy.";
  const serperKey = process.env.SERPER_API_KEY;
  const jinaKey = process.env.JINA_API_KEY; // [新增] 获取 Jina Key
  const modelName = process.env.AI_MODEL_NAME || "gemini-2.0-flash-exp";

  if (!apiKey || !baseUrl) {
      return new Response(JSON.stringify({ error: "Missing AI Config" }), { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendStatus = (text) => {
        const chunk = {
          id: 'status-update',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        };
        try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        } catch (e) { console.error(e); }
      };

      try {
        if (!keyword) {
             sendStatus(`> ❌ **错误：未提供关键词，分析无法开始。**\n\n`);
             controller.close();
             return;
        }

        // --- 阶段一：搜索 ---
        sendStatus(`> 🔍 **正在分析 Google (US) 搜索结果：** "${keyword}"...\n\n`);

        let searchContext = "";
        let searchResults = [];

        if (serperKey) {
            searchResults = await fetchSerperSearch(keyword, serperKey);
        } else {
             sendStatus(`> ⚠️ **未配置搜索 API，仅能进行理论分析...**\n\n`);
        }

        if (searchResults && searchResults.length > 0) {
            sendStatus(`> 📖 **捕获 Top ${searchResults.length} 排名页面，正在全网并行抓取内容...**\n\n`);
            
            // 并行抓取前 5-8 个结果即可，避免 token 消耗过大且影响速度，Top 结果通常最具代表性
            const topResults = searchResults.slice(0, 8); 
            
            const contentPromises = topResults.map(async (res) => {
                // [已更新] 传入 jinaKey
                const markdown = await fetchJinaContent(res.link, jinaKey);
                return {
                    title: res.title,
                    link: res.link,
                    snippet: res.snippet,
                    content: markdown || res.snippet 
                };
            });

            const fetchedResults = await Promise.allSettled(contentPromises);

            const references = fetchedResults.map((p, index) => {
                if (p.status === 'fulfilled') {
                    const res = p.value;
                    return `[Result #${index + 1}]\nTitle: ${res.title}\nURL: ${res.link}\nSnippet: ${res.snippet}\nFull Content (Excerpt): ${res.content.slice(0, 2000)}\n`; // 限制每个结果的上下文长度
                }
                return null;
            }).filter(Boolean).join("\n\n====================\n\n");

            searchContext = `以下是该关键词在 Google (US) 首页的实际排名结果及内容：\n${references}`;
            sendStatus(`> ✅ **数据采集完成，AI 正在构建意图分析模型...**\n\n---\n\n`);
        } else {
            searchContext = "（未获取到实时搜索结果，请基于您的知识库进行通用分析）";
            sendStatus(`> ⚠️ **未获取到实时数据，将进行通用理论分析...**\n\n---\n\n`);
        }

        // --- 阶段二：构建 Prompt ---
        const userMessage = `
作为搜索意图分析专家，请根据以下数据分析关键词 "${keyword}" 的用户意图。

【实时 SERP 数据】:
${searchContext}

请输出一份详细的意图分析报告，包含以下部分（请使用 Markdown 格式）：

1.  **意图核心 (The "Why")**: 
    - 用户搜索这个词的根本目的是什么？(Do, Know, Go, Buy)
    - 显性需求 vs 隐性需求。
2.  **SERP 特征分析**: 
    - Google 在首页展示了什么类型的内容（视频、列表、指南、工具、产品页）？这意味着 Google 认为用户想要什么形式的答案？
3.  **受众画像**:
    - 搜索者的专业程度（小白 vs 专家）。
    - 处于购买漏斗的哪个阶段？
4.  **内容竞争格局**:
    - 当前排名靠前的页面有哪些共同点？
    - 它们的优点和缺点是什么？
5.  **差异化机会 (The "Gap")**:
    - 如果要在这个词上获得排名，我们需要提供什么独特的价值或内容角度，是当前 Top 10 结果没有覆盖到的？
        `.trim();

        const payload = {
            model: modelName,
            max_tokens: 8000, 
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
            stream: true
        };

        // --- 阶段三：AI ---
        const aiController = new AbortController();
        const timeoutId = setTimeout(() => aiController.abort(), 120000); // 2分钟超时

        const upstreamResponse = await fetchWithRetry(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload),
            signal: aiController.signal 
        });

        clearTimeout(timeoutId);

        if (!upstreamResponse.ok) {
            const errText = await upstreamResponse.text();
            sendStatus(`\n\n❌ **AI Error**: ${upstreamResponse.status}\n${errText}`);
            controller.close();
            return;
        }

        const reader = upstreamResponse.body.getReader();
        let readPromise = reader.read();

        while (true) {
            // 心跳保活逻辑
            let timerId;
            const keepAlivePromise = new Promise((_, reject) => {
                timerId = setTimeout(() => reject(new Error('KEEP_ALIVE')), 15000);
            });

            try {
                const result = await Promise.race([readPromise, keepAlivePromise]);
                clearTimeout(timerId);

                const { done, value } = result;
                if (done) break;

                controller.enqueue(value);
                readPromise = reader.read();

            } catch (error) {
                if (error.message === 'KEEP_ALIVE') {
                    controller.enqueue(encoder.encode(`: keep-alive\n\n`));
                    continue;
                }
                throw error;
            }
        }
        
      } catch (error) {
        console.error(error);
        sendStatus(`\n\n❌ **System Error**: ${error.message}`);
      } finally {
        try { controller.close(); } catch(e) {}
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

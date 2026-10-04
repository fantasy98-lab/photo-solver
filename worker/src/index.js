import Anthropic from "@anthropic-ai/sdk";

// 使うモデル
const MODEL = "claude-sonnet-5-5";

// Claude APIが受け付ける画像形式
const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// 受け付けるbase64文字列の最大長（約5MBの画像に相当）
const MAX_BASE64_LENGTH = 7_000_000;

// Claudeに守らせる回答の形（JSON Schema）
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    readable: {
      type: "boolean",
      description: "画像から問題を読み取れたら true、読み取れなければ false",
    },
    unreadable_reason: {
      type: "string",
      description: "readable が false のときの理由（ぼやけている、切れている等）。true のときは空文字",
    },
    question: { type: "string", description: "読み取った問題文" },
    choices: {
      type: "array",
      description: "すべての選択肢（選択肢がない問題なら空配列）",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "選択肢の記号（ア、1、A など）" },
          text: { type: "string", description: "選択肢の本文" },
          is_correct: { type: "boolean", description: "正解なら true" },
          explanation: { type: "string", description: "この選択肢が正しい／誤りである理由" },
        },
        required: ["label", "text", "is_correct", "explanation"],
        additionalProperties: false,
      },
    },
    correct_answer: { type: "string", description: "正解（記号と本文）" },
    overall_explanation: { type: "string", description: "問題全体の解説" },
  },
  required: ["readable", "unreadable_reason", "question", "choices", "correct_answer", "overall_explanation"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `あなたは試験問題の解説者です。画像に写った問題を読み取り、日本語で回答してください。
- 問題文を正確に書き起こし、正解を示し、すべての選択肢について正誤の理由を解説してください。
- 画像がぼやけている・暗い・一部が切れている等で問題文や選択肢を確実に読み取れない場合は、推測で答えず readable を false にし、unreadable_reason に理由と撮り直しのコツを書いてください。その場合、他の項目は空文字・空配列にしてください。`;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    // ブラウザが本番リクエストの前に送る「事前確認（preflight）」への応答
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return json({ error: "POSTのみ受け付けます" }, 405, cors);
    }

    // リクエスト本文（JSON）を読む
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSONの形式が正しくありません" }, 400, cors);
    }

    const { password, image } = body ?? {};

    // 合言葉のチェック
    if (typeof password !== "string" || !env.APP_PASSWORD || !(await safeEqual(password, env.APP_PASSWORD))) {
      return json({ error: "合言葉が違います" }, 401, cors);
    }

    // 画像のチェック
    const parsed = parseImage(image, body.mediaType);
    if (parsed.error) {
      return json({ error: parsed.error }, 400, cors);
    }

    // Claude APIを呼び出す
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: {
          format: { type: "json_schema", schema: ANSWER_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
              },
              { type: "text", text: "この画像の問題を解いて、指定の形式で答えてください。" },
            ],
          },
        ],
      });

      if (response.stop_reason === "refusal") {
        return json({ error: "この画像には回答できませんでした" }, 422, cors);
      }
      if (response.stop_reason === "max_tokens") {
        return json({ error: "回答が長すぎて途中で切れました" }, 502, cors);
      }

      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock) {
        return json({ error: "回答を受け取れませんでした" }, 502, cors);
      }
      return json(JSON.parse(textBlock.text), 200, cors);
    } catch (err) {
      // 詳細はサーバー側のログにだけ残し、利用者には一般的なメッセージを返す
      console.error(err);
      if (err instanceof Anthropic.RateLimitError) {
        return json({ error: "混み合っています。少し待ってからお試しください" }, 429, cors);
      }
      if (err instanceof Anthropic.APIError) {
        return json({ error: "AIの呼び出しに失敗しました" }, 502, cors);
      }
      return json({ error: "サーバーでエラーが起きました" }, 500, cors);
    }
  },
};

// CORSヘッダーを作る。ALLOWED_ORIGIN が "*" なら全許可、URLならそのURLだけ許可
function corsHeaders(request, env) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && allowed.split(",").map((s) => s.trim()).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// base64画像を検証し、"data:image/png;base64,..." 形式なら中身と形式を取り出す
function parseImage(image, mediaTypeHint) {
  if (typeof image !== "string" || image.length === 0) {
    return { error: "画像がありません" };
  }
  let data = image;
  let mediaType = mediaTypeHint || "image/jpeg";
  const match = image.match(/^data:([^;]+);base64,(.*)$/s);
  if (match) {
    mediaType = match[1];
    data = match[2];
  }
  data = data.replace(/\s/g, "");
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    return { error: "対応していない画像形式です（JPEG/PNG/GIF/WebPのみ）" };
  }
  if (data.length > MAX_BASE64_LENGTH) {
    return { error: "画像が大きすぎます（5MBまで）" };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return { error: "画像データが正しいbase64ではありません" };
  }
  return { data, mediaType };
}

// 文字列を「かかる時間が一定」になるように比較する（合言葉の推測対策）
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

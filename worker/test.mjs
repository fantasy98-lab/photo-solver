// 本番Workerの動作確認スクリプト
// 使い方: node test.mjs <WorkerのURL> <画像ファイル>
// 合言葉は実行後に入力します（画面には表示されません）

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const [url, imagePath] = process.argv.slice(2);
if (!url || !imagePath) {
  console.error("使い方: node test.mjs <WorkerのURL> <画像ファイル>");
  process.exit(1);
}

const MEDIA_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()];
if (!mediaType) {
  console.error("対応形式: .jpg .jpeg .png .gif .webp");
  process.exit(1);
}

// 入力文字を画面に出さずに1行読む
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (ch === "\u0003") {
        process.exit(130); // Ctrl+C
      } else if (ch === "\u007f") {
        input = input.slice(0, -1); // Backspace
      } else {
        input += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const password = await askHidden("合言葉: ");
const image = (await readFile(imagePath)).toString("base64");

console.log("送信中…（数十秒かかることがあります）");
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password, image, mediaType }),
});

console.log(`ステータス: ${res.status}`);
const text = await res.text();
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}

require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// สำหรับ Render health check
app.get("/", (req, res) => {
  res.status(200).send("discord-webhook-reader is running");
});

// เผื่ออยากเช็กสถานะเพิ่ม
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// เปิด port ให้ Render เห็น
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function detectProductType(text) {
  const raw = text.toLowerCase();

  if (
    raw.includes("(steam offline)") ||
    raw.includes("(epic offline)") ||
    raw.includes("(บัญชีแชร์)")
  ) {
    return "GAME_OFFLINE";
  }

  if (raw.trim()) {
    return "ONLINE_ACCOUNT";
  }

  return "OTHER";
}

function parseProductInfo(text) {
  const originalText = normalizeEmbedText(text);
  let productName = originalText;
  let price = null;
  const productType = detectProductType(originalText);

  const priceMatch = productName.match(/\(([\d,]+(?:\.\d+)?)\s*บาท\)/);
  if (priceMatch) {
    price = Number(priceMatch[1].replace(/,/g, ""));
    productName = productName
      .replace(/\s*\(([\d,]+(?:\.\d+)?)\s*บาท\)\s*$/, "")
      .trim();
  }

  productName = productName
    .replace(/\s*\((Steam|Epic)\s+Offline\)\s*/gi, " ")
    .trim();

  if (productName.includes(" - ")) {
    productName = productName.split(" - ")[0].trim();
  }

  return {
    productName,
    price,
    productType,
  };
}

function parseBuyer(text) {
  text = normalizeEmbedText(text);
  const match = text.match(/^(.+?)\s*\(/);
  if (match) {
    return match[1].trim();
  }

  return text.trim();
}

async function sendToNextjs(payload) {
  return sendToApi(process.env.NEXTJS_API_URL, payload);
}

// ลองใหม่เมื่อ network error / timeout / 5xx (เช่น Vercel cold start หรือ DB หลุดชั่วคราว)
// shortcut: timeout ที่ปลายทางบันทึกไปแล้วอาจได้รายการซ้ำ เพราะ API ยังไม่มี idempotency key
async function sendToApi(url, payload, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.IMPORT_API_KEY,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });

      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (!res.ok) {
        const error = new Error(
          `Next.js API error: ${res.status} ${res.statusText} - ${JSON.stringify(data)}`
        );
        error.retryable = res.status >= 500;
        throw error;
      }

      return data;
    } catch (error) {
      const retryable = error.retryable ?? true; // network error / timeout
      if (!retryable || attempt >= attempts) throw error;
      console.warn(`⚠️ ส่ง API ไม่สำเร็จ (ครั้งที่ ${attempt}) จะลองใหม่:`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
}

function normalizeEmbedText(text) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .trim();
}

function parseOutOfStockProductName(text) {
  let productName = normalizeEmbedText(text);

  // Remove the option and price, but keep the platform marker (Steam Offline).
  productName = productName
    .replace(/\s*\(\d+(?:\.\d+)?\s*บาท\)\s*$/i, "")
    .trim();

  if (productName.includes(" - ")) {
    productName = productName.split(" - ")[0].trim();
  }

  return productName;
}

async function sendStockAlert(message, productText) {
  const productName = parseOutOfStockProductName(productText);
  if (!productName) {
    console.log("พบแจ้งเตือนสินค้าหมด แต่ไม่สามารถอ่านชื่อสินค้าได้");
    return;
  }

  const alertsApiUrl =
    process.env.STOCK_ALERTS_API_URL ||
    new URL("/api/stock-alerts", process.env.NEXTJS_API_URL).toString();

  const apiResult = await sendToApi(alertsApiUrl, {
    productName,
    sourceMessageId: message.id,
    source: "discord-webhook",
  });

  console.log(`แจ้งสินค้าหมดเข้าเว็บสำเร็จ: ${productName}`, apiResult);
}

async function handleOutOfStockContent(message) {
  const lines = String(message.content || "")
    .split(/\r?\n/)
    .map(normalizeEmbedText)
    .filter(Boolean);

  if (!lines.some((line) => line.includes("สินค้าหมดแล้ว"))) return false;

  const productHeadingIndex = lines.findIndex((line) =>
    line.includes("ข้อมูลสินค้า"),
  );
  const productText =
    productHeadingIndex >= 0 ? lines[productHeadingIndex + 1] : null;

  if (!productText) {
    console.log("พบแจ้งเตือนสินค้าหมด แต่ไม่พบข้อมูลสินค้า");
    return true;
  }

  await sendStockAlert(message, productText);
  return true;
}

async function handleOutOfStockEmbed(message, embed) {
  const hasOutOfStockTitle = [embed.title, embed.description].some((text) =>
    normalizeEmbedText(text).includes("สินค้าหมดแล้ว"),
  );
  if (!hasOutOfStockTitle) return false;

  const fields = embed.fields ?? [];
  const productField = fields.find((field) =>
    normalizeEmbedText(field.name).includes("ข้อมูลสินค้า"),
  );

  const descriptionLines = String(embed.description || "")
    .split(/\r?\n/)
    .map(normalizeEmbedText)
    .filter(Boolean);
  const descriptionHeadingIndex = descriptionLines.findIndex((line) =>
    line.includes("ข้อมูลสินค้า"),
  );
  const descriptionProduct =
    descriptionHeadingIndex >= 0
      ? descriptionLines[descriptionHeadingIndex + 1]
      : null;

  if (!productField && !descriptionProduct) {
    console.log("พบแจ้งเตือนสินค้าหมด แต่ไม่พบข้อมูลสินค้า");
    return true;
  }

  await sendStockAlert(message, productField?.value || descriptionProduct);
  return true;
}

client.once("ready", () => {
  console.log(`✅ บอทออนไลน์แล้ว: ${client.user.tag}`);
});

async function handlePurchaseEmbed(message, embed) {
  const fields = embed.fields ?? [];

  // ซื้อพร้อมกันหลายชิ้น อาจมาเป็นหลาย field "ข้อมูลสินค้า" ใน embed เดียว
  // หรือหลายบรรทัดใน field เดียว เดิมใช้ find() จึงจดแค่ชิ้นแรก
  const productFields = fields.filter(
    (f) => f.name && f.name.includes("ข้อมูลสินค้า")
  );

  const buyerField = fields.find(
    (f) => f.name && f.name.includes("ผู้ซื้อ")
  );

  if (productFields.length === 0 || !buyerField) {
    console.log(
      "⚠️ เจอหัวข้อซื้อสินค้า แต่ไม่พบ field ที่ต้องการ:",
      JSON.stringify(fields)
    );
    return;
  }

  const buyerName = parseBuyer(buyerField.value || "");
  const productTexts = productFields.flatMap((field) =>
    splitProductLines(field.value || "")
  );

  if (productTexts.length > 1) {
    console.log(`🛒 พบสินค้า ${productTexts.length} ชิ้นในข้อความเดียว`);
  }

  for (const productText of productTexts) {
    await sendPurchase(message, embed, buyerName, productText);
  }
}

// แยกหลายสินค้าใน field เดียว: แยกเฉพาะเมื่อทุกบรรทัดมีราคา "(xx บาท)" ไม่งั้นถือเป็นสินค้าเดียว
function splitProductLines(value) {
  const lines = String(value)
    .split(/\r?\n/)
    .map(normalizeEmbedText)
    .filter(Boolean);
  const allPriced = lines.every((line) => /\([\d,]+(?:\.\d+)?\s*บาท\)/.test(line));
  return lines.length > 1 && allPriced ? lines : [value];
}

async function sendPurchase(message, embed, buyerName, productText) {
  const productParsed = parseProductInfo(productText);

  const result = {
    title: embed.title,
    productName: productParsed.productName,
    price: productParsed.price,
    productType: productParsed.productType,
    buyerName,
    soldAt: message.createdAt
      ? message.createdAt.toISOString()
      : new Date().toISOString(),
    source: "discord-webhook",
  };

  console.log("\n==============================");
  console.log("✅ พบรายการซื้อสินค้า");
  console.log("==============================");
  console.log(result);

  try {
    const apiResult = await sendToNextjs(result);
    console.log("🚀 ส่งเข้า Next.js สำเร็จ:", apiResult);
  } catch (error) {
    // log payload ไว้ให้จดเองได้ เพราะรายการนี้ไม่ได้เข้าเว็บ
    console.error("❌ จดรายการขายไม่สำเร็จ ต้องเพิ่มเอง:", JSON.stringify(result), error);
  }
}

client.on("messageCreate", async (message) => {
  if (
    process.env.TARGET_CHANNEL_ID &&
    message.channelId !== process.env.TARGET_CHANNEL_ID
  ) {
    return;
  }

  if (!message.webhookId) return;

  // แจ้งสินค้าหมดแยกจากการจดรายการขาย: ข้อความเดียวกันอาจมีทั้งสองอย่าง (ซื้อชิ้นสุดท้าย)
  try {
    await handleOutOfStockContent(message);
  } catch (error) {
    console.error("❌ ส่งแจ้งสินค้าหมดไม่สำเร็จ:", error);
  }

  for (const embed of message.embeds ?? []) {
    if (normalizeEmbedText(embed.title).includes("พบการซื้อสินค้า")) {
      await handlePurchaseEmbed(message, embed);
    }

    try {
      await handleOutOfStockEmbed(message, embed);
    } catch (error) {
      console.error("❌ ส่งแจ้งสินค้าหมดไม่สำเร็จ:", error);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
